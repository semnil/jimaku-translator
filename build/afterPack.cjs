// afterPack hook:
// - Win32: embed icon into exe via rcedit (signAndEditExecutable: false
//   skips both signing AND icon embedding, so we apply the icon ourselves)
// - macOS: fix ElectronAsarIntegrity in Info.plist (electron-builder computes
//   the hash before the asar is finalized, causing a mismatch)
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const BLOCK_SIZE = 4 * 1024 * 1024; // 4MB — Electron's default block size

// Mach-O magic numbers
const MH_MAGIC_64 = 0xFEEDFACF;
const MH_CIGAM_64 = 0xCFFAEDFE;
const MH_MAGIC_32 = 0xFEEDFACE;
const MH_CIGAM_32 = 0xCEFAEDFE;
const FAT_MAGIC = 0xCAFEBABE;
const FAT_MAGIC_64 = 0xCAFEBABF;
const LC_UUID = 0x1B;

function rewriteMachoUuid(binPath) {
  const fd = fs.openSync(binPath, 'r+');
  try {
    const sniff = Buffer.alloc(8);
    fs.readSync(fd, sniff, 0, 8, 0);
    const magic = sniff.readUInt32BE(0);

    const slices = [];
    if (magic === FAT_MAGIC || magic === FAT_MAGIC_64) {
      const fat64 = magic === FAT_MAGIC_64;
      const nfat = sniff.readUInt32BE(4);
      const archSize = fat64 ? 32 : 20;
      const archBuf = Buffer.alloc(nfat * archSize);
      fs.readSync(fd, archBuf, 0, nfat * archSize, 8);
      for (let i = 0; i < nfat; i++) {
        const base = i * archSize;
        const off = fat64
          ? Number(archBuf.readBigUInt64BE(base + 8))
          : archBuf.readUInt32BE(base + 8);
        slices.push(off);
      }
    } else {
      slices.push(0);
    }

    for (const sliceOff of slices) {
      const mh = Buffer.alloc(32);
      fs.readSync(fd, mh, 0, 32, sliceOff);
      const m = mh.readUInt32LE(0);
      let is64, isLE;
      if (m === MH_MAGIC_64) { is64 = true; isLE = true; }
      else if (m === MH_CIGAM_64) { is64 = true; isLE = false; }
      else if (m === MH_MAGIC_32) { is64 = false; isLE = true; }
      else if (m === MH_CIGAM_32) { is64 = false; isLE = false; }
      else throw new Error(`Unknown Mach-O magic 0x${m.toString(16)} at offset ${sliceOff}`);

      const u32 = (buf, o) => isLE ? buf.readUInt32LE(o) : buf.readUInt32BE(o);
      const ncmds = u32(mh, 16);
      const sizeofcmds = u32(mh, 20);
      const headerSize = is64 ? 32 : 28;

      const cmds = Buffer.alloc(sizeofcmds);
      fs.readSync(fd, cmds, 0, sizeofcmds, sliceOff + headerSize);

      let cursor = 0;
      let found = false;
      for (let i = 0; i < ncmds; i++) {
        const cmd = u32(cmds, cursor);
        const cmdsize = u32(cmds, cursor + 4);
        if (cmd === LC_UUID) {
          const newUuid = crypto.randomBytes(16);
          fs.writeSync(fd, newUuid, 0, 16, sliceOff + headerSize + cursor + 8);
          found = true;
          break;
        }
        cursor += cmdsize;
      }
      if (!found) throw new Error(`LC_UUID not found at slice offset ${sliceOff}`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = async function (context) {
  if (context.electronPlatformName === 'win32') {
    const rcedit = require('rcedit');
    const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
    const icoPath = path.resolve(__dirname, 'icon.ico');
    const pkg = require('../package.json');
    const version = pkg.version;
    const productName = context.packager.appInfo.productName;
    const companyName = pkg.author || 'semnil';
    const copyright = `Copyright (C) ${new Date().getFullYear()} ${companyName}`;
    console.log(`[afterPack] Setting icon and version info on ${exePath}`);
    await rcedit(exePath, {
      icon: icoPath,
      'file-version': version,
      'product-version': version,
      'version-string': {
        CompanyName: companyName,
        FileDescription: productName,
        ProductName: productName,
        OriginalFilename: `${productName}.exe`,
        InternalName: productName,
        LegalCopyright: copyright,
      },
    });
    return;
  }

  if (context.electronPlatformName === 'darwin') {
    const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    const plistPath = path.join(appPath, 'Contents', 'Info.plist');
    const asarPath = path.join(appPath, 'Contents', 'Resources', 'app.asar');
    const mainExe = path.join(appPath, 'Contents', 'MacOS', context.packager.appInfo.productFilename);

    // Rewrite LC_UUID in the main Mach-O executable so this app has a unique
    // identity distinct from every other Electron-based .app on the system.
    // Required for macOS Sequoia Local Network permission: UserEventAgent keys
    // the permission decision on LC_UUID, and Electron's prebuilt binary ships
    // with a UUID shared across all apps of the same Electron version, causing
    // all such apps to collapse under "com.github.Electron" and the per-app
    // permission dialog to never fire. Runs BEFORE electron-builder signs, so
    // the signature is recomputed over the patched bytes automatically.
    rewriteMachoUuid(mainExe);
    const { execFileSync: exec } = require('child_process');
    const uuidAfter = exec('/usr/bin/dwarfdump', ['--uuid', mainExe]).toString().trim();
    console.log(`[afterPack] Rewrote LC_UUID: ${uuidAfter}`);

    const pb = (cmd) => execFileSync('/usr/libexec/PlistBuddy', ['-c', cmd, plistPath]);

    if (!fs.existsSync(asarPath)) {
      // No asar — remove integrity dict entirely
      try {
        pb('Delete :ElectronAsarIntegrity');
        console.log('[afterPack] Removed ElectronAsarIntegrity (asar disabled)');
      } catch { /* no entry */ }
      return;
    }

    // Compute full integrity: hash + blockSize + blocks
    const data = fs.readFileSync(asarPath);
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    const blocks = [];
    for (let i = 0; i < data.length; i += BLOCK_SIZE) {
      const block = data.subarray(i, Math.min(i + BLOCK_SIZE, data.length));
      blocks.push(crypto.createHash('sha256').update(block).digest('hex'));
    }

    // Remove existing entry and rebuild from scratch
    try { pb('Delete :ElectronAsarIntegrity'); } catch { /* no entry */ }

    pb('Add :ElectronAsarIntegrity dict');
    pb('Add :ElectronAsarIntegrity:Resources/app.asar dict');
    pb('Add :ElectronAsarIntegrity:Resources/app.asar:algorithm string SHA256');
    pb(`Add :ElectronAsarIntegrity:Resources/app.asar:hash string ${hash}`);
    pb(`Add :ElectronAsarIntegrity:Resources/app.asar:blockSize integer ${BLOCK_SIZE}`);
    pb('Add :ElectronAsarIntegrity:Resources/app.asar:blocks array');
    for (const b of blocks) {
      pb(`Add :ElectronAsarIntegrity:Resources/app.asar:blocks: string ${b}`);
    }

    console.log(`[afterPack] Set asar integrity: hash=${hash.substring(0, 16)}..., ${blocks.length} blocks`);
  }
};
