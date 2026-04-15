import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { loadConfig, validateConfig, type Config } from '../src/config.js';
import { configToToml } from '../src/server.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tomlRequire = createRequire(__filename);
const { parse: parseToml } = tomlRequire('smol-toml') as {
  parse: (input: string) => Record<string, unknown>;
};

function makeBaseConfig(): Config {
  return {
    vban: { port: 6980, stream_name: '' },
    obs: {
      host: '127.0.0.1',
      port: 4455,
      password: '',
      source_ja: '',
      source_en: '',
      closed_caption: false,
      cc_language: 'en',
    },
    whisper: {
      server: 'http://127.0.0.1:8080',
      binary: '',
      model: '',
      binary_variant: '',
      model_name: '',
      threads: undefined,
    },
    subtitle: { clear_delay: 6.0, chars_per_line: 0 },
    vad: { threshold: 0.5, min_speech_ms: 500, max_speech_ms: 10000 },
    audio: {
      rms_gate_db: -60,
      normalize_target_dbfs: -6,
      adaptive_gate_enabled: false,
      adaptive_gate_margin_db: 6,
      adaptive_gate_window_sec: 10,
      adaptive_gate_max_db: -30,
    },
    ui: { language: '', show_vad_debug: false },
  };
}

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

describe('validateConfig: whisper.threads', () => {
  it('accepts a positive integer', () => {
    const cfg = makeBaseConfig();
    cfg.whisper.threads = 4;
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it('accepts undefined (auto)', () => {
    const cfg = makeBaseConfig();
    cfg.whisper.threads = undefined;
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it('rejects zero', () => {
    const cfg = makeBaseConfig();
    cfg.whisper.threads = 0;
    expect(() => validateConfig(cfg)).toThrow('whisper.threads');
  });

  it('rejects negative values', () => {
    const cfg = makeBaseConfig();
    cfg.whisper.threads = -1;
    expect(() => validateConfig(cfg)).toThrow('whisper.threads');
  });

  it('rejects non-integer numbers', () => {
    const cfg = makeBaseConfig();
    cfg.whisper.threads = 1.5;
    expect(() => validateConfig(cfg)).toThrow('whisper.threads');
  });

  it('rejects Infinity', () => {
    const cfg = makeBaseConfig();
    cfg.whisper.threads = Infinity;
    expect(() => validateConfig(cfg)).toThrow('whisper.threads');
  });

  it('rejects NaN', () => {
    const cfg = makeBaseConfig();
    cfg.whisper.threads = NaN;
    expect(() => validateConfig(cfg)).toThrow('whisper.threads');
  });

  it('rejects string values', () => {
    const cfg = makeBaseConfig();
    (cfg.whisper as unknown as { threads: unknown }).threads = '4';
    expect(() => validateConfig(cfg)).toThrow('whisper.threads');
  });
});

describe('configToToml round-trip', () => {
  it('serializes whisper.threads when defined', () => {
    const cfg = makeBaseConfig();
    cfg.whisper.threads = 8;
    const toml = configToToml(cfg);
    const parsed = parseToml(toml) as { whisper: { threads: number } };
    expect(parsed.whisper.threads).toBe(8);
  });

  it('omits whisper.threads key when undefined', () => {
    const cfg = makeBaseConfig();
    cfg.whisper.threads = undefined;
    const toml = configToToml(cfg);
    expect(toml).not.toMatch(/^\s*threads\s*=/m);
    const parsed = parseToml(toml) as { whisper: Record<string, unknown> };
    expect('threads' in parsed.whisper).toBe(false);
  });
});
