#!/usr/bin/env node
// The single home for what a release tag looks like and for whether a commit asks for one.
// Callers: .github/workflows/tag-release.yaml (plan), the check-event job of
// .github/workflows/release.yaml (shape), and tests/release-tag.test.ts.
//
//   shape <tag>     accepted: prints `true` (prerelease) or `false` on stdout, exits 0
//                   declined: prints the accepted forms on stderr, exits 3
//   plan <commit>   prints the tag for the version in the commit's package.json when it differs
//                   from the version in its first parent's, and prints nothing when the version
//                   did not move or the commit has no parent. Exits 3 when that tag is declined
//                   by shape, and 1 when a version cannot be read.
//   anything else   exits 2
//
// Answers go to stdout and messages to stderr. A caller treats a status other than the ones
// above as this check not having run.
'use strict';

const { execFileSync } = require('child_process');

const DECLINED = 3;
const USAGE = 2;
const FORMS = 'the forms are vX.Y.Z and vX.Y.Z-alpha/-beta/-rc followed by digits and dots';

class Refusal extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Returns whether a release tag is a prerelease, or null when the tag is not a release tag.
// Declines tags holding `..` or ending in `.`, which git does not accept as ref names.
function prerelease(tag) {
  if (tag.includes('..') || tag.endsWith('.')) return null;
  if (/^v\d+\.\d+\.\d+$/.test(tag)) return false;
  if (/^v\d+\.\d+\.\d+-(alpha|beta|rc)[\d.]*$/.test(tag)) return true;
  return null;
}

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function versionAt(commit) {
  const version = JSON.parse(git(['show', `${commit}:package.json`])).version;
  if (typeof version !== 'string' || version === '') {
    throw new Error(`package.json at ${commit} names no version`);
  }
  return version;
}

// Returns the first parent of a readable commit, or null when it has none.
function firstParent(commit) {
  try {
    return git(['rev-parse', '--verify', '--quiet', `${commit}^`]).trim();
  } catch (err) {
    if (err.status === 1) return null;
    throw err;
  }
}

function shape(tag) {
  const answer = prerelease(tag);
  if (answer === null) {
    throw new Refusal(`${tag} is not a release tag; ${FORMS}`, DECLINED);
  }
  process.stdout.write(`${answer}\n`);
}

function plan(commit) {
  let current;
  let previous;
  try {
    current = versionAt(commit);
    const parent = firstParent(commit);
    if (parent === null) {
      process.stderr.write(`${commit} has no parent; not a release\n`);
      return;
    }
    previous = versionAt(parent);
  } catch (err) {
    throw new Refusal(`cannot read the version: ${err.message.trim()}`, 1);
  }
  if (current === previous) {
    process.stderr.write(`version unchanged at ${current}; not a release\n`);
    return;
  }
  const tag = `v${current}`;
  if (prerelease(tag) === null) {
    throw new Refusal(`version ${previous} -> ${current}: ${tag} is not a release tag; ${FORMS}`, DECLINED);
  }
  process.stderr.write(`version ${previous} -> ${current}\n`);
  process.stdout.write(`${tag}\n`);
}

function main([command, arg, ...rest]) {
  if (arg && rest.length === 0 && command === 'shape') return shape(arg);
  if (arg && rest.length === 0 && command === 'plan') return plan(arg);
  throw new Refusal('usage: release-tag.cjs shape <tag> | plan <commit>', USAGE);
}

try {
  main(process.argv.slice(2));
} catch (err) {
  if (!(err instanceof Refusal)) throw err;
  process.stderr.write(`${err.message}\n`);
  process.exitCode = err.status;
}
