'use strict';

const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, '..', 'dist');
if (!fs.existsSync(distDir)) {
  process.exit(0);
}

const removableDirs = new Set(['mac-arm64', 'mac', 'win-unpacked', '.icon-icns', '.icon-ico']);
const removablePatterns = [/\.(dmg|exe|zip|blockmap|yml|yaml)$/i, /^builder-/i];

let removed = 0;
for (const entry of fs.readdirSync(distDir, { withFileTypes: true })) {
  const target = path.join(distDir, entry.name);
  if (entry.isDirectory() && removableDirs.has(entry.name)) {
    fs.rmSync(target, { recursive: true, force: true });
    removed += 1;
  } else if (entry.isFile() && removablePatterns.some(re => re.test(entry.name))) {
    fs.rmSync(target, { force: true });
    removed += 1;
  }
}

if (removed > 0) {
  console.log(`[clean-dist] removed ${removed} stale artifact(s) from dist/`);
}
