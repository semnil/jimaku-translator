#!/usr/bin/env node
// Sign, notarize, and staple the DMG produced by electron-builder.
// electron-builder notarizes the .app inside but leaves the DMG container
// unsigned and without a ticket, so do it ourselves.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const pkg = require('../package.json');

const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
  console.error('[notarize-dmg] Missing APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID');
  process.exit(1);
}

const distDir = path.resolve(__dirname, '..', 'dist');
const dmgs = fs.readdirSync(distDir)
  .filter(f => f.includes(pkg.version) && f.endsWith('.dmg'))
  .map(f => path.join(distDir, f));
if (dmgs.length === 0) {
  console.error(`[notarize-dmg] No DMG found in ${distDir}`);
  process.exit(1);
}

const identity = `Developer ID Application: Tetsuya Shinone (${APPLE_TEAM_ID})`;
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });

for (const dmg of dmgs) {
  console.log(`[notarize-dmg] Processing ${path.basename(dmg)}`);
  run('codesign', ['--sign', identity, '--timestamp', '--force', dmg]);
  run('xcrun', [
    'notarytool', 'submit', dmg,
    '--apple-id', APPLE_ID,
    '--password', APPLE_APP_SPECIFIC_PASSWORD,
    '--team-id', APPLE_TEAM_ID,
    '--wait',
  ]);
  run('xcrun', ['stapler', 'staple', dmg]);
  run('spctl', ['-a', '-vv', '-t', 'install', dmg]);
}
