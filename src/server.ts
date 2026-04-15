import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { type Config, validateConfig, getLocalConfigPath } from './config.js';
import { encodeWav } from './audio/wav.js';
import { Pipeline } from './pipeline.js';
import {
  getAvailableBinaryVariants,
  detectRecommendedVariant,
  getInstalledBinary,
  getInstalledModel,
  downloadBinary,
  downloadModel,
  MODEL_REGISTRY,
  type DownloadProgress,
} from './recognition/whisper-setup.js';

export const GUI_PORT = 9880;



export interface ServerOptions {
  pipeline: Pipeline;
}

export function createServer(opts: ServerOptions): http.Server {
  const { pipeline } = opts;
  const sseClients = new Set<http.ServerResponse>();

  pipeline.on('status', (status) => {
    broadcast(sseClients, 'status', status);
  });

  pipeline.on('log', (message) => {
    broadcast(sseClients, 'log', { message, timestamp: Date.now() });
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    try {
      if (url.pathname === '/' && req.method === 'GET') {
        serveUI(res);
      } else if (url.pathname === '/api/status' && req.method === 'GET') {
        json(res, pipeline.getStatus());
      } else if (url.pathname === '/api/config' && req.method === 'GET') {
        json(res, pipeline.getConfig());
      } else if (url.pathname === '/api/config' && req.method === 'POST') {
        await handleSaveConfig(req, res, pipeline);
      } else if (url.pathname === '/api/obs/reconnect' && req.method === 'POST') {
        await handleObsReconnect(res, pipeline);
      } else if (url.pathname === '/api/obs/sources' && req.method === 'GET') {
        await handleObsSources(res, pipeline);
      } else if (url.pathname === '/api/whisper/variants' && req.method === 'GET') {
        await handleWhisperVariants(res);
      } else if (url.pathname === '/api/whisper/models' && req.method === 'GET') {
        handleWhisperModels(res);
      } else if (url.pathname === '/api/whisper/download-binary' && req.method === 'POST') {
        await handleDownloadBinary(req, res, pipeline, sseClients);
      } else if (url.pathname === '/api/whisper/download-model' && req.method === 'POST') {
        await handleDownloadModel(req, res, pipeline, sseClients);
      } else if (url.pathname === '/api/whisper/download-cancel' && req.method === 'POST') {
        await handleDownloadCancel(req, res);
      } else if (url.pathname === '/api/capture' && req.method === 'POST') {
        await handleCapture(req, res, pipeline);
      } else if (url.pathname === '/api/events' && req.method === 'GET') {
        handleSSE(req, res, sseClients, pipeline);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: msg }));
    }
  });

  return server;
}

// Resolve HTML path once at startup
let resolvedHtmlPath: string | null = null;

function serveUI(res: http.ServerResponse): void {
  if (!resolvedHtmlPath) {
    const distPath = path.join(__dirname, 'ui', 'index.html');
    const srcPath = path.resolve(__dirname, '..', 'src', 'ui', 'index.html');
    if (fs.existsSync(distPath)) resolvedHtmlPath = distPath;
    else if (fs.existsSync(srcPath)) resolvedHtmlPath = srcPath;
  }

  if (!resolvedHtmlPath) {
    res.writeHead(404).end('UI not found');
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  fs.createReadStream(resolvedHtmlPath).pipe(res);
}

function json(res: http.ServerResponse, data: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const MAX_BODY_SIZE = 64 * 1024; // 64KB

async function handleSaveConfig(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pipeline: Pipeline,
): Promise<void> {
  const body = await readBody(req, MAX_BODY_SIZE);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }

  const config = parseConfigInput(parsed);
  if (!config) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing required config fields' }));
    return;
  }

  try {
    validateConfig(config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
    return;
  }

  const localPath = saveConfigToml(config, pipeline.getConfigPath());

  // Update in-memory config — most settings take effect immediately
  pipeline.updateObsConfig(config.obs);
  pipeline.updateWhisperConfig(config.whisper);
  pipeline.updateSubtitleConfig(config.subtitle);
  pipeline.updateVadConfig(config.vad);
  pipeline.updateAudioConfig(config.audio);
  pipeline.updateVbanConfig(config.vban);
  pipeline.updateUiConfig(config.ui);

  json(res, { saved: localPath });
}

/** Validate shape of incoming config JSON before casting. */
function parseConfigInput(data: unknown): Config | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;

  const vban = d.vban as Record<string, unknown> | undefined;
  const obs = d.obs as Record<string, unknown> | undefined;
  const whisper = d.whisper as Record<string, unknown> | undefined;
  const subtitle = d.subtitle as Record<string, unknown> | undefined;
  const vad = d.vad as Record<string, unknown> | undefined;
  const audio = d.audio as Record<string, unknown> | undefined;
  const ui = d.ui as Record<string, unknown> | undefined;

  if (!vban || !obs || !whisper || !subtitle || !vad || !audio || !ui) return null;
  if (typeof vban.port !== 'number' || typeof vban.stream_name !== 'string') return null;
  if (typeof obs.host !== 'string' || typeof obs.port !== 'number') return null;
  if (typeof obs.password !== 'string') return null;
  if (typeof obs.source_ja !== 'string' || typeof obs.source_en !== 'string') return null;
  if (typeof obs.closed_caption !== 'boolean') return null;
  if (obs.cc_language !== 'ja' && obs.cc_language !== 'en') return null;
  if (typeof whisper.server !== 'string') return null;
  if (typeof whisper.binary !== 'string' || typeof whisper.model !== 'string') return null;
  if (typeof whisper.binary_variant !== 'string' || typeof whisper.model_name !== 'string') return null;
  if (whisper.threads !== undefined && typeof whisper.threads !== 'number') return null;
  if (typeof subtitle.clear_delay !== 'number' || typeof subtitle.chars_per_line !== 'number') return null;
  if (typeof vad.threshold !== 'number') return null;
  if (typeof vad.min_speech_ms !== 'number' || typeof vad.max_speech_ms !== 'number') return null;
  if (typeof audio.rms_gate_db !== 'number' || typeof audio.normalize_target_dbfs !== 'number') return null;
  if (typeof audio.adaptive_gate_enabled !== 'boolean') return null;
  if (typeof audio.adaptive_gate_margin_db !== 'number' || typeof audio.adaptive_gate_window_sec !== 'number') return null;
  if (typeof audio.adaptive_gate_max_db !== 'number') return null;
  if (ui.language !== '' && ui.language !== 'en' && ui.language !== 'ja') return null;
  if (typeof ui.show_vad_debug !== 'boolean') return null;

  return data as Config;
}

function escapeTomlString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

export function configToToml(config: Config): string {
  const e = escapeTomlString;
  const lines: string[] = [];

  lines.push('[vban]');
  lines.push(`port = ${config.vban.port}`);
  lines.push(`stream_name = "${e(config.vban.stream_name)}"`);
  lines.push('');

  lines.push('[obs]');
  lines.push(`host = "${e(config.obs.host)}"`);
  lines.push(`port = ${config.obs.port}`);
  lines.push(`password = "${e(config.obs.password)}"`);
  lines.push(`source_ja = "${e(config.obs.source_ja)}"`);
  lines.push(`source_en = "${e(config.obs.source_en)}"`);
  lines.push(`closed_caption = ${config.obs.closed_caption}`);
  lines.push(`cc_language = "${e(config.obs.cc_language)}"`);
  lines.push('');

  lines.push('[whisper]');
  lines.push(`server = "${e(config.whisper.server)}"`);
  lines.push(`binary = "${e(config.whisper.binary)}"`);
  lines.push(`model = "${e(config.whisper.model)}"`);
  lines.push(`binary_variant = "${e(config.whisper.binary_variant)}"`);
  lines.push(`model_name = "${e(config.whisper.model_name)}"`);
  if (config.whisper.threads !== undefined) {
    lines.push(`threads = ${config.whisper.threads}`);
  }
  lines.push('');

  lines.push('[subtitle]');
  lines.push(`clear_delay = ${config.subtitle.clear_delay}`);
  lines.push(`chars_per_line = ${config.subtitle.chars_per_line}`);
  lines.push('');

  lines.push('[vad]');
  lines.push(`threshold = ${config.vad.threshold}`);
  lines.push(`min_speech_ms = ${config.vad.min_speech_ms}`);
  lines.push(`max_speech_ms = ${config.vad.max_speech_ms}`);
  lines.push('');

  lines.push('[audio]');
  lines.push(`rms_gate_db = ${config.audio.rms_gate_db}`);
  lines.push(`normalize_target_dbfs = ${config.audio.normalize_target_dbfs}`);
  lines.push(`adaptive_gate_enabled = ${config.audio.adaptive_gate_enabled}`);
  lines.push(`adaptive_gate_margin_db = ${config.audio.adaptive_gate_margin_db}`);
  lines.push(`adaptive_gate_window_sec = ${config.audio.adaptive_gate_window_sec}`);
  lines.push(`adaptive_gate_max_db = ${config.audio.adaptive_gate_max_db}`);
  lines.push('');

  lines.push('[ui]');
  lines.push(`language = "${e(config.ui.language)}"`);
  lines.push(`show_vad_debug = ${config.ui.show_vad_debug}`);
  lines.push('');

  return lines.join('\n');
}

async function handleObsReconnect(res: http.ServerResponse, pipeline: Pipeline): Promise<void> {
  const obs = pipeline.getObs();
  if (!obs) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'OBS client not initialized' }));
    return;
  }
  try {
    await obs.reconnect();
    json(res, { connected: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    json(res, { connected: false, error: msg });
  }
}

async function handleObsSources(res: http.ServerResponse, pipeline: Pipeline): Promise<void> {
  const obs = pipeline.getObs();
  if (!obs) {
    json(res, { sources: [] });
    return;
  }
  try {
    const sources = await obs.getTextSources();
    json(res, { sources });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
}

async function handleWhisperVariants(res: http.ServerResponse): Promise<void> {
  const variants = getAvailableBinaryVariants();
  const recommended = await detectRecommendedVariant();
  const installed: Record<string, string | null> = {};
  for (const v of variants) {
    installed[v.id] = getInstalledBinary(v.id);
  }
  json(res, { variants, recommended, installed });
}

function handleWhisperModels(res: http.ServerResponse): void {
  const installed: Record<string, string | null> = {};
  for (const m of MODEL_REGISTRY) {
    installed[m.id] = getInstalledModel(m.id);
  }
  json(res, { models: MODEL_REGISTRY, installed });
}

const activeDownloads = new Map<string, AbortController>();
/** Track which resource IDs (variant/model) are currently downloading. */
const downloadingResources = new Set<string>();

async function handleDownloadBinary(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pipeline: Pipeline,
  sseClients: Set<http.ServerResponse>,
): Promise<void> {
  const body = await readBody(req, MAX_BODY_SIZE);
  let parsed: { variant?: string };
  try {
    parsed = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }
  if (!parsed.variant || typeof parsed.variant !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing variant field' }));
    return;
  }

  // Reject if already installed
  if (getInstalledBinary(parsed.variant)) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Binary already installed' }));
    return;
  }

  const resourceKey = `binary:${parsed.variant}`;
  if (downloadingResources.has(resourceKey)) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Already downloading this binary' }));
    return;
  }

  const id = `binary-${Date.now()}`;
  const ac = new AbortController();
  activeDownloads.set(id, ac);
  downloadingResources.add(resourceKey);

  json(res, { id, status: 'started' });

  // Run download in background
  console.log(`[Download] Binary ${parsed.variant} started (${id})`);
  downloadBinary(parsed.variant, (p: DownloadProgress) => {
    broadcast(sseClients, 'download-progress', { id, ...p });
  }, ac.signal).then((binaryPath) => {
    activeDownloads.delete(id);
    downloadingResources.delete(resourceKey);
    console.log(`[Download] Binary ${parsed.variant} complete: ${binaryPath}`);
    // Auto-save to config
    const config = pipeline.getConfig();
    config.whisper.binary = binaryPath;
    config.whisper.binary_variant = parsed.variant!;
    saveConfigToml(config, pipeline.getConfigPath());
    pipeline.updateWhisperConfig(config.whisper);
  }).catch((err) => {
    activeDownloads.delete(id);
    downloadingResources.delete(resourceKey);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Download] Binary ${parsed.variant} failed: ${msg}`);
    broadcast(sseClients, 'download-progress', {
      id, phase: 'error', percent: 0, bytesDownloaded: 0, bytesTotal: 0, label: msg,
    });
  });
}

async function handleDownloadModel(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pipeline: Pipeline,
  sseClients: Set<http.ServerResponse>,
): Promise<void> {
  const body = await readBody(req, MAX_BODY_SIZE);
  let parsed: { model?: string };
  try {
    parsed = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }
  if (!parsed.model || typeof parsed.model !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing model field' }));
    return;
  }

  // Reject if already installed
  if (getInstalledModel(parsed.model)) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Model already installed' }));
    return;
  }

  const resourceKey = `model:${parsed.model}`;
  if (downloadingResources.has(resourceKey)) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Already downloading this model' }));
    return;
  }

  const id = `model-${Date.now()}`;
  const ac = new AbortController();
  activeDownloads.set(id, ac);
  downloadingResources.add(resourceKey);

  json(res, { id, status: 'started' });

  console.log(`[Download] Model ${parsed.model} started (${id})`);
  downloadModel(parsed.model, (p: DownloadProgress) => {
    broadcast(sseClients, 'download-progress', { id, ...p });
  }, ac.signal).then((modelPath) => {
    activeDownloads.delete(id);
    downloadingResources.delete(resourceKey);
    console.log(`[Download] Model ${parsed.model} complete: ${modelPath}`);
    const config = pipeline.getConfig();
    config.whisper.model = modelPath;
    config.whisper.model_name = parsed.model!;
    saveConfigToml(config, pipeline.getConfigPath());
    pipeline.updateWhisperConfig(config.whisper);
  }).catch((err) => {
    activeDownloads.delete(id);
    downloadingResources.delete(resourceKey);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Download] Model ${parsed.model} failed: ${msg}`);
    broadcast(sseClients, 'download-progress', {
      id, phase: 'error', percent: 0, bytesDownloaded: 0, bytesTotal: 0, label: msg,
    });
  });
}

async function handleDownloadCancel(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await readBody(req, MAX_BODY_SIZE);
  let parsed: { id?: string };
  try {
    parsed = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }
  if (!parsed.id || typeof parsed.id !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing id field' }));
    return;
  }

  const ac = activeDownloads.get(parsed.id);
  if (!ac) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Download not found' }));
    return;
  }

  ac.abort();
  json(res, { cancelled: true });
}

function saveConfigToml(config: Config, configPath: string): string {
  const toml = configToToml(config);
  const localPath = getLocalConfigPath(configPath);
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, toml, 'utf-8');
  return localPath;
}

function handleSSE(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  clients: Set<http.ServerResponse>,
  pipeline: Pipeline,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const status = pipeline.getStatus();
  res.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`);

  // Replay buffered startup logs
  for (const msg of pipeline.getLogBuffer()) {
    res.write(`event: log\ndata: ${JSON.stringify({ message: msg, timestamp: Date.now() })}\n\n`);
  }

  clients.add(res);

  req.on('close', () => {
    clients.delete(res);
  });
}

function broadcast(clients: Set<http.ServerResponse>, event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch {
      clients.delete(client);
    }
  }
}

async function handleCapture(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pipeline: Pipeline,
): Promise<void> {
  const body = await readBody(req, MAX_BODY_SIZE);
  let parsed: { duration_ms?: number };
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = {};
  }
  const durationMs = parsed.duration_ms ?? 5000;

  try {
    const samples = await pipeline.captureAudio(Math.min(durationMs, 30000));
    const wav = encodeWav(samples, 16000);
    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Content-Disposition': 'attachment; filename="vban-capture.wav"',
      'Content-Length': wav.byteLength,
    });
    res.end(Buffer.from(wav));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
}

function readBody(req: http.IncomingMessage, maxSize = MAX_BODY_SIZE): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
