import fs from 'node:fs';
import path from 'node:path';
// smol-toml is ESM-only; use createRequire to load it from CJS context
import { createRequire } from 'node:module';
const _require = createRequire(__filename);
const { parse } = _require('smol-toml') as { parse: (input: string) => Record<string, unknown> };
import { getInstalledBinary, getInstalledModel } from './recognition/whisper-setup.js';

export interface Config {
  vban: {
    port: number;
    stream_name: string;
  };
  obs: {
    host: string;
    port: number;
    password: string;
    source_ja: string;
    source_en: string;
    closed_caption: boolean;
    /** Language to send as closed caption: 'ja' or 'en'. */
    cc_language: 'ja' | 'en';
  };
  whisper: {
    server: string;
    /** Path to whisper-server binary. Auto-resolved from binary_variant if set. */
    binary: string;
    /** Path to GGML model file. Auto-resolved from model_name if set. */
    model: string;
    /** Selection key for managed binary variant (e.g. 'cublas-12'). */
    binary_variant: string;
    /** Selection key for managed model (e.g. 'large-v3-turbo-q5_0'). */
    model_name: string;
  };
  subtitle: {
    clear_delay: number;
    chars_per_line: number;
  };
  vad: {
    threshold: number;
    min_speech_ms: number;
    max_speech_ms: number;
  };
  audio: {
    /** RMS gate threshold in dBFS. Audio below this level is skipped before VAD. */
    rms_gate_db: number;
    /** Target RMS level for detected speech segments in dBFS. 0 = disabled. */
    normalize_target_dbfs: number;
    /** Enable adaptive noise-floor tracking that raises the gate above ambient noise. */
    adaptive_gate_enabled: boolean;
    /** Margin in dB added above the tracked noise floor when adaptive gate is on. */
    adaptive_gate_margin_db: number;
    /** Sliding window length in seconds for noise-floor sample history. */
    adaptive_gate_window_sec: number;
    /** Absolute ceiling for the adaptive gate in dBFS. Protects against runaway feedback. */
    adaptive_gate_max_db: number;
  };
  ui: {
    /** UI language override. Empty = auto-detect from system. */
    language: '' | 'en' | 'ja';
    /** Show VAD debug overlays (prob line, threshold, diag text) on the audio plot. */
    show_vad_debug: boolean;
  };
}

const DEFAULTS: Config = {
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
  whisper: { server: 'http://127.0.0.1:8080', binary: '', model: '', binary_variant: '', model_name: '' },
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

export function getLocalConfigPath(configPath: string): string {
  // Electron sets VBAN_LOCAL_CONFIG_DIR to userData (writable);
  // fall back to same directory as configPath (CLI mode).
  const dir = process.env.VBAN_LOCAL_CONFIG_DIR || path.dirname(configPath);
  return path.join(dir, 'config.local.toml');
}

export function loadConfig(configPath: string): Config {
  // Prefer config.local.toml (in userData or same directory)
  const localPath = getLocalConfigPath(configPath);
  const effectivePath = fs.existsSync(localPath) ? localPath : configPath;

  if (!fs.existsSync(effectivePath)) {
    console.warn(`Config file not found: ${configPath}, using defaults`);
    return DEFAULTS;
  }

  const raw = fs.readFileSync(effectivePath, 'utf-8');
  const parsed = parse(raw) as Partial<Config>;

  const config: Config = {
    vban: { ...DEFAULTS.vban, ...parsed.vban },
    obs: { ...DEFAULTS.obs, ...parsed.obs },
    whisper: { ...DEFAULTS.whisper, ...parsed.whisper },
    subtitle: { ...DEFAULTS.subtitle, ...parsed.subtitle },
    vad: { ...DEFAULTS.vad, ...parsed.vad },
    audio: { ...DEFAULTS.audio, ...parsed.audio },
    ui: { ...DEFAULTS.ui, ...parsed.ui },
  };

  // Auto-resolve binary/model paths from variant/name selection keys.
  // Always resolve from selection keys when set (overrides stale manual paths).
  if (config.whisper.binary_variant) {
    const resolved = getInstalledBinary(config.whisper.binary_variant);
    if (resolved) config.whisper.binary = resolved;
  }
  if (config.whisper.model_name) {
    const resolved = getInstalledModel(config.whisper.model_name);
    if (resolved) config.whisper.model = resolved;
  }

  validateConfig(config);
  return config;
}

export function validateConfig(c: Config): void {
  const errors: string[] = [];

  if (c.vban.port < 1 || c.vban.port > 65535) {
    errors.push(`vban.port must be 1-65535, got ${c.vban.port}`);
  }
  if (c.obs.port < 1 || c.obs.port > 65535) {
    errors.push(`obs.port must be 1-65535, got ${c.obs.port}`);
  }
  if (!c.obs.host) {
    errors.push('obs.host must not be empty');
  }
  if (!c.whisper.server) {
    errors.push('whisper.server must not be empty');
  } else {
    try {
      new URL(c.whisper.server);
    } catch {
      errors.push(`whisper.server must be a valid URL, got "${c.whisper.server}"`);
    }
  }
  if (c.vad.threshold < 0 || c.vad.threshold > 1) {
    errors.push(`vad.threshold must be 0-1, got ${c.vad.threshold}`);
  }
  if (c.vad.min_speech_ms < 0) {
    errors.push(`vad.min_speech_ms must be >= 0, got ${c.vad.min_speech_ms}`);
  }
  if (c.vad.max_speech_ms <= c.vad.min_speech_ms) {
    errors.push(`vad.max_speech_ms (${c.vad.max_speech_ms}) must be > min_speech_ms (${c.vad.min_speech_ms})`);
  }
  if (c.subtitle.clear_delay < 0) {
    errors.push(`subtitle.clear_delay must be >= 0, got ${c.subtitle.clear_delay}`);
  }
  if (c.subtitle.chars_per_line < 0) {
    errors.push(`subtitle.chars_per_line must be >= 0, got ${c.subtitle.chars_per_line}`);
  }
  if (c.audio.rms_gate_db > -30) {
    errors.push(`audio.rms_gate_db must be <= -30 (to preserve S/N after normalization), got ${c.audio.rms_gate_db}`);
  }
  if (c.audio.normalize_target_dbfs > 0) {
    errors.push(`audio.normalize_target_dbfs must be <= 0, got ${c.audio.normalize_target_dbfs}`);
  }
  if (c.audio.adaptive_gate_margin_db < 0) {
    errors.push(`audio.adaptive_gate_margin_db must be >= 0, got ${c.audio.adaptive_gate_margin_db}`);
  }
  if (c.audio.adaptive_gate_window_sec <= 0) {
    errors.push(`audio.adaptive_gate_window_sec must be > 0, got ${c.audio.adaptive_gate_window_sec}`);
  }
  if (c.audio.adaptive_gate_max_db > -10) {
    errors.push(`audio.adaptive_gate_max_db must be <= -10, got ${c.audio.adaptive_gate_max_db}`);
  }
  if (c.audio.adaptive_gate_max_db < c.audio.rms_gate_db) {
    errors.push(`audio.adaptive_gate_max_db (${c.audio.adaptive_gate_max_db}) must be >= rms_gate_db (${c.audio.rms_gate_db})`);
  }
  if (c.ui.language !== '' && c.ui.language !== 'en' && c.ui.language !== 'ja') {
    errors.push(`ui.language must be "", "en", or "ja", got "${c.ui.language}"`);
  }

  if (errors.length > 0) {
    throw new Error(`Config validation failed:\n  ${errors.join('\n  ')}`);
  }
}
