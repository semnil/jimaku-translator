import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'release.yaml');

/** Splits the workflow into its top-level block and one text block per job. */
function readWorkflow(): { top: string[]; jobs: Map<string, string[]> } {
  const lines = fs.readFileSync(workflowPath, 'utf-8').split(/\r?\n/);
  const jobsAt = lines.indexOf('jobs:');
  const top = lines.slice(0, jobsAt);
  const jobs = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of lines.slice(jobsAt + 1)) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      current = [];
      jobs.set(header[1]!, current);
    } else if (current) {
      current.push(line);
    }
  }
  return { top, jobs };
}

/** Reads a `permissions:` mapping whose keys sit at `indent` spaces. */
function permissionsOf(lines: string[], indent: number): Record<string, string> | null {
  const start = lines.indexOf(`${' '.repeat(indent - 2)}permissions:`);
  if (start < 0) return null;
  const permissions: Record<string, string> = {};
  const entry = new RegExp(`^ {${indent}}([a-z-]+):\\s*([a-z]+)`);
  for (const line of lines.slice(start + 1)) {
    const match = entry.exec(line);
    if (!match) break;
    permissions[match[1]!] = match[2]!;
  }
  return permissions;
}

describe('release.yaml token scope', () => {
  const { top, jobs } = readWorkflow();

  it('grants only read access at the workflow level', () => {
    expect(permissionsOf(top, 2)).toEqual({ contents: 'read' });
  });

  it('grants contents: write to create-release and to no other job', () => {
    const writers = [...jobs].filter(([, body]) => permissionsOf(body, 6)?.contents === 'write').map(([id]) => id);
    expect(writers).toEqual(['create-release']);
  });

  it('does not hand the workflow token to build steps', () => {
    const text = [...top, ...[...jobs.values()].flat()].join('\n');
    expect(text).not.toMatch(/github\.token|GH_TOKEN/);
  });

  it('does not persist checkout credentials in jobs that install dependencies', () => {
    const installers = [...jobs].filter(([, body]) => body.some((line) => /run:\s*npm ci\b/.test(line)));
    expect(installers.map(([id]) => id).sort()).toEqual(['build-macos', 'build-windows']);
    for (const [, body] of installers) {
      body.forEach((line, i) => {
        if (/uses:\s*actions\/checkout@/.test(line)) {
          expect(body.slice(i + 1, i + 3).join('\n')).toMatch(/persist-credentials:\s*false/);
        }
      });
    }
  });
});
