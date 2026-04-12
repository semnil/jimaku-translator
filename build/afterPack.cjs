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
