import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../build/set-min-system-version.cjs', import.meta.url));

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[]): Result {
  const res = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const SAMPLE_YML = [
  'version: 1.0.11',
  'files:',
  '  - url: Jimaku Translator-1.0.11-arm64-mac.zip',
  '    sha512: Zm9vYmFy==',
  '    size: 123456',
  'path: Jimaku Translator-1.0.11-arm64-mac.zip',
  'sha512: Zm9vYmFy==',
  "releaseDate: '2026-10-23T00:00:00.000Z'",
  '',
].join('\n');

function tmpYml(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-minsys-'));
  const p = path.join(dir, 'latest-mac.yml');
  fs.writeFileSync(p, contents);
  return p;
}

// electron-updater compares os.release() (a Darwin version) with semver.lt against
// minimumSystemVersion, so this test encodes that comparison rather than only the
// literal string.
function lt(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

describe('set-min-system-version', () => {
  it('injects a top-level minimumSystemVersion', () => {
    const p = tmpYml(SAMPLE_YML);
    const res = run([p]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('set minimumSystemVersion');
    const out = fs.readFileSync(p, 'utf8');
    expect(out).toMatch(/^minimumSystemVersion: \S+$/m);
    // the original payload is preserved
    expect(out).toContain('version: 1.0.11');
    expect(out).toContain('sha512: Zm9vYmFy==');
  });

  it('pins the value to the Darwin version of macOS 13, rejecting macOS 12', () => {
    const p = tmpYml(SAMPLE_YML);
    run([p]);
    const out = fs.readFileSync(p, 'utf8');
    const value = out.match(/^minimumSystemVersion:\s*(\S+)$/m)?.[1];
    expect(value).toBe('22.0.0');
    // macOS 12 Monterey (Darwin 21.x) is below the floor -> update refused
    expect(lt('21.6.0', value!)).toBe(true);
    // macOS 13 Ventura (Darwin 22.0.0) and later are allowed
    expect(lt('22.0.0', value!)).toBe(false);
    expect(lt('24.6.0', value!)).toBe(false);
  });

  it('is idempotent (leaves an existing minimumSystemVersion untouched)', () => {
    const p = tmpYml(SAMPLE_YML);
    run([p]);
    const first = fs.readFileSync(p, 'utf8');
    const res = run([p]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('already present');
    expect(fs.readFileSync(p, 'utf8')).toBe(first);
  });

  it('fails when the yml is missing', () => {
    const res = run([path.join(os.tmpdir(), 'jt-does-not-exist', 'latest-mac.yml')]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('not found');
  });
});
