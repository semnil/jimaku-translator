import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect } from 'vitest';
import {
  BINARY_VARIANTS,
  MODEL_REGISTRY,
  getWhisperDataDir,
  getAvailableBinaryVariants,
  getInstalledBinary,
  getInstalledModel,
  computeFileHash,
  verifyFileHash,
} from '../src/recognition/whisper-setup.js';

describe('BINARY_VARIANTS', () => {
  it('has unique IDs', () => {
    const ids = BINARY_VARIANTS.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all have required fields', () => {
    for (const v of BINARY_VARIANTS) {
      expect(v.id).toBeTruthy();
      expect(v.label).toBeTruthy();
      // Homebrew variant has no zip asset
      if (v.id !== 'homebrew') expect(v.zipAsset).toBeTruthy();
      expect(v.serverExe).toBeTruthy();
      expect(['win32', 'darwin']).toContain(v.platform);
    }
  });
});

describe('MODEL_REGISTRY', () => {
  it('has unique IDs', () => {
    const ids = MODEL_REGISTRY.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has unique filenames', () => {
    const filenames = MODEL_REGISTRY.map((m) => m.filename);
    expect(new Set(filenames).size).toBe(filenames.length);
  });

  it('all have required fields', () => {
    for (const m of MODEL_REGISTRY) {
      expect(m.id).toBeTruthy();
      expect(m.label).toBeTruthy();
      expect(m.filename).toMatch(/\.bin$/);
      expect(m.sizeBytes).toBeGreaterThan(0);
      expect(m.url).toMatch(/^https:\/\//);
      expect(typeof m.canTranslate).toBe('boolean');
    }
  });

  it('is ordered by sizeBytes descending', () => {
    for (let i = 1; i < MODEL_REGISTRY.length; i++) {
      expect(MODEL_REGISTRY[i - 1]!.sizeBytes).toBeGreaterThanOrEqual(MODEL_REGISTRY[i]!.sizeBytes);
    }
  });

  it('labels indicate JA only for non-translatable models', () => {
    for (const m of MODEL_REGISTRY) {
      if (!m.canTranslate) {
        expect(m.label).toContain('JA only');
      }
    }
  });

  it('includes expected model families', () => {
    const ids = MODEL_REGISTRY.map((m) => m.id);
    expect(ids).toContain('large-v3');
    expect(ids).toContain('large-v3-turbo');
    expect(ids).toContain('kotoba-bilingual');
    expect(ids).toContain('anime-whisper');
    expect(ids).toContain('small');
    expect(ids).toContain('base');
  });
});

describe('getWhisperDataDir', () => {
  it('returns a non-empty string', () => {
    const dir = getWhisperDataDir();
    expect(dir).toBeTruthy();
    expect(typeof dir).toBe('string');
  });

  it('respects VBAN_WHISPER_DIR env', () => {
    const original = process.env.VBAN_WHISPER_DIR;
    process.env.VBAN_WHISPER_DIR = '/custom/path';
    try {
      expect(getWhisperDataDir()).toBe('/custom/path');
    } finally {
      if (original !== undefined) {
        process.env.VBAN_WHISPER_DIR = original;
      } else {
        delete process.env.VBAN_WHISPER_DIR;
      }
    }
  });
});

describe('getAvailableBinaryVariants', () => {
  it('returns only variants for current platform', () => {
    const variants = getAvailableBinaryVariants();
    for (const v of variants) {
      expect(v.platform).toBe(process.platform);
    }
  });
});

describe('getInstalledBinary', () => {
  it('returns null for unknown variant', () => {
    expect(getInstalledBinary('nonexistent')).toBeNull();
  });

  it('returns null for valid but uninstalled variant', () => {
    expect(getInstalledBinary('cpu')).toBeNull();
  });
});

describe('getInstalledModel', () => {
  it('returns null for unknown model', () => {
    expect(getInstalledModel('nonexistent')).toBeNull();
  });

  it('returns null for valid but uninstalled model', () => {
    expect(getInstalledModel('base')).toBeNull();
  });
});

describe('computeFileHash', () => {
  it('computes SHA-256 of a file', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vban-test-'));
    const tmpFile = path.join(tmpDir, 'test.bin');
    fs.writeFileSync(tmpFile, 'hello world');
    try {
      const hash = await computeFileHash(tmpFile);
      // SHA-256 of "hello world"
      expect(hash).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('verifyFileHash', () => {
  it('returns false when no sidecar exists', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vban-test-'));
    const tmpFile = path.join(tmpDir, 'test.bin');
    fs.writeFileSync(tmpFile, 'hello');
    try {
      expect(await verifyFileHash(tmpFile)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns true when sidecar matches', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vban-test-'));
    const tmpFile = path.join(tmpDir, 'test.bin');
    fs.writeFileSync(tmpFile, 'hello world');
    const hash = await computeFileHash(tmpFile);
    fs.writeFileSync(tmpFile + '.sha256', hash);
    try {
      expect(await verifyFileHash(tmpFile)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns false when sidecar does not match', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vban-test-'));
    const tmpFile = path.join(tmpDir, 'test.bin');
    fs.writeFileSync(tmpFile, 'hello world');
    fs.writeFileSync(tmpFile + '.sha256', 'badhash');
    try {
      expect(await verifyFileHash(tmpFile)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
