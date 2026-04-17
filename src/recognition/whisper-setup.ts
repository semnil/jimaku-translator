import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

const execFileAsync = promisify(execFile);

// --- Types ---

export interface BinaryVariant {
  id: string;
  label: string;
  platform: 'win32' | 'darwin';
  zipAsset: string;
  serverExe: string;
}

export interface ModelInfo {
  id: string;
  label: string;
  filename: string;
  sizeBytes: number;
  url: string;
  /** Whether this model supports the translate task (JA→EN). Turbo models do not. */
  canTranslate: boolean;
}

export interface DownloadProgress {
  phase: 'downloading' | 'extracting' | 'verifying' | 'done' | 'error';
  percent: number;
  bytesDownloaded: number;
  bytesTotal: number;
  label: string;
}

// --- Constants ---

const WHISPER_RELEASE_TAG = 'v1.8.4';
const GITHUB_BASE = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_RELEASE_TAG}`;
const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
const HF_KOTOBA_BILINGUAL = 'https://huggingface.co/kotoba-tech/kotoba-whisper-bilingual-v1.0-ggml/resolve/main';
const HF_KOTOBA_V22 = 'https://huggingface.co/kenrouse/kotoba-whisper-v2.2-ggml/resolve/main';
const HF_ANIME_WHISPER = 'https://huggingface.co/Aratako/anime-whisper-ggml/resolve/main';

export const BINARY_VARIANTS: BinaryVariant[] = [
  {
    id: 'cublas-12',
    label: 'Windows (CUDA 12.x GPU)',
    platform: 'win32',
    zipAsset: 'whisper-cublas-12.4.0-bin-x64.zip',
    serverExe: 'Release/whisper-server.exe',
  },
  {
    id: 'cublas-11',
    label: 'Windows (CUDA 11.x GPU)',
    platform: 'win32',
    zipAsset: 'whisper-cublas-11.8.0-bin-x64.zip',
    serverExe: 'Release/whisper-server.exe',
  },
  {
    id: 'cpu',
    label: 'Windows (CPU only)',
    platform: 'win32',
    zipAsset: 'whisper-bin-x64.zip',
    serverExe: 'Release/whisper-server.exe',
  },
  {
    id: 'homebrew',
    label: 'macOS (Homebrew · Apple Silicon / Intel)',
    platform: 'darwin',
    zipAsset: '',
    serverExe: 'whisper-server',
  },
];

export const MODEL_REGISTRY: ModelInfo[] = [
  {
    id: 'large-v3',
    label: 'Large V3 (3.1 GB)',
    filename: 'ggml-large-v3.bin',
    sizeBytes: 3100 * 1024 * 1024,
    url: `${HF_BASE}/ggml-large-v3.bin`,
    canTranslate: true,
  },
  {
    id: 'large-v3-turbo',
    label: 'Large V3 Turbo (1.6 GB, JA only)',
    filename: 'ggml-large-v3-turbo.bin',
    sizeBytes: 1620 * 1024 * 1024,
    url: `${HF_BASE}/ggml-large-v3-turbo.bin`,
    canTranslate: false,
  },
  {
    id: 'medium',
    label: 'Medium (1.5 GB)',
    filename: 'ggml-medium.bin',
    sizeBytes: 1530 * 1024 * 1024,
    url: `${HF_BASE}/ggml-medium.bin`,
    canTranslate: true,
  },
  {
    id: 'kotoba-v2.2',
    label: 'Kotoba V2.2 (1.5 GB, JA optimized, JA only)',
    filename: 'kotoba-whisper-v2.2-ggml.bin',
    sizeBytes: 1520 * 1024 * 1024,
    url: `${HF_KOTOBA_V22}/kotoba-whisper-v2.2-ggml.bin`,
    canTranslate: false,
  },
  {
    id: 'kotoba-bilingual',
    label: 'Kotoba Bilingual (1.5 GB, JA optimized, JA only)',
    filename: 'ggml-kotoba-whisper-bilingual-v1.0.bin',
    sizeBytes: 1520 * 1024 * 1024,
    url: `${HF_KOTOBA_BILINGUAL}/ggml-kotoba-whisper-bilingual-v1.0.bin`,
    canTranslate: false,
  },
  {
    id: 'anime-whisper',
    label: 'Anime Whisper (1.5 GB, JA anime optimized, JA only)',
    filename: 'ggml-anime-whisper.bin',
    sizeBytes: 1520 * 1024 * 1024,
    url: `${HF_ANIME_WHISPER}/ggml-anime-whisper.bin`,
    canTranslate: false,
  },
  {
    id: 'large-v3-turbo-q5_0',
    label: 'Large V3 Turbo Q5 (574 MB, JA only)',
    filename: 'ggml-large-v3-turbo-q5_0.bin',
    sizeBytes: 574 * 1024 * 1024,
    url: `${HF_BASE}/ggml-large-v3-turbo-q5_0.bin`,
    canTranslate: false,
  },
  {
    id: 'kotoba-bilingual-q5_0',
    label: 'Kotoba Bilingual Q5 (538 MB, JA optimized, JA only)',
    filename: 'ggml-kotoba-whisper-bilingual-v1.0-q5_0.bin',
    sizeBytes: 538 * 1024 * 1024,
    url: `${HF_KOTOBA_BILINGUAL}/ggml-kotoba-whisper-bilingual-v1.0-q5_0.bin`,
    canTranslate: false,
  },
  {
    id: 'kotoba-v2.2-q5_0',
    label: 'Kotoba V2.2 Q5 (538 MB, JA optimized, JA only)',
    filename: 'kotoba-whisper-v2.2-ggml-q5_0.bin',
    sizeBytes: 538 * 1024 * 1024,
    url: `${HF_KOTOBA_V22}/kotoba-whisper-v2.2-ggml-q5_0.bin`,
    canTranslate: false,
  },
  {
    id: 'anime-whisper-q5_0',
    label: 'Anime Whisper Q5 (538 MB, JA anime optimized, JA only)',
    filename: 'ggml-anime-whisper-q5_0.bin',
    sizeBytes: 538 * 1024 * 1024,
    url: `${HF_ANIME_WHISPER}/ggml-anime-whisper-q5_0.bin`,
    canTranslate: false,
  },
  {
    id: 'small',
    label: 'Small (488 MB)',
    filename: 'ggml-small.bin',
    sizeBytes: 488 * 1024 * 1024,
    url: `${HF_BASE}/ggml-small.bin`,
    canTranslate: true,
  },
  {
    id: 'base',
    label: 'Base (148 MB)',
    filename: 'ggml-base.bin',
    sizeBytes: 148 * 1024 * 1024,
    url: `${HF_BASE}/ggml-base.bin`,
    canTranslate: true,
  },
];

// --- Data directory ---

/**
 * Root data directory shared by Electron and CLI.
 * Matches Electron's `app.getPath('userData')` for the "Jimaku Translator"
 * product so the CLI and the packaged app see the same downloaded models.
 * Override with `JIMAKU_DATA_DIR` (Electron sets this explicitly).
 */
export function getJimakuDataRoot(): string {
  const env = process.env.JIMAKU_DATA_DIR;
  if (env) return env;
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Jimaku Translator');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Jimaku Translator');
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  return path.join(xdg, 'Jimaku Translator');
}

export function getWhisperDataDir(): string {
  // Backwards compatibility with the legacy override.
  const envDir = process.env.VBAN_WHISPER_DIR;
  if (envDir) return envDir;
  return path.join(getJimakuDataRoot(), 'whisper');
}

/**
 * One-shot migration from the v1.0.x layout (~/.jimaku-translator/whisper)
 * to the unified data root. Call once at process startup. Symlinks the legacy
 * dir into the new location so existing downloads remain the single source of
 * truth; falls back to a recursive copy if symlinks are unavailable (Windows
 * without dev mode).
 */
export function migrateLegacyDataIfNeeded(): void {
  if (process.env.VBAN_WHISPER_DIR) return;
  const targetDir = path.join(getJimakuDataRoot(), 'whisper');
  if (fs.existsSync(targetDir)) return;

  const home = os.homedir();
  const candidates: string[] = [
    path.join(home, '.jimaku-translator', 'whisper'),
  ];
  if (process.platform === 'darwin') {
    // Electron's product-name lowercased fallback used by older builds
    candidates.push(path.join(home, 'Library', 'Application Support', 'jimaku-translator', 'whisper'));
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    candidates.push(path.join(appData, 'jimaku-translator', 'whisper'));
  }

  const legacy = candidates.find((p) => fs.existsSync(p));
  if (!legacy) return;

  try {
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  } catch { /* ignore */ }
  try {
    fs.symlinkSync(legacy, targetDir, 'dir');
    return;
  } catch { /* fall through to copy */ }

  // Stage into a sibling temp dir then rename atomically — a partial cpSync
  // would otherwise leave a half-populated targetDir that future startups
  // would treat as "already migrated", silently corrupting the install.
  const stagingDir = `${targetDir}.migrating-${process.pid}`;
  try {
    fs.cpSync(legacy, stagingDir, { recursive: true });
    fs.renameSync(stagingDir, targetDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[migrate] failed to migrate ${legacy} → ${targetDir}: ${msg}. User will need to re-download models.`);
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// --- Variant / model availability ---

export function getAvailableBinaryVariants(): BinaryVariant[] {
  return BINARY_VARIANTS.filter((v) => v.platform === process.platform);
}

export function getInstalledBinary(variantId: string): string | null {
  const variant = BINARY_VARIANTS.find((v) => v.id === variantId);
  if (!variant) return null;

  // Homebrew variant: detect from Homebrew prefix
  if (variantId === 'homebrew') {
    return detectHomebrewWhisperServer();
  }

  const dir = getWhisperDataDir();
  const exePath = path.join(dir, 'bin', variantId, variant.serverExe);
  if (!fs.existsSync(exePath)) return null;

  // Reject if hash sidecar is missing (download didn't complete verification)
  const sidecar = exePath + '.sha256';
  if (!fs.existsSync(sidecar)) return null;

  return exePath;
}

/** Detect whisper-server installed via Homebrew. Symlinks into Cellar are accepted (Homebrew's standard layout). */
function detectHomebrewWhisperServer(): string | null {
  const prefixes = ['/opt/homebrew', '/usr/local'];
  for (const prefix of prefixes) {
    const serverPath = path.join(prefix, 'bin', 'whisper-server');
    try {
      // Resolve symlink and verify the real file exists inside Homebrew's Cellar
      const real = fs.realpathSync(serverPath);
      if (!real.startsWith(prefix + '/Cellar/')) continue;
      if (!fs.statSync(real).isFile()) continue;
      return serverPath;
    } catch { /* not found */ }
  }
  return null;
}

export function getInstalledModel(modelId: string): string | null {
  const model = MODEL_REGISTRY.find((m) => m.id === modelId);
  if (!model) return null;

  const dir = getWhisperDataDir();
  const modelPath = path.join(dir, 'models', model.filename);
  if (!fs.existsSync(modelPath)) return null;

  // Reject incomplete downloads (must be at least 90% of expected size)
  const stat = fs.statSync(modelPath);
  if (stat.size < model.sizeBytes * 0.9) return null;

  // Reject if hash sidecar is missing (download didn't complete verification)
  const sidecar = modelPath + '.sha256';
  if (!fs.existsSync(sidecar)) return null;

  return modelPath;
}

// --- GPU detection ---

export async function detectRecommendedVariant(): Promise<string> {
  if (process.platform === 'darwin') {
    return 'homebrew';
  }
  if (process.platform !== 'win32') return 'cpu';

  try {
    const { stdout } = await execFileAsync('nvidia-smi', [
      '--query-gpu=driver_version',
      '--format=csv,noheader',
    ]);
    const driverVersion = parseFloat(stdout.trim());
    if (driverVersion >= 520) return 'cublas-12';
    if (driverVersion >= 450) return 'cublas-11';
    return 'cpu';
  } catch {
    return 'cpu';
  }
}

// --- Download helpers ---

export function downloadFile(
  url: string,
  destPath: string,
  onProgress: (downloaded: number, total: number) => void,
  abortSignal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(new Error('Download aborted'));
      return;
    }

    const doRequest = (requestUrl: string, redirectsLeft: number) => {
      const mod = requestUrl.startsWith('https') ? https : http;
      const req = mod.get(requestUrl, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects'));
            return;
          }
          const location = res.headers.location;
          const nextUrl = location.startsWith('http') ? location : new URL(location, requestUrl).href;
          doRequest(nextUrl, redirectsLeft - 1);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} from ${requestUrl}`));
          return;
        }

        const total = parseInt(res.headers['content-length'] ?? '0', 10);
        let downloaded = 0;
        const file = fs.createWriteStream(destPath);

        const onAbort = () => {
          req.destroy();
          file.close();
          fs.unlink(destPath, () => {});
          reject(new Error('Download aborted'));
        };
        abortSignal?.addEventListener('abort', onAbort, { once: true });

        res.on('data', (chunk: Buffer) => {
          downloaded += chunk.length;
          onProgress(downloaded, total);
        });
        res.on('error', (err) => {
          abortSignal?.removeEventListener('abort', onAbort);
          file.close();
          fs.unlink(destPath, () => {});
          reject(err);
        });
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          abortSignal?.removeEventListener('abort', onAbort);
          if (total > 0 && downloaded < total) {
            fs.unlink(destPath, () => {});
            reject(new Error(`Incomplete download: ${downloaded}/${total} bytes`));
            return;
          }
          resolve();
        });
        file.on('error', (err) => {
          abortSignal?.removeEventListener('abort', onAbort);
          fs.unlink(destPath, () => {});
          reject(err);
        });
      });
      req.on('error', reject);
    };

    doRequest(url, 10);
  });
}

export async function extractZip(zipPath: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });

  if (process.platform === 'win32') {
    await execFileAsync('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force',
      '--', zipPath, destDir,
    ]);
  } else {
    await execFileAsync('unzip', ['-o', zipPath, '-d', destDir]);
  }

  // Verify no entry escaped destDir (zip slip guard)
  const resolvedDest = path.resolve(destDir) + path.sep;
  const entries = fs.readdirSync(destDir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.resolve(
      typeof entry.parentPath === 'string' ? entry.parentPath : (entry as unknown as { path: string }).path,
      entry.name,
    );
    if (!entryPath.startsWith(resolvedDest)) {
      fs.rmSync(destDir, { recursive: true, force: true });
      throw new Error(`zip slip detected: ${entryPath}`);
    }
  }
}

// --- Checksum helpers ---

/** Compute SHA-256 hash of a file (streaming, constant memory). */
export function computeFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function hashSidecarPath(filePath: string): string {
  return filePath + '.sha256';
}

/** Save computed hash to a sidecar file next to the downloaded file. */
function saveHashSidecar(filePath: string, hash: string): void {
  fs.writeFileSync(hashSidecarPath(filePath), hash, 'utf-8');
}

/** Verify file hash against its sidecar. Returns true if valid, false if mismatch or missing. */
export async function verifyFileHash(filePath: string): Promise<boolean> {
  const sidecar = hashSidecarPath(filePath);
  if (!fs.existsSync(sidecar)) return false;
  const expected = fs.readFileSync(sidecar, 'utf-8').trim();
  if (!expected) return false;
  const actual = await computeFileHash(filePath);
  return actual === expected;
}

// --- Homebrew install ---

async function installHomebrewWhisperCpp(
  onProgress: (p: DownloadProgress) => void,
  abortSignal?: AbortSignal,
): Promise<string> {
  onProgress({ phase: 'downloading', percent: 0, bytesDownloaded: 0, bytesTotal: 0, label: 'brew install whisper-cpp ...' });

  const already = detectHomebrewWhisperServer();
  if (already) {
    onProgress({ phase: 'done', percent: 100, bytesDownloaded: 0, bytesTotal: 0, label: 'Already installed' });
    return already;
  }

  const brewPath = fs.existsSync('/opt/homebrew/bin/brew') ? '/opt/homebrew/bin/brew' : '/usr/local/bin/brew';
  if (!fs.existsSync(brewPath)) {
    throw new Error('Homebrew is not installed. Install from https://brew.sh');
  }

  const ac = new AbortController();
  abortSignal?.addEventListener('abort', () => ac.abort(), { once: true });

  onProgress({ phase: 'downloading', percent: 50, bytesDownloaded: 0, bytesTotal: 0, label: 'brew install whisper-cpp ...' });
  await execFileAsync(brewPath, ['install', 'whisper-cpp'], { signal: ac.signal });

  const installed = detectHomebrewWhisperServer();
  if (!installed) {
    throw new Error('brew install succeeded but whisper-server not found');
  }
  onProgress({ phase: 'done', percent: 100, bytesDownloaded: 0, bytesTotal: 0, label: 'Installed' });
  return installed;
}

// --- High-level download functions ---

export async function downloadBinary(
  variantId: string,
  onProgress: (p: DownloadProgress) => void,
  abortSignal?: AbortSignal,
): Promise<string> {
  const variant = BINARY_VARIANTS.find((v) => v.id === variantId);
  if (!variant) throw new Error(`Unknown variant: ${variantId}`);

  // Homebrew variant: run `brew install whisper-cpp`
  if (variantId === 'homebrew') {
    return installHomebrewWhisperCpp(onProgress, abortSignal);
  }

  const dataDir = getWhisperDataDir();
  const binDir = path.join(dataDir, 'bin', variantId);
  const zipPath = path.join(dataDir, 'bin', `${variantId}.zip`);
  const url = `${GITHUB_BASE}/${variant.zipAsset}`;

  fs.mkdirSync(path.dirname(zipPath), { recursive: true });

  onProgress({ phase: 'downloading', percent: 0, bytesDownloaded: 0, bytesTotal: 0, label: variant.zipAsset });

  await downloadFile(url, zipPath, (downloaded, total) => {
    const percent = total > 0 ? Math.round((downloaded / total) * 100) : 0;
    onProgress({ phase: 'downloading', percent, bytesDownloaded: downloaded, bytesTotal: total, label: variant.zipAsset });
  }, abortSignal);

  onProgress({ phase: 'extracting', percent: 100, bytesDownloaded: 0, bytesTotal: 0, label: 'Extracting...' });

  await extractZip(zipPath, binDir);
  fs.unlinkSync(zipPath);

  const exePath = path.join(binDir, variant.serverExe);
  if (!fs.existsSync(exePath)) {
    throw new Error(`whisper-server not found after extraction: ${exePath}`);
  }

  // Compute and save hash for integrity verification
  onProgress({ phase: 'verifying', percent: 100, bytesDownloaded: 0, bytesTotal: 0, label: 'Verifying checksum...' });
  const hash = await computeFileHash(exePath);
  saveHashSidecar(exePath, hash);

  onProgress({ phase: 'done', percent: 100, bytesDownloaded: 0, bytesTotal: 0, label: 'Installed' });
  return exePath;
}

export async function downloadModel(
  modelId: string,
  onProgress: (p: DownloadProgress) => void,
  abortSignal?: AbortSignal,
): Promise<string> {
  const model = MODEL_REGISTRY.find((m) => m.id === modelId);
  if (!model) throw new Error(`Unknown model: ${modelId}`);

  const dataDir = getWhisperDataDir();
  const modelsDir = path.join(dataDir, 'models');
  const modelPath = path.join(modelsDir, model.filename);

  fs.mkdirSync(modelsDir, { recursive: true });

  onProgress({ phase: 'downloading', percent: 0, bytesDownloaded: 0, bytesTotal: model.sizeBytes, label: model.filename });

  await downloadFile(model.url, modelPath, (downloaded, total) => {
    const effectiveTotal = total > 0 ? total : model.sizeBytes;
    const percent = effectiveTotal > 0 ? Math.round((downloaded / effectiveTotal) * 100) : 0;
    onProgress({ phase: 'downloading', percent, bytesDownloaded: downloaded, bytesTotal: effectiveTotal, label: model.filename });
  }, abortSignal);

  // Verify size
  const stat = fs.statSync(modelPath);
  if (stat.size < model.sizeBytes * 0.9) {
    fs.unlinkSync(modelPath);
    throw new Error(`Download incomplete: ${stat.size} bytes (expected ~${model.sizeBytes})`);
  }

  // Compute and save hash for integrity verification
  onProgress({ phase: 'verifying', percent: 100, bytesDownloaded: 0, bytesTotal: 0, label: 'Verifying checksum...' });
  const hash = await computeFileHash(modelPath);
  saveHashSidecar(modelPath, hash);

  onProgress({ phase: 'done', percent: 100, bytesDownloaded: 0, bytesTotal: 0, label: 'Installed' });
  return modelPath;
}
