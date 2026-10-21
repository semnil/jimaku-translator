import http from 'node:http';
import type net from 'node:net';
import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from '../src/server.js';
import type { Pipeline } from '../src/pipeline.js';

function stubPipeline() {
  const stub = new EventEmitter() as EventEmitter & Record<string, unknown>;
  stub.getStatus = () => ({});
  stub.getConfig = () => ({});
  stub.getConfigPath = () => '';
  stub.getLogBuffer = () => [];
  stub.getObs = () => null;
  stub.updateObsConfig = vi.fn();
  return stub;
}

interface Reply {
  status: number;
}

function send(
  port: number,
  opts: { method: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: opts.method,
      path: opts.path,
      headers: { host: `127.0.0.1:${port}`, ...opts.headers },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

describe('HTTP server request checks', () => {
  const pipeline = stubPipeline();
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = createServer({ pipeline: pipeline as unknown as Pipeline });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as net.AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const json = { 'Content-Type': 'application/json' };
  const cancelBody = JSON.stringify({ id: 'no-such-download' });

  it('serves a request whose Host names the server by 127.0.0.1', async () => {
    const res = await send(port, { method: 'GET', path: '/api/status' });
    expect(res.status).toBe(200);
  });

  it('serves a request whose Host names the server by localhost', async () => {
    const res = await send(port, { method: 'GET', path: '/api/status', headers: { host: `localhost:${port}` } });
    expect(res.status).toBe(200);
  });

  it('rejects a request whose Host names another server', async () => {
    const res = await send(port, { method: 'GET', path: '/api/status', headers: { host: `example.invalid:${port}` } });
    expect(res.status).toBe(403);
  });

  it('passes a POST from the page served by this server to its handler', async () => {
    const res = await send(port, {
      method: 'POST', path: '/api/whisper/download-cancel',
      headers: { ...json, origin: `http://127.0.0.1:${port}` }, body: cancelBody,
    });
    expect(res.status).toBe(404);
  });

  it('passes a POST without an Origin header to its handler', async () => {
    const res = await send(port, { method: 'POST', path: '/api/whisper/download-cancel', headers: json, body: cancelBody });
    expect(res.status).toBe(404);
  });

  it('rejects a POST from a non-loopback origin', async () => {
    const res = await send(port, {
      method: 'POST', path: '/api/whisper/download-cancel',
      headers: { ...json, origin: 'https://example.invalid' }, body: cancelBody,
    });
    expect(res.status).toBe(403);
  });

  it('rejects a POST from an opaque (null) origin', async () => {
    const res = await send(port, {
      method: 'POST', path: '/api/whisper/download-cancel',
      headers: { ...json, origin: 'null' }, body: cancelBody,
    });
    expect(res.status).toBe(403);
  });

  it('rejects a POST body that is not declared as JSON', async () => {
    const res = await send(port, {
      method: 'POST', path: '/api/whisper/download-cancel',
      headers: { 'Content-Type': 'text/plain' }, body: cancelBody,
    });
    expect(res.status).toBe(415);
  });

  it('passes a POST without a body and without a Content-Type to its handler', async () => {
    const res = await send(port, { method: 'POST', path: '/api/obs/reconnect' });
    // The stub pipeline has no OBS client, so the handler answers 400.
    expect(res.status).toBe(400);
  });

  it('does not apply settings from a rejected POST /api/config', async () => {
    const res = await send(port, {
      method: 'POST', path: '/api/config',
      headers: { ...json, origin: 'https://example.invalid' }, body: '{}',
    });
    expect(res.status).toBe(403);
    expect(pipeline.updateObsConfig).not.toHaveBeenCalled();
  });
});
