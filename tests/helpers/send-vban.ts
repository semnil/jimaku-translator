import fs from 'node:fs';
import dgram from 'node:dgram';
import {
  VBAN_HEADER_SIZE,
  VBAN_SUB_AUDIO,
  VBAN_FMT_INT16,
  VBAN_SR_TABLE,
} from '../../src/vban/protocol.js';

const HOST = '127.0.0.1';
const SAMPLES_PER_FRAME = 256;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const FRAME_BYTES = SAMPLES_PER_FRAME * CHANNELS * BYTES_PER_SAMPLE;
const FRAME_INTERVAL_MS = (SAMPLES_PER_FRAME / 48000) * 1000;
const SR_INDEX_48K = VBAN_SR_TABLE.indexOf(48000);

function readWavPcm(filePath: string): Buffer {
  const buf = fs.readFileSync(filePath);
  let i = 12;
  while (i < buf.length - 8) {
    const id = buf.toString('ascii', i, i + 4);
    const sz = buf.readUInt32LE(i + 4);
    if (id === 'data') return buf.subarray(i + 8, i + 8 + sz);
    i += 8 + sz;
  }
  throw new Error(`data chunk not found in ${filePath}`);
}

function silence(ms: number): Buffer {
  const samples = Math.floor((ms / 1000) * 48000);
  return Buffer.alloc(samples * CHANNELS * BYTES_PER_SAMPLE);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface SendVbanOptions {
  port?: number;
  prePadMs?: number;
  gapMs?: number;
}

export async function sendVbanWavs(files: string[], opts: SendVbanOptions = {}): Promise<void> {
  const port = opts.port ?? 6980;
  const prePad = opts.prePadMs ?? 1500;
  const gap = opts.gapMs ?? 2500;

  const sock = dgram.createSocket('udp4');

  // One reusable packet buffer — header bytes are stable except for the frame
  // counter, so we only rewrite that field per send to avoid GC churn.
  const packet = Buffer.alloc(VBAN_HEADER_SIZE + FRAME_BYTES);
  packet.write('VBAN', 0, 'ascii');
  packet[4] = VBAN_SUB_AUDIO | SR_INDEX_48K;
  packet[5] = SAMPLES_PER_FRAME - 1;
  packet[6] = CHANNELS - 1;
  packet[7] = VBAN_FMT_INT16;
  packet.write('Stream1', 8, 'ascii');

  let counter = 0;
  const send = (): Promise<void> => new Promise((resolve) => {
    sock.send(packet, port, HOST, () => resolve());
  });

  async function sendBuffer(pcm: Buffer): Promise<void> {
    const total = Math.floor(pcm.length / FRAME_BYTES);
    for (let f = 0; f < total; f++) {
      pcm.copy(packet, VBAN_HEADER_SIZE, f * FRAME_BYTES, (f + 1) * FRAME_BYTES);
      packet.writeUInt32LE(counter++ >>> 0, 24);
      await send();
      if (f % 4 === 3) await sleep(FRAME_INTERVAL_MS * 4);
    }
  }

  try {
    await sendBuffer(silence(prePad));
    for (const f of files) {
      await sendBuffer(readWavPcm(f));
      await sendBuffer(silence(gap));
    }
    await sleep(500);
  } finally {
    sock.close();
  }
}
