import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, afterEach } from 'vitest';
import type { WebSocketServer as WebSocketServerType, WebSocket } from 'ws';
import { ObsClient } from '../src/obs/client.js';

// The mock server speaks through the same ws and msgpack packages obs-websocket-js uses.
const obsRequire = createRequire(createRequire(__filename).resolve('obs-websocket-js'));
const { WebSocketServer } = obsRequire('ws') as typeof import('ws');
const { encode, decode } = obsRequire('@msgpack/msgpack') as typeof import('@msgpack/msgpack');

type Answer = 'respond' | 'close-before-response';

interface MockObs {
  server: WebSocketServerType;
  port: number;
  requests: string[];
}

/** An obs-websocket v5 server (msgpack) that answers every request, or closes the connection on receiving one. */
function startMockObs(answer: Answer): Promise<MockObs> {
  return new Promise((resolve) => {
    const requests: string[] = [];
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, handleProtocols: () => 'obswebsocket.msgpack' }, () => {
      resolve({ server, port: (server.address() as AddressInfo).port, requests });
    });
    server.on('connection', (sock: WebSocket) => {
      const send = (msg: unknown) => sock.send(encode(msg));
      send({ op: 0, d: { obsWebSocketVersion: '5.5.0', rpcVersion: 1 } });
      sock.on('message', (raw: Buffer) => {
        const msg = decode(raw) as { op: number; d: { requestType: string; requestId: string } };
        if (msg.op === 1) send({ op: 2, d: { negotiatedRpcVersion: 1 } });
        if (msg.op !== 6) return;
        requests.push(msg.d.requestType);
        if (answer === 'close-before-response') {
          sock.close(1001, 'OBS is quitting');
          return;
        }
        const responseData = msg.d.requestType === 'GetInputList' ? { inputs: [{ inputName: 'JA' }] } : undefined;
        send({ op: 7, d: { requestType: msg.d.requestType, requestId: msg.d.requestId, requestStatus: { result: true, code: 100 }, responseData } });
      });
    });
  });
}

describe('ObsClient requests', () => {
  let mock: MockObs | null = null;
  let obs: ObsClient | null = null;

  async function connect(answer: Answer): Promise<ObsClient> {
    mock = await startMockObs(answer);
    obs = new ObsClient({ host: '127.0.0.1', port: mock.port, password: '', sourceJa: 'JA', sourceEn: 'EN', reconnectMs: 0 });
    obs.on('error', () => {});
    await obs.connect();
    return obs;
  }

  afterEach(async () => {
    await obs?.disconnect();
    obs = null;
    if (mock) {
      for (const client of mock.server.clients) client.terminate();
      await new Promise<void>((resolve) => mock!.server.close(() => resolve()));
      mock = null;
    }
  });

  it('clears the subtitle when OBS answers', async () => {
    const client = await connect('respond');
    await client.clearSubtitle();
    expect(mock!.requests).toEqual(['SetInputSettings', 'SetInputSettings']);
  });

  it('finishes clearing when OBS closes the connection before answering', async () => {
    const client = await connect('close-before-response');
    await client.clearSubtitle();
    expect(mock!.requests.length).toBeGreaterThan(0);
    expect(client.isConnected()).toBe(false);
  });

  it('rejects a source listing when OBS closes the connection before answering', async () => {
    const client = await connect('close-before-response');
    await expect(client.getTextSources()).rejects.toThrow('OBS is quitting');
  });

  it('leaves no close listener behind once OBS has answered', async () => {
    const client = await connect('respond');
    const ws = (client as unknown as { ws: { listenerCount(event: string): number } }).ws;
    const before = ws.listenerCount('ConnectionClosed');
    await client.clearSubtitle();
    await client.getTextSources();
    expect(ws.listenerCount('ConnectionClosed')).toBe(before);
  });
});
