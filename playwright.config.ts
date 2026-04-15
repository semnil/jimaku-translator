import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const recognitionMode = !!process.env.JT_E2E_RECOGNITION;
const e2eConfigDir = path.join(os.tmpdir(), `jimaku-e2e-${process.pid}`);
fs.mkdirSync(e2eConfigDir, { recursive: true });

// In recognition mode, the pipeline must boot with a real whisper binary +
// model already wired up — POST /api/config does NOT restart the managed
// process. Pre-write a config.local.toml with detected paths and reuse the
// user's real data dir so installed models are discoverable.
const serverEnv: Record<string, string> = {
  VBAN_LOCAL_CONFIG_DIR: e2eConfigDir,
};
if (recognitionMode) {
  const brewServer = ['/opt/homebrew/bin/whisper-server', '/usr/local/bin/whisper-server']
    .find((p) => { try { return fs.statSync(fs.realpathSync(p)).isFile(); } catch { return false; } });
  const realDataDir = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'Jimaku Translator', 'whisper')
    : path.join(os.homedir(), '.jimaku-translator', 'whisper');
  const modelCandidates = ['ggml-medium.bin', 'ggml-large-v3.bin', 'ggml-small.bin', 'ggml-base.bin'];
  const modelEntry = modelCandidates
    .map((f) => ({ file: f, path: path.join(realDataDir, 'models', f) }))
    .find((m) => fs.existsSync(m.path));
  if (brewServer && modelEntry) {
    const modelName = modelEntry.file.replace(/^ggml-/, '').replace(/\.bin$/, '');
    const toml = [
      '[whisper]',
      `binary = "${brewServer}"`,
      `binary_variant = "homebrew"`,
      `model = "${modelEntry.path}"`,
      `model_name = "${modelName}"`,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(e2eConfigDir, 'config.local.toml'), toml);
    serverEnv.JIMAKU_DATA_DIR = realDataDir.replace(/\/whisper$/, '');
  } else {
    serverEnv.JIMAKU_DATA_DIR = e2eConfigDir;
  }
} else {
  serverEnv.JIMAKU_DATA_DIR = e2eConfigDir;
}

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  retries: 0,
  // Recognition mode mutates whisper config mid-run; force serial execution so
  // a parallel worker can't POST /api/config from a non-recognition test and
  // race the binary/model paths.
  workers: recognitionMode ? 1 : undefined,
  use: {
    baseURL: 'http://127.0.0.1:9880',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'node --enable-source-maps dist/index.js',
    port: 9880,
    reuseExistingServer: false,
    timeout: 15000,
    env: serverEnv,
  },
});
