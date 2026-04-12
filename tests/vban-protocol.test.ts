import { describe, it, expect } from 'vitest';
import {
  parseVbanPacket,
  extractInt16Samples,
  VBAN_HEADER_SIZE,
  VBAN_SUB_AUDIO,
  VBAN_FMT_INT16,
  VBAN_FMT_INT24,
  VBAN_FMT_FLOAT32,
  VBAN_FMT_INT32,
  VBAN_SR_TABLE,
} from '../src/vban/protocol.js';

/** Build a minimal VBAN packet buffer. */
function buildVbanPacket(opts: {
  srIndex?: number;
  samplesPerFrame?: number;
  channels?: number;
  format?: number;
  streamName?: string;
  frameCounter?: number;
  audioSamples?: number[];
}): Buffer {
  const {
    srIndex = 3,          // 48000 Hz
    samplesPerFrame = 64,
    channels = 1,
    format = VBAN_FMT_INT16,
    streamName = 'test',
    frameCounter = 0,
    audioSamples = [],
  } = opts;

  const header = Buffer.alloc(VBAN_HEADER_SIZE);
  // Magic 'VBAN' as LE
  header.writeUInt32LE(0x4e414256, 0);
  // byte 4: sub-protocol (audio=0) | sr index
  header[4] = VBAN_SUB_AUDIO | (srIndex & 0x1f);
  // byte 5: samples per frame - 1
  header[5] = samplesPerFrame - 1;
  // byte 6: channels - 1
  header[6] = channels - 1;
  // byte 7: format
  header[7] = format;
  // bytes 8-23: stream name
  header.write(streamName, 8, 16, 'ascii');
  // bytes 24-27: frame counter
  header.writeUInt32LE(frameCounter, 24);

  // Audio payload
  let payload: Buffer;
  if (format === VBAN_FMT_INT24) {
    payload = Buffer.alloc(audioSamples.length * 3);
    audioSamples.forEach((s, i) => {
      const v = s < 0 ? s + 0x1000000 : s;
      payload[i * 3] = v & 0xff;
      payload[i * 3 + 1] = (v >> 8) & 0xff;
      payload[i * 3 + 2] = (v >> 16) & 0xff;
    });
  } else if (format === VBAN_FMT_INT32) {
    payload = Buffer.alloc(audioSamples.length * 4);
    audioSamples.forEach((s, i) => payload.writeInt32LE(s, i * 4));
  } else if (format === VBAN_FMT_FLOAT32) {
    payload = Buffer.alloc(audioSamples.length * 4);
    const floatBuf = new Float32Array(audioSamples);
    const bytes = new Uint8Array(floatBuf.buffer);
    bytes.forEach((b, i) => { payload[i] = b; });
  } else {
    // INT16 (default) and others
    payload = Buffer.alloc(audioSamples.length * 2);
    audioSamples.forEach((s, i) => payload.writeInt16LE(s, i * 2));
  }

  return Buffer.concat([header, payload]);
}

describe('parseVbanPacket', () => {
  it('parses a valid audio packet', () => {
    const buf = buildVbanPacket({
      srIndex: 3,
      samplesPerFrame: 64,
      channels: 2,
      streamName: 'subtitle',
      frameCounter: 42,
      audioSamples: [100, -200, 300, -400],
    });

    const pkt = parseVbanPacket(buf);
    expect(pkt).not.toBeNull();
    expect(pkt!.subProtocol).toBe(VBAN_SUB_AUDIO);
    expect(pkt!.sampleRate).toBe(48000);
    expect(pkt!.samplesPerFrame).toBe(64);
    expect(pkt!.channels).toBe(2);
    expect(pkt!.format).toBe(VBAN_FMT_INT16);
    expect(pkt!.streamName).toBe('subtitle');
    expect(pkt!.frameCounter).toBe(42);
    expect(pkt!.payload.length).toBe(8); // 4 samples * 2 bytes
  });

  it('returns null for buffer shorter than header', () => {
    expect(parseVbanPacket(Buffer.alloc(20))).toBeNull();
  });

  it('returns null for wrong magic', () => {
    const buf = buildVbanPacket({});
    buf.write('XBAN', 0, 4, 'ascii');
    expect(parseVbanPacket(buf)).toBeNull();
  });

  it('parses all sample rate indices', () => {
    for (let i = 0; i < VBAN_SR_TABLE.length; i++) {
      const buf = buildVbanPacket({ srIndex: i });
      const pkt = parseVbanPacket(buf);
      expect(pkt).not.toBeNull();
      expect(pkt!.sampleRate).toBe(VBAN_SR_TABLE[i]);
    }
  });

  it('returns null for out-of-range SR index', () => {
    const buf = buildVbanPacket({ srIndex: 31 });
    expect(parseVbanPacket(buf)).toBeNull();
  });

  it('handles stream name with null padding', () => {
    const buf = buildVbanPacket({ streamName: 'ab' });
    const pkt = parseVbanPacket(buf);
    expect(pkt!.streamName).toBe('ab');
  });

  it('handles max-length stream name (16 chars)', () => {
    const name = '1234567890abcdef';
    const buf = buildVbanPacket({ streamName: name });
    const pkt = parseVbanPacket(buf);
    expect(pkt!.streamName).toBe(name);
  });

  it('parses header-only packet (no audio)', () => {
    const buf = buildVbanPacket({ audioSamples: [] });
    const pkt = parseVbanPacket(buf);
    expect(pkt).not.toBeNull();
    expect(pkt!.payload.length).toBe(0);
  });
});

describe('extractInt16Samples', () => {
  it('extracts INT16 samples correctly', () => {
    const input = [0, 32767, -32768, 1234];
    const buf = buildVbanPacket({ audioSamples: input });
    const pkt = parseVbanPacket(buf)!;
    const samples = extractInt16Samples(pkt)!;

    expect(samples.length).toBe(4);
    expect(samples[0]).toBe(0);
    expect(samples[1]).toBe(32767);
    expect(samples[2]).toBe(-32768);
    expect(samples[3]).toBe(1234);
  });

  it('converts INT24 samples to INT16', () => {
    // 24-bit value 0x7F8000 → upper 16 bits = 0x7F80 = 32640
    const buf = buildVbanPacket({ format: VBAN_FMT_INT24, audioSamples: [0x7F8000, -0x800000] });
    const pkt = parseVbanPacket(buf)!;
    const samples = extractInt16Samples(pkt)!;
    expect(samples.length).toBe(2);
    expect(samples[0]).toBe(0x7F80);
    // -0x800000 → upper 16 bits = -0x8000 = -32768
    expect(samples[1]).toBe(-32768);
  });

  it('converts FLOAT32 samples to INT16', () => {
    const buf = buildVbanPacket({ format: VBAN_FMT_FLOAT32, audioSamples: [0.0, 1.0, -1.0, 0.5] });
    const pkt = parseVbanPacket(buf)!;
    const samples = extractInt16Samples(pkt)!;
    expect(samples.length).toBe(4);
    expect(samples[0]).toBe(0);
    expect(samples[1]).toBe(32767);
    expect(samples[2]).toBe(-32768);
    expect(Math.abs(samples[3]! - 16384)).toBeLessThan(2);
  });

  it('returns null for unknown format', () => {
    const buf = buildVbanPacket({ format: 0x0F, audioSamples: [100] });
    const pkt = parseVbanPacket(buf)!;
    expect(extractInt16Samples(pkt)).toBeNull();
  });
});
