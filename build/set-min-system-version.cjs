// Injects minimumSystemVersion into the generated macOS auto-update metadata
// (dist/latest-mac.yml). electron-updater reads this field and refuses to
// update a host whose os.release() is below it. The value is a Darwin kernel
// version (Darwin 22 = macOS 13, the bundled Electron's minimum macOS), because
// electron-updater compares it against os.release(), not the macOS product
// version. Runs after electron-builder --mac; electron-builder itself does not
// write this field into latest-mac.yml.
const fs = require('fs');
const path = require('path');

const MIN_DARWIN_VERSION = '22.0.0';

function inject(contents) {
  if (/^minimumSystemVersion:/m.test(contents)) return contents;
  return `minimumSystemVersion: ${MIN_DARWIN_VERSION}\n${contents}`;
}

function main([arg]) {
  const ymlPath = arg || path.join(__dirname, '..', 'dist', 'latest-mac.yml');
  if (!fs.existsSync(ymlPath)) {
    process.stderr.write(`latest-mac.yml not found at ${ymlPath}; run after electron-builder --mac\n`);
    process.exitCode = 1;
    return;
  }
  const original = fs.readFileSync(ymlPath, 'utf8');
  const updated = inject(original);
  if (updated === original) {
    process.stdout.write(`minimumSystemVersion already present in ${path.basename(ymlPath)}\n`);
    return;
  }
  fs.writeFileSync(ymlPath, updated);
  process.stdout.write(`set minimumSystemVersion: ${MIN_DARWIN_VERSION} in ${path.basename(ymlPath)}\n`);
}

main(process.argv.slice(2));
