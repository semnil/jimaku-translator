import fs from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { createServer, type ServerOptions } from '../src/server.js';
import type { Pipeline } from '../src/pipeline.js';
import { UpdateNotOfferedError } from '../src/update-controller.js';

const packageVersion = (JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8')) as { version: string }).version;

function baseConfig(): Config {
  return {
    vban: { port: 6980, stream_name: '' },
    obs: { host: '127.0.0.1', port: 4455, password: '', source_ja: '', source_en: '', closed_caption: false, cc_language: 'en' },
    whisper: { server: 'http://127.0.0.1:8080', binary: '', model: '', binary_variant: '', model_name: '', threads: undefined },
    subtitle: { clear_delay: 6.0, chars_per_line: 0 },
    vad: { threshold: 0.5, min_speech_ms: 500, max_speech_ms: 10000 },
    audio: {
      rms_gate_db: -60, normalize_target_dbfs: -6, adaptive_gate_enabled: false,
      adaptive_gate_margin_db: 6, adaptive_gate_window_sec: 10, adaptive_gate_max_db: -30,
    },
    ui: { language: '', show_vad_debug: false },
    update: { check_at_launch: true },
  };
}

function stubPipeline(config: Config, configPath: string) {
  const stub = new EventEmitter() as EventEmitter & Record<string, unknown>;
  stub.getStatus = () => ({});
  stub.getConfig = () => config;
  stub.getConfigPath = () => configPath;
  stub.getLogBuffer = () => [];
  stub.getObs = () => null;
  stub.stop = vi.fn(async () => {});
  for (const name of [
    'updateObsConfig', 'updateWhisperConfig', 'updateSubtitleConfig', 'updateVadConfig',
    'updateAudioConfig', 'updateVbanConfig', 'updateUiConfig',
  ]) {
    stub[name] = vi.fn();
  }
  return stub as unknown as Pipeline;
}

function fakeController() {
  const restartErrorListeners: Array<(message: string) => void> = [];
  const controller = {
    check: vi.fn(async (): Promise<string | null> => '9.9.9'),
    download: vi.fn(async (_version: string): Promise<void> => {}),
    restart: vi.fn(),
    onRestartError: vi.fn((listener: (message: string) => void) => { restartErrorListeners.push(listener); }),
    raiseRestartError(message: string) {
      for (const listener of restartErrorListeners) listener(message);
    },
  };
  return controller;
}

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

function send(port: number, method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers: {
        host: `127.0.0.1:${port}`,
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) as Record<string, unknown> : {} });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** Resolves with the data of the first SSE event of that name. */
function nextSseEvent(port: number, event: string): { opened: Promise<void>; data: Promise<unknown>; close: () => void } {
  let req: http.ClientRequest;
  let markOpened: () => void;
  const opened = new Promise<void>((resolve) => { markOpened = resolve; });
  const data = new Promise<unknown>((resolve, reject) => {
    req = http.request({
      host: '127.0.0.1', port, method: 'GET', path: '/api/events', headers: { host: `127.0.0.1:${port}` },
    }, (res) => {
      markOpened();
      let buf = '';
      res.on('data', (c: Buffer) => {
        buf += c.toString('utf-8');
        for (const block of buf.split('\n\n')) {
          const lines = block.split('\n');
          if (lines[0] === `event: ${event}` && lines[1]?.startsWith('data: ')) {
            resolve(JSON.parse(lines[1].slice('data: '.length)));
          }
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
  return { opened, data, close: () => req.destroy() };
}

describe('update endpoints', () => {
  let tmpDir: string;
  let config: Config;
  let server: http.Server;
  let port: number;
  const savedLocalDir = process.env.VBAN_LOCAL_CONFIG_DIR;

  async function start(opts: Partial<ServerOptions>): Promise<void> {
    server = createServer({ pipeline: stubPipeline(config, path.join(tmpDir, 'config.toml')), ...opts });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as net.AddressInfo).port;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jimaku-update-'));
    process.env.VBAN_LOCAL_CONFIG_DIR = tmpDir;
    config = baseConfig();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (savedLocalDir === undefined) delete process.env.VBAN_LOCAL_CONFIG_DIR;
    else process.env.VBAN_LOCAL_CONFIG_DIR = savedLocalDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('without an updater (CLI mode, unpackaged app)', () => {
    it('reports the package version and that updates are unsupported', async () => {
      await start({});
      const res = await send(port, 'GET', '/api/update/status');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ current: packageVersion, supported: false, launch_check: true, launch_pending: false });
    });

    it('refuses a check', async () => {
      await start({});
      const res = await send(port, 'POST', '/api/update/check', {});
      expect(res.status).toBe(409);
    });

    it('refuses an install', async () => {
      await start({});
      const res = await send(port, 'POST', '/api/update/install', { version: '9.9.9' });
      expect(res.status).toBe(409);
    });
  });

  describe('status', () => {
    it('reports the version passed in and a pending launch check', async () => {
      await start({ updater: fakeController(), version: '1.2.3' });
      const res = await send(port, 'GET', '/api/update/status');
      expect(res.body).toEqual({ current: '1.2.3', supported: true, launch_check: true, launch_pending: true });
    });

    it('reports no pending launch check while the setting is off', async () => {
      config.update.check_at_launch = false;
      await start({ updater: fakeController() });
      const res = await send(port, 'GET', '/api/update/status');
      expect(res.body.launch_check).toBe(false);
      expect(res.body.launch_pending).toBe(false);
    });
  });

  describe('settings', () => {
    it('saves "Check at launch" to config.local.toml', async () => {
      await start({ updater: fakeController() });
      const res = await send(port, 'POST', '/api/update/settings', { launch_check: false });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ launch_check: false });
      expect(fs.readFileSync(path.join(tmpDir, 'config.local.toml'), 'utf-8')).toMatch(/^\[update\]\ncheck_at_launch = false$/m);
      const status = await send(port, 'GET', '/api/update/status');
      expect(status.body.launch_check).toBe(false);
      expect(status.body.launch_pending).toBe(false);
    });

    it('rejects a value that is not a boolean', async () => {
      await start({ updater: fakeController() });
      const res = await send(port, 'POST', '/api/update/settings', { launch_check: 'no' });
      expect(res.status).toBe(400);
      expect(config.update.check_at_launch).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'config.local.toml'))).toBe(false);
    });

    it('rejects a body that is not a JSON object', async () => {
      await start({ updater: fakeController() });
      const res = await send(port, 'POST', '/api/update/settings', [true]);
      expect(res.status).toBe(400);
    });

    it('keeps the previous value when the file cannot be written', async () => {
      await start({ updater: fakeController() });
      fs.mkdirSync(path.join(tmpDir, 'config.local.toml'));
      const res = await send(port, 'POST', '/api/update/settings', { launch_check: false });
      expect(res.status).toBe(500);
      expect(config.update.check_at_launch).toBe(true);
    });

    it('is checked like the other endpoints for a cross-origin POST', async () => {
      await start({ updater: fakeController() });
      const res = await send(port, 'POST', '/api/update/settings', { launch_check: false }, { origin: 'https://example.invalid' });
      expect(res.status).toBe(403);
      expect(config.update.check_at_launch).toBe(true);
    });

    it('is not changed by a POST /api/config that carries another value', async () => {
      await start({ updater: fakeController() });
      const posted = { ...baseConfig(), update: { check_at_launch: false } };
      const res = await send(port, 'POST', '/api/config', posted);
      expect(res.status).toBe(200);
      expect(config.update.check_at_launch).toBe(true);
      expect(fs.readFileSync(path.join(tmpDir, 'config.local.toml'), 'utf-8')).toMatch(/^check_at_launch = true$/m);
    });

    it('is kept by a POST /api/config from the form, which has no update section', async () => {
      config.update.check_at_launch = false;
      await start({ updater: fakeController() });
      const { update: _omitted, ...posted } = baseConfig();
      const res = await send(port, 'POST', '/api/config', posted);
      expect(res.status).toBe(200);
      expect(fs.readFileSync(path.join(tmpDir, 'config.local.toml'), 'utf-8')).toMatch(/^check_at_launch = false$/m);
    });
  });

  describe('check', () => {
    it('answers the version the updater offers', async () => {
      await start({ updater: fakeController() });
      const res = await send(port, 'POST', '/api/update/check');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ available: true, version: '9.9.9' });
    });

    it('answers that the app is up to date', async () => {
      const controller = fakeController();
      controller.check.mockResolvedValue(null);
      await start({ updater: controller });
      const res = await send(port, 'POST', '/api/update/check', {});
      expect(res.body).toEqual({ available: false });
    });

    it('answers 502 with the message when the check fails', async () => {
      const controller = fakeController();
      controller.check.mockRejectedValue(new Error('HttpError: 404'));
      await start({ updater: controller });
      const res = await send(port, 'POST', '/api/update/check', {});
      expect(res.status).toBe(502);
      expect(res.body.error).toBe('HttpError: 404');
    });

    it('runs the launch check once per process', async () => {
      const controller = fakeController();
      await start({ updater: controller });
      expect((await send(port, 'POST', '/api/update/check', { launch: true })).status).toBe(200);
      expect((await send(port, 'GET', '/api/update/status')).body.launch_pending).toBe(false);
      expect((await send(port, 'POST', '/api/update/check', { launch: true })).status).toBe(409);
      expect(controller.check).toHaveBeenCalledTimes(1);
      expect((await send(port, 'POST', '/api/update/check', {})).status).toBe(200);
    });

    it('refuses the launch check while the setting is off', async () => {
      config.update.check_at_launch = false;
      const controller = fakeController();
      await start({ updater: controller });
      const res = await send(port, 'POST', '/api/update/check', { launch: true });
      expect(res.status).toBe(409);
      expect(controller.check).not.toHaveBeenCalled();
    });

    it('rejects a launch field that is not a boolean', async () => {
      await start({ updater: fakeController() });
      const res = await send(port, 'POST', '/api/update/check', { launch: 'yes' });
      expect(res.status).toBe(400);
    });
  });

  describe('install', () => {
    it('downloads the version, answers, then restarts', async () => {
      const controller = fakeController();
      await start({ updater: controller });
      const res = await send(port, 'POST', '/api/update/install', { version: '9.9.9' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ restarting: true });
      expect(controller.download).toHaveBeenCalledWith('9.9.9');
      await vi.waitFor(() => expect(controller.restart).toHaveBeenCalledTimes(1));
    });

    it('stops the pipeline before restarting', async () => {
      const controller = fakeController();
      const pipeline = stubPipeline(config, path.join(tmpDir, 'config.toml'));
      let finishStop!: () => void;
      (pipeline.stop as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise<void>((resolve) => { finishStop = resolve; }));
      await start({ updater: controller, pipeline });
      expect((await send(port, 'POST', '/api/update/install', { version: '9.9.9' })).status).toBe(200);
      await vi.waitFor(() => expect(pipeline.stop).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(controller.restart).not.toHaveBeenCalled();
      finishStop();
      await vi.waitFor(() => expect(controller.restart).toHaveBeenCalledTimes(1));
    });

    it('restarts even when stopping the pipeline fails', async () => {
      const controller = fakeController();
      const pipeline = stubPipeline(config, path.join(tmpDir, 'config.toml'));
      (pipeline.stop as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('OBS disconnect failed'));
      await start({ updater: controller, pipeline });
      await send(port, 'POST', '/api/update/install', { version: '9.9.9' });
      await vi.waitFor(() => expect(controller.restart).toHaveBeenCalledTimes(1));
      expect(console.error).toHaveBeenCalledWith('[updater] pipeline stop before restart failed: OBS disconnect failed');
    });

    it('rejects a missing version', async () => {
      const controller = fakeController();
      await start({ updater: controller });
      const res = await send(port, 'POST', '/api/update/install', {});
      expect(res.status).toBe(400);
      expect(controller.download).not.toHaveBeenCalled();
    });

    it('answers 409 for a version the last check did not offer', async () => {
      const controller = fakeController();
      controller.download.mockRejectedValue(new UpdateNotOfferedError('Version 9.9.8 was not offered by the last check'));
      await start({ updater: controller });
      const res = await send(port, 'POST', '/api/update/install', { version: '9.9.8' });
      expect(res.status).toBe(409);
      expect(controller.restart).not.toHaveBeenCalled();
    });

    it('answers 500 when the download fails and accepts another install afterwards', async () => {
      const controller = fakeController();
      controller.download.mockRejectedValueOnce(new Error('sha512 checksum mismatch'));
      await start({ updater: controller });
      const failed = await send(port, 'POST', '/api/update/install', { version: '9.9.9' });
      expect(failed.status).toBe(500);
      expect(failed.body.error).toBe('sha512 checksum mismatch');
      expect(controller.restart).not.toHaveBeenCalled();
      const retried = await send(port, 'POST', '/api/update/install', { version: '9.9.9' });
      expect(retried.status).toBe(200);
    });

    it('refuses a second install while one is in progress', async () => {
      const controller = fakeController();
      let finishDownload!: () => void;
      controller.download.mockImplementationOnce(() => new Promise<void>((resolve) => { finishDownload = resolve; }));
      await start({ updater: controller });
      const first = send(port, 'POST', '/api/update/install', { version: '9.9.9' });
      await vi.waitFor(() => expect(controller.download).toHaveBeenCalledTimes(1));
      const second = await send(port, 'POST', '/api/update/install', { version: '9.9.9' });
      expect(second.status).toBe(409);
      finishDownload();
      expect((await first).status).toBe(200);
    });

    it('restarts when the page has gone away while the download ran', async () => {
      const controller = fakeController();
      let finishDownload!: () => void;
      controller.download.mockImplementationOnce(() => new Promise<void>((resolve) => { finishDownload = resolve; }));
      await start({ updater: controller });
      const req = http.request({
        host: '127.0.0.1', port, method: 'POST', path: '/api/update/install',
        headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' },
      });
      req.on('error', () => {});
      req.end(JSON.stringify({ version: '9.9.9' }));
      await vi.waitFor(() => expect(controller.download).toHaveBeenCalledTimes(1));
      req.destroy();
      await new Promise((resolve) => setTimeout(resolve, 50));
      finishDownload();
      await vi.waitFor(() => expect(controller.restart).toHaveBeenCalledTimes(1));
    });

    it('sends a restart error to the page and accepts another install afterwards', async () => {
      const controller = fakeController();
      await start({ updater: controller });
      const sse = nextSseEvent(port, 'update-error');
      await sse.opened;
      await send(port, 'POST', '/api/update/install', { version: '9.9.9' });
      await vi.waitFor(() => expect(controller.restart).toHaveBeenCalledTimes(1));
      controller.raiseRestartError('Squirrel.Mac: code signature invalid');
      await expect(sse.data).resolves.toEqual({ message: 'Squirrel.Mac: code signature invalid' });
      sse.close();
      expect((await send(port, 'POST', '/api/update/install', { version: '9.9.9' })).status).toBe(200);
    });
  });
});
