// Rewrites the sha512 and size of every .dmg entry under `files` in the macOS
// auto-update metadata (dist/latest-mac.yml) from the .dmg next to it. Runs
// after notarize-dmg.cjs, which signs and staples the DMG after electron-builder
// has written latest-mac.yml. Other entries are left as they are.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function refresh(contents, dir) {
  const lines = contents.split('\n');
  let refreshed = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^  - url: (.+\.dmg)$/);
    if (!m) continue;
    const dmgPath = path.join(dir, m[1]);
    if (!fs.existsSync(dmgPath)) throw new Error(`${m[1]} not found in ${dir}`);
    const data = fs.readFileSync(dmgPath);
    const sha512 = crypto.createHash('sha512').update(data).digest('base64');
    let sawSha512 = false;
    let sawSize = false;
    for (let j = i + 1; j < lines.length && lines[j].startsWith('    '); j++) {
      if (lines[j].startsWith('    sha512: ')) {
        lines[j] = `    sha512: ${sha512}`;
        sawSha512 = true;
      } else if (lines[j].startsWith('    size: ')) {
        lines[j] = `    size: ${data.length}`;
        sawSize = true;
      }
    }
    if (!sawSha512 || !sawSize) throw new Error(`the ${m[1]} entry has no sha512 or size`);
    refreshed++;
  }
  if (refreshed === 0) throw new Error('no .dmg entry under files');
  return { contents: lines.join('\n'), refreshed };
}

function main([arg]) {
  const ymlPath = arg || path.join(__dirname, '..', 'dist', 'latest-mac.yml');
  if (!fs.existsSync(ymlPath)) {
    process.stderr.write(`latest-mac.yml not found at ${ymlPath}; run after electron-builder --mac\n`);
    process.exitCode = 1;
    return;
  }
  try {
    const { contents, refreshed } = refresh(fs.readFileSync(ymlPath, 'utf8'), path.dirname(ymlPath));
    fs.writeFileSync(ymlPath, contents);
    process.stdout.write(`refreshed sha512 and size of ${refreshed} dmg entr${refreshed === 1 ? 'y' : 'ies'} in ${path.basename(ymlPath)}\n`);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  }
}

main(process.argv.slice(2));
