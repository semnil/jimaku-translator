import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../build/release-tag.cjs', import.meta.url));

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

function releaseTag(args: string[], cwd?: string, env?: NodeJS.ProcessEnv): Result {
  const res = spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe('release-tag shape', () => {
  it.each([
    ['v1.0.10', 'false'],
    ['v0.0.0', 'false'],
    ['v1.1.0-alpha', 'true'],
    ['v1.1.0-beta.1', 'true'],
    ['v1.1.0-rc1', 'true'],
    ['v1.1.0-rc.1.2', 'true'],
  ])('accepts %s with prerelease=%s', (tag, prerelease) => {
    const res = releaseTag(['shape', tag]);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(`${prerelease}\n`);
    expect(res.stderr).toBe('');
  });

  it.each([
    '1.0.10',
    'v1.0',
    'v1.0.0.0',
    'v1.0.0-foo',
    'v1.0.0-beta-1',
    'v1.0.0+build',
    'v1.0.0-beta..1',
    'v1.0.0-beta.',
    'v1.0.0 ',
    'v١.0.0',
    'main',
  ])('declines %j with status 3 and nothing on stdout', (tag) => {
    const res = releaseTag(['shape', tag]);
    expect(res.status).toBe(3);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('is not a release tag');
  });

  it.each([
    [[]],
    [['shape']],
    [['shape', '']],
    [['shape', 'v1.0.0', 'extra']],
    [['tag', 'v1.0.0']],
  ])('exits 2 for the arguments %j', (args) => {
    const res = releaseTag(args);
    expect(res.status).toBe(2);
    expect(res.stdout).toBe('');
  });
});

describe('release-tag plan', () => {
  let repo: string;
  let env: NodeJS.ProcessEnv;
  const commits: Record<string, string> = {};

  function git(...args: string[]): string {
    return execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
  }

  function commit(name: string, files: Record<string, string>): void {
    for (const [file, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(repo, file), content);
    }
    git('add', '--', ...Object.keys(files));
    git('commit', '--quiet', '-m', name);
    commits[name] = git('rev-parse', 'HEAD');
  }

  function pkg(version?: string): Record<string, string> {
    return { 'package.json': JSON.stringify(version === undefined ? { name: 'x' } : { name: 'x', version }) };
  }

  function plan(sha: string): Result {
    return releaseTag(['plan', sha], repo, env);
  }

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'jimaku-release-tag-'));
    const emptyConfig = path.join(repo, '..', `${path.basename(repo)}.gitconfig`);
    fs.writeFileSync(emptyConfig, '');
    env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: emptyConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    };
    git('init', '--quiet', '-b', 'main');
    commit('root', pkg('1.0.0'));
    commit('unrelated', { 'README.md': 'x' });
    commit('bump', pkg('1.0.1'));
    commit('prerelease', pkg('1.1.0-rc.1'));
    commit('declined', pkg('1.1.0-foo'));
    commit('downgrade', pkg('1.0.1'));
    commit('no-version', pkg());
    commit('after-no-version', pkg('1.2.0'));
    commit('empty-version', pkg(''));
    commit('after-empty-version', pkg('1.2.0'));

    // A merge whose first parent is main's previous tip and whose second parent bumped the version.
    git('checkout', '--quiet', '-b', 'feature');
    commit('feature-bump', pkg('1.3.0'));
    git('checkout', '--quiet', 'main');
    commit('main-side', { 'README.md': 'y' });
    git('merge', '--quiet', '--no-ff', '-m', 'merge', 'feature');
    commits.merge = git('rev-parse', 'HEAD');

    git('checkout', '--quiet', '--orphan', 'orphan');
    git('rm', '--quiet', '-r', '--cached', '.');
    commit('orphan-root', { 'README.md': 'z' });
    commit('orphan-adds-package', pkg('2.0.0'));
  });

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(`${repo}.gitconfig`, { force: true });
  });

  it('prints the tag when the version moved from the first parent', () => {
    const res = plan(commits.bump);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('v1.0.1\n');
  });

  it('prints a prerelease tag', () => {
    expect(plan(commits.prerelease).stdout).toBe('v1.1.0-rc.1\n');
  });

  it('prints the tag for a version that moved down', () => {
    expect(plan(commits.downgrade).stdout).toBe('v1.0.1\n');
  });

  it('compares a merge commit with its first parent', () => {
    const res = plan(commits.merge);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('v1.3.0\n');
  });

  it('prints nothing when the version did not move', () => {
    const res = plan(commits.unrelated);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('version unchanged at 1.0.0');
  });

  it('prints nothing for a commit without a parent', () => {
    const res = plan(commits.root);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('has no parent');
  });

  it('exits 3 when the new version is not a release tag', () => {
    const res = plan(commits.declined);
    expect(res.status).toBe(3);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('v1.1.0-foo is not a release tag');
  });

  it.each([
    ['no-version', 'package.json at'],
    ['after-no-version', 'package.json at'],
    ['empty-version', 'package.json at'],
    ['after-empty-version', 'package.json at'],
    ['orphan-adds-package', 'cannot read the version'],
  ])('exits 1 when a version cannot be read (%s)', (name, message) => {
    const res = plan(commits[name]);
    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain(message);
  });

  it('exits 1 for a commit that does not exist', () => {
    const res = plan('0123456789abcdef0123456789abcdef01234567');
    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
  });
});
