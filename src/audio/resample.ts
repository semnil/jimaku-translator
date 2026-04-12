/**
 * Downsample INT16 PCM audio from a source rate to 16kHz mono.
 *
 * For 48kHz→16kHz (3:1 ratio), applies a simple FIR low-pass filter
 * before decimation to prevent aliasing.
 */

/**
 * Downmix interleaved multi-channel INT16 to mono by averaging.
 */
export function downmixToMono(samples: Int16Array, channels: number): Int16Array {
  if (channels === 1) return samples;

  const frames = Math.floor(samples.length / channels);
  const mono = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let ch = 0; ch < channels; ch++) {
      sum += samples[i * channels + ch]!;
    }
    mono[i] = Math.round(sum / channels);
  }
  return mono;
}

/**
 * Simple FIR low-pass + decimate for integer ratio downsampling.
 *
 * For ratio=3 (48k→16k), uses a 7-tap windowed sinc filter
 * with cutoff at π/3 (Nyquist of target rate).
 */

// Pre-computed 7-tap FIR for 3:1 decimation (cutoff = π/3, Hamming window)
// h[n] = sinc((n-3)/3) * hamming(n), normalized
const FIR_3X: readonly number[] = (() => {
  const N = 7;
  const M = (N - 1) / 2; // 3
  const ratio = 3;
  const h: number[] = [];
  let sum = 0;
  for (let n = 0; n < N; n++) {
    const x = (n - M) / ratio;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const hamming = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (N - 1));
    const v = sinc * hamming;
    h.push(v);
    sum += v;
  }
  // Normalize
  return h.map(v => v / sum);
})();

/**
 * Resample INT16 mono audio from srcRate to 16000 Hz.
 * Currently supports srcRate that is an integer multiple of 16000.
 */
export function resampleTo16k(samples: Int16Array, srcRate: number): Int16Array {
  if (srcRate === 16000) return samples;

  if (srcRate % 16000 !== 0) {
    throw new Error(
      `Unsupported sample rate ${srcRate}: must be an integer multiple of 16000`
    );
  }

  const ratio = srcRate / 16000;

  if (ratio === 3) {
    return decimateWithFir(samples, 3, FIR_3X);
  }

  // Generic integer-ratio decimation with a simple averaging filter
  return decimateSimple(samples, ratio);
}

function decimateWithFir(
  samples: Int16Array,
  ratio: number,
  fir: readonly number[],
): Int16Array {
  const halfOrder = (fir.length - 1) / 2;
  const outLen = Math.floor((samples.length - fir.length + 1) / ratio);
  if (outLen <= 0) return new Int16Array(0);

  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const center = i * ratio + halfOrder;
    let acc = 0;
    for (let k = 0; k < fir.length; k++) {
      acc += samples[center - halfOrder + k]! * fir[k]!;
    }
    out[i] = Math.max(-32768, Math.min(32767, Math.round(acc)));
  }
  return out;
}

function decimateSimple(samples: Int16Array, ratio: number): Int16Array {
  const outLen = Math.floor(samples.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    let sum = 0;
    const start = i * ratio;
    for (let j = 0; j < ratio; j++) {
      sum += samples[start + j]!;
    }
    out[i] = Math.round(sum / ratio);
  }
  return out;
}
