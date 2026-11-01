import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../build/refresh-dmg-update-info.cjs', import.meta.url));

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[]): Result {
  const res = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const ZIP = 'jimaku-translator-1.0.11-arm64.zip';
const DMG = 'jimaku-translator-1.0.11-arm64.dmg';

// The layout electron-builder writes, with the dmg entry describing the DMG before it was signed and stapled.
const SAMPLE_YML = [
  'minimumSystemVersion: 22.0.0',
  'version: 1.0.11',
  'files:',
  `  - url: ${ZIP}`,
  '    sha512: emlwLXNoYTUxMg==',
  '    size: 111',
  `  - url: ${DMG}`,
  '    sha512: b2xkLWRtZy1zaGE1MTI=',
  '    size: 222',
  "releaseDate: '2026-10-23T00:00:00.000Z'",
  '',
].join('\n');

function tmpDist(yml: string, dmg: Buffer | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-dmginfo-'));
  fs.writeFileSync(path.join(dir, 'latest-mac.yml'), yml);
  if (dmg) fs.writeFileSync(path.join(dir, DMG), dmg);
  return path.join(dir, 'latest-mac.yml');
}

const dmgBytes = Buffer.from('signed and stapled dmg');
const dmgSha512 = crypto.createHash('sha512').update(dmgBytes).digest('base64');

describe('refresh-dmg-update-info', () => {
  it('rewrites the sha512 and size of the dmg entry from the file', () => {
    const p = tmpDist(SAMPLE_YML, dmgBytes);
    const res = run([p]);
    expect(res.status).toBe(0);
    const expected = SAMPLE_YML
      .replace('    sha512: b2xkLWRtZy1zaGE1MTI=', `    sha512: ${dmgSha512}`)
      .replace('    size: 222', `    size: ${dmgBytes.length}`);
    expect(fs.readFileSync(p, 'utf8')).toBe(expected);
  });

  it('is idempotent', () => {
    const p = tmpDist(SAMPLE_YML, dmgBytes);
    run([p]);
    const first = fs.readFileSync(p, 'utf8');
    const res = run([p]);
    expect(res.status).toBe(0);
    expect(fs.readFileSync(p, 'utf8')).toBe(first);
  });

  it('fails and leaves the yml untouched when the dmg is missing', () => {
    const p = tmpDist(SAMPLE_YML, null);
    const res = run([p]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`${DMG} not found`);
    expect(fs.readFileSync(p, 'utf8')).toBe(SAMPLE_YML);
  });

  it('fails when the yml has no dmg entry', () => {
    const yml = SAMPLE_YML.split('\n').filter((l) => !l.includes(DMG) && !l.includes('b2xkLWRtZy1zaGE1MTI=') && l !== '    size: 222').join('\n');
    const p = tmpDist(yml, dmgBytes);
    const res = run([p]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('no .dmg entry');
  });

  it('fails when the dmg entry has no size', () => {
    const p = tmpDist(SAMPLE_YML.replace('    size: 222\n', ''), dmgBytes);
    const res = run([p]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('has no sha512 or size');
  });

  it('fails when the yml is missing', () => {
    const res = run([path.join(os.tmpdir(), 'jt-does-not-exist', 'latest-mac.yml')]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('not found');
  });
});
