import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function writeTempConfig(content: string): string {
  const p = path.join(os.tmpdir(), `jimaku-translator-test-${Date.now()}.toml`);
  fs.writeFileSync(p, content);
  return p;
}

describe('loadConfig', () => {
  it('returns defaults for missing file', () => {
    const cfg = loadConfig('/nonexistent/path.toml');
    expect(cfg.vban.port).toBe(6980);
    expect(cfg.obs.host).toBe('127.0.0.1');
    expect(cfg.vad.threshold).toBe(0.5);
  });

  it('merges partial config with defaults', () => {
    const p = writeTempConfig('[obs]\nhost = "10.0.0.1"\n');
    const cfg = loadConfig(p);
    expect(cfg.obs.host).toBe('10.0.0.1');
    expect(cfg.obs.port).toBe(4455); // default
    fs.unlinkSync(p);
  });

  it('rejects invalid vban port', () => {
    const p = writeTempConfig('[vban]\nport = 99999\n');
    expect(() => loadConfig(p)).toThrow('vban.port');
    fs.unlinkSync(p);
  });

  it('rejects invalid vad threshold', () => {
    const p = writeTempConfig('[vad]\nthreshold = 2.0\n');
    expect(() => loadConfig(p)).toThrow('vad.threshold');
    fs.unlinkSync(p);
  });

  it('rejects max_speech_ms <= min_speech_ms', () => {
    const p = writeTempConfig('[vad]\nmin_speech_ms = 5000\nmax_speech_ms = 3000\n');
    expect(() => loadConfig(p)).toThrow('max_speech_ms');
    fs.unlinkSync(p);
  });
});
