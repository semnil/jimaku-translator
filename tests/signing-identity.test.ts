import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findIdentity } = require('../build/signing-identity.cjs') as {
  findIdentity: (listing: string, teamId: string) => string;
};

const HASH_A = 'A'.repeat(40);
const HASH_B = 'B'.repeat(40);
const HASH_C = 'C'.repeat(40);

// The layout `security find-identity -v -p codesigning` prints.
function listing(entries: Array<[string, string]>): string {
  return [
    ...entries.map(([hash, name], i) => `  ${i + 1}) ${hash} "${name}"`),
    `     ${entries.length} valid identities found`,
    '',
  ].join('\n');
}

describe('findIdentity', () => {
  it('returns the Developer ID Application identity of the team', () => {
    const out = listing([
      [HASH_A, 'Apple Development: Example Person (ZZZZZ99999)'],
      [HASH_B, 'Developer ID Application: Example Person (ABCDE12345)'],
    ]);
    expect(findIdentity(out, 'ABCDE12345')).toBe('Developer ID Application: Example Person (ABCDE12345)');
  });

  it('keeps parentheses inside the name', () => {
    const out = listing([[HASH_A, 'Developer ID Application: Example (Studio) Ltd. (ABCDE12345)']]);
    expect(findIdentity(out, 'ABCDE12345')).toBe('Developer ID Application: Example (Studio) Ltd. (ABCDE12345)');
  });

  it('counts an identity listed in two keychains once', () => {
    const out = listing([
      [HASH_A, 'Developer ID Application: Example Person (ABCDE12345)'],
      [HASH_A, 'Developer ID Application: Example Person (ABCDE12345)'],
    ]);
    expect(findIdentity(out, 'ABCDE12345')).toBe('Developer ID Application: Example Person (ABCDE12345)');
  });

  it('does not take the identity of another team', () => {
    const out = listing([[HASH_A, 'Developer ID Application: Example Person (ZZZZZ99999)']]);
    expect(() => findIdentity(out, 'ABCDE12345')).toThrow('no Developer ID Application identity of the team');
  });

  it('does not take another kind of identity of the team', () => {
    const out = listing([
      [HASH_A, 'Apple Development: Example Person (ABCDE12345)'],
      [HASH_B, 'Developer ID Installer: Example Person (ABCDE12345)'],
    ]);
    expect(() => findIdentity(out, 'ABCDE12345')).toThrow('no Developer ID Application identity of the team');
  });

  it('throws when nothing is listed', () => {
    expect(() => findIdentity(listing([]), 'ABCDE12345')).toThrow('no Developer ID Application identity of the team');
  });

  it('throws when the team has two identities with different names', () => {
    const out = listing([
      [HASH_A, 'Developer ID Application: Example Person (ABCDE12345)'],
      [HASH_C, 'Developer ID Application: Example Company (ABCDE12345)'],
    ]);
    expect(() => findIdentity(out, 'ABCDE12345')).toThrow('2 Developer ID Application identities of the team');
  });
});
