import { describe, it, expect } from 'vitest';
import { downmixToMono, resampleTo16k } from '../src/audio/resample.js';
import { RingBuffer } from '../src/audio/ring-buffer.js';
import { encodeWav } from '../src/audio/wav.js';

describe('downmixToMono', () => {
  it('returns input unchanged for mono', () => {
    const mono = new Int16Array([100, 200, 300]);
    expect(downmixToMono(mono, 1)).toEqual(mono);
  });

  it('averages stereo channels', () => {
    // L=100 R=200, L=0 R=-100
    const stereo = new Int16Array([100, 200, 0, -100]);
    const result = downmixToMono(stereo, 2);
    expect(result.length).toBe(2);
    expect(result[0]).toBe(150);
    expect(result[1]).toBe(-50);
  });
});

describe('resampleTo16k', () => {
  it('returns input unchanged for 16kHz', () => {
    const data = new Int16Array([1, 2, 3, 4, 5]);
    expect(resampleTo16k(data, 16000)).toEqual(data);
  });

  it('downsamples 48kHz to 16kHz (3:1)', () => {
    // 30 samples at 48kHz → 8 samples at 16kHz (FIR eats edges)
    const src = new Int16Array(30);
    // Fill with a constant to verify no distortion on DC
    src.fill(1000);
    const result = resampleTo16k(src, 48000);
    expect(result.length).toBeGreaterThan(0);
    // DC signal should pass through approximately unchanged
    for (let i = 0; i < result.length; i++) {
      expect(Math.abs(result[i]! - 1000)).toBeLessThan(2);
    }
  });

  it('downsamples 32kHz to 16kHz (2:1)', () => {
    const src = new Int16Array([100, 200, 300, 400, 500, 600]);
    const result = resampleTo16k(src, 32000);
    expect(result.length).toBe(3);
    // Simple averaging: (100+200)/2=150, (300+400)/2=350, (500+600)/2=550
    expect(result[0]).toBe(150);
    expect(result[1]).toBe(350);
    expect(result[2]).toBe(550);
  });

  it('throws for non-integer-multiple rates', () => {
    expect(() => resampleTo16k(new Int16Array(100), 44100)).toThrow();
  });
});

describe('RingBuffer', () => {
  it('writes and reads basic data', () => {
    const rb = new RingBuffer(100);
    rb.write(new Int16Array([10, 20, 30]));
    expect(rb.length).toBe(3);
    const out = rb.readLast(3);
    expect(Array.from(out)).toEqual([10, 20, 30]);
  });

  it('handles wrap-around correctly', () => {
    const rb = new RingBuffer(4);
    rb.write(new Int16Array([1, 2, 3]));
    rb.write(new Int16Array([4, 5])); // wraps: buf = [5, 2, 3, 4], newest = 4,5
    expect(rb.length).toBe(4); // capacity is 4
    const out = rb.readLast(4);
    expect(Array.from(out)).toEqual([2, 3, 4, 5]);
  });

  it('readLast returns fewer if not enough data', () => {
    const rb = new RingBuffer(100);
    rb.write(new Int16Array([1, 2]));
    const out = rb.readLast(10);
    expect(out.length).toBe(2);
  });

  it('discard removes oldest samples', () => {
    const rb = new RingBuffer(100);
    rb.write(new Int16Array([1, 2, 3, 4, 5]));
    rb.discard(3);
    expect(rb.length).toBe(2);
  });

  it('clear empties the buffer', () => {
    const rb = new RingBuffer(100);
    rb.write(new Int16Array([1, 2, 3]));
    rb.clear();
    expect(rb.length).toBe(0);
    expect(rb.readLast(10).length).toBe(0);
  });

  it('handles write larger than capacity', () => {
    const rb = new RingBuffer(3);
    rb.write(new Int16Array([1, 2, 3, 4, 5]));
    expect(rb.length).toBe(3);
    expect(Array.from(rb.readLast(3))).toEqual([3, 4, 5]);
  });
});

describe('encodeWav', () => {
  it('produces valid WAV header', () => {
    const samples = new Int16Array([0, 32767, -32768]);
    const wav = encodeWav(samples, 16000);
    const view = new DataView(wav);

    // RIFF header
    expect(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)))
      .toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(wav.byteLength - 8);

    // WAVE
    expect(String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11)))
      .toBe('WAVE');

    // fmt chunk
    expect(view.getUint16(20, true)).toBe(1);      // PCM
    expect(view.getUint16(22, true)).toBe(1);      // mono
    expect(view.getUint32(24, true)).toBe(16000);  // sample rate
    expect(view.getUint16(34, true)).toBe(16);     // bits per sample

    // data chunk size
    expect(view.getUint32(40, true)).toBe(6);      // 3 samples * 2 bytes
  });

  it('encodes samples correctly', () => {
    const samples = new Int16Array([1234, -5678]);
    const wav = encodeWav(samples, 16000);
    const view = new DataView(wav);
    expect(view.getInt16(44, true)).toBe(1234);
    expect(view.getInt16(46, true)).toBe(-5678);
  });
});
