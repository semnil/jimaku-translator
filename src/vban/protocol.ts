/**
 * VBAN protocol definitions.
 * Spec: https://vb-audio.com/Voicemeeter/VBANProtocol_Specifications.pdf
 *
 * Packet layout (28-byte header + PCM payload):
 *   [0..3]   'VBAN' magic
 *   [4]      sub-protocol (bits 7-5) | sample-rate index (bits 4-0)
 *   [5]      samples per frame - 1
 *   [6]      channels - 1
 *   [7]      data format (0=uint8, 1=int16, 2=int24, 3=int32, 4=float32, 5=float64, 6=int12, 7=int10)
 *   [8..23]  stream name (null-padded ASCII)
 *   [24..27] frame counter (uint32 LE)
 *   [28..]   PCM audio data
 */

export const VBAN_HEADER_SIZE = 28;
export const VBAN_MAGIC = 0x4e414256; // 'VBAN' as LE uint32

/** Sub-protocol types (bits 7-5 of byte 4). */
export const VBAN_SUB_AUDIO = 0x00;
export const VBAN_SUB_SERIAL = 0x20;
export const VBAN_SUB_TEXT = 0x40;
export const VBAN_SUB_SERVICE = 0x60;

/** Sample rate lookup table (index 0-20). */
export const VBAN_SR_TABLE: readonly number[] = [
  6000, 12000, 24000, 48000, 96000, 192000, 384000,
  8000, 16000, 32000, 64000, 128000, 256000, 512000,
  11025, 22050, 44100, 88200, 176400, 352800, 705600,
] as const;

/** Data format codes (byte 7). */
export const VBAN_FMT_UINT8 = 0x00;
export const VBAN_FMT_INT16 = 0x01;
export const VBAN_FMT_INT24 = 0x02;
export const VBAN_FMT_INT32 = 0x03;
export const VBAN_FMT_FLOAT32 = 0x04;
export const VBAN_FMT_FLOAT64 = 0x05;

/** Bytes per sample for each format. */
export const VBAN_FMT_BYTES: Record<number, number> = {
  [VBAN_FMT_UINT8]: 1,
  [VBAN_FMT_INT16]: 2,
  [VBAN_FMT_INT24]: 3,
  [VBAN_FMT_INT32]: 4,
  [VBAN_FMT_FLOAT32]: 4,
  [VBAN_FMT_FLOAT64]: 8,
};

export interface VbanHeader {
  /** Sub-protocol (upper 3 bits of byte 4). */
  subProtocol: number;
  /** Sample rate in Hz. */
  sampleRate: number;
  /** Number of samples per frame (1-256). */
  samplesPerFrame: number;
  /** Number of channels (1-256). */
  channels: number;
  /** Data format code. */
  format: number;
  /** Stream name (up to 16 chars). */
  streamName: string;
  /** Frame counter. */
  frameCounter: number;
}

export interface VbanPacket extends VbanHeader {
  /** Raw audio payload (after header). */
  payload: Buffer;
}

/**
 * Parse a VBAN packet from a UDP datagram.
 * Returns null if the buffer is too short or the magic doesn't match.
 */
export function parseVbanPacket(buf: Buffer): VbanPacket | null {
  if (buf.length < VBAN_HEADER_SIZE) return null;

  const magic = buf.readUInt32LE(0);
  if (magic !== VBAN_MAGIC) return null;

  const byte4 = buf[4]!;
  const subProtocol = byte4 & 0xe0;
  const srIndex = byte4 & 0x1f;

  const sampleRate = VBAN_SR_TABLE[srIndex];
  if (sampleRate === undefined) return null;

  const samplesPerFrame = buf[5]! + 1;
  const channels = buf[6]! + 1;
  const format = buf[7]!;

  // stream name: bytes 8-23, null-terminated ASCII
  let nameEnd = 8;
  while (nameEnd < 24 && buf[nameEnd] !== 0) nameEnd++;
  const streamName = buf.toString('ascii', 8, nameEnd);

  const frameCounter = buf.readUInt32LE(24);
  const payload = buf.subarray(VBAN_HEADER_SIZE);

  return {
    subProtocol,
    sampleRate,
    samplesPerFrame,
    channels,
    format,
    streamName,
    frameCounter,
    payload,
  };
}

/**
 * Extract 16-bit PCM samples from a VBAN audio packet payload.
 * Converts all supported formats to INT16.
 */
export function extractInt16Samples(pkt: VbanPacket): Int16Array | null {
  if (pkt.format === VBAN_FMT_UINT8) {
    const totalSamples = pkt.payload.length;
    const out = new Int16Array(totalSamples);
    for (let i = 0; i < totalSamples; i++) {
      // 0-255 → -32768..+32512 (128 = silence)
      out[i] = (pkt.payload[i]! - 128) << 8;
    }
    return out;
  }

  if (pkt.format === VBAN_FMT_INT16) {
    const bytesPerSample = 2;
    const totalSamples = Math.floor(pkt.payload.length / bytesPerSample);
    const aligned = new ArrayBuffer(totalSamples * bytesPerSample);
    new Uint8Array(aligned).set(pkt.payload.subarray(0, totalSamples * bytesPerSample));
    return new Int16Array(aligned);
  }

  if (pkt.format === VBAN_FMT_INT24) {
    const totalSamples = Math.floor(pkt.payload.length / 3);
    const out = new Int16Array(totalSamples);
    for (let i = 0; i < totalSamples; i++) {
      const offset = i * 3;
      // 24-bit LE signed: reconstruct full value then scale to INT16
      let val = pkt.payload[offset]! | (pkt.payload[offset + 1]! << 8) | (pkt.payload[offset + 2]! << 16);
      if (val & 0x800000) val |= ~0xFFFFFF; // sign extend to 32-bit
      // Scale: divide by 256 (24-bit range → 16-bit range)
      out[i] = val >> 8;
    }
    return out;
  }

  if (pkt.format === VBAN_FMT_INT32) {
    const totalSamples = Math.floor(pkt.payload.length / 4);
    const aligned = new ArrayBuffer(totalSamples * 4);
    new Uint8Array(aligned).set(pkt.payload.subarray(0, totalSamples * 4));
    const ints = new Int32Array(aligned);
    const out = new Int16Array(totalSamples);
    for (let i = 0; i < totalSamples; i++) {
      // Take upper 16 bits
      out[i] = ints[i]! >> 16;
    }
    return out;
  }

  if (pkt.format === VBAN_FMT_FLOAT32) {
    const totalSamples = Math.floor(pkt.payload.length / 4);
    const aligned = new ArrayBuffer(totalSamples * 4);
    new Uint8Array(aligned).set(pkt.payload.subarray(0, totalSamples * 4));
    const floats = new Float32Array(aligned);
    const out = new Int16Array(totalSamples);
    for (let i = 0; i < totalSamples; i++) {
      const clamped = Math.max(-1, Math.min(1, floats[i]!));
      out[i] = clamped < 0 ? clamped * 32768 : clamped * 32767;
    }
    return out;
  }

  if (pkt.format === VBAN_FMT_FLOAT64) {
    const totalSamples = Math.floor(pkt.payload.length / 8);
    const aligned = new ArrayBuffer(totalSamples * 8);
    new Uint8Array(aligned).set(pkt.payload.subarray(0, totalSamples * 8));
    const doubles = new Float64Array(aligned);
    const out = new Int16Array(totalSamples);
    for (let i = 0; i < totalSamples; i++) {
      const clamped = Math.max(-1, Math.min(1, doubles[i]!));
      out[i] = clamped < 0 ? clamped * 32768 : clamped * 32767;
    }
    return out;
  }

  return null;
}
