import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const modulePath = require.resolve('../build/win-version-info.cjs');

type Hook = ((event: { targetPresentableName: string }) => Promise<void>) & {
  record: (context: unknown) => void;
};

function load(): Hook {
  delete require.cache[modulePath];
  return require(modulePath) as Hook;
}

describe('win-version-info', () => {
  let hook: Hook;
  beforeEach(() => {
    hook = load();
  });

  it('does nothing for a target other than NSIS', async () => {
    await expect(hook({ targetPresentableName: 'DMG' })).resolves.toBeUndefined();
    await expect(hook({ targetPresentableName: 'macOS zip' })).resolves.toBeUndefined();
  });

  it('fails when the NSIS target starts and afterPack recorded no Windows app', async () => {
    await expect(hook({ targetPresentableName: 'nsis' })).rejects.toThrow('afterPack recorded no Windows app');
  });
});
