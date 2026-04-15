/**
 * Audio level utilities: RMS computation and gain normalization.
 */

const INT16_MAX = 32768;
const EPSILON = 1e-10;

/** Compute RMS of INT16 PCM samples, normalized to [0, 1]. */
export function computeRms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]! / INT16_MAX;
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / samples.length);
}

/** Convert linear [0, 1] to dBFS. Returns -Infinity for zero input. */
export function linearToDbfs(linear: number): number {
  if (linear <= EPSILON) return -Infinity;
  return 20 * Math.log10(linear);
}

/** Convert dBFS to linear [0, 1]. */
export function dbfsToLinear(dbfs: number): number {
  return Math.pow(10, dbfs / 20);
}

/**
 * Tracks the recent noise floor as a low-percentile of RMS samples observed
 * while no speech is active. Used to compute an adaptive RMS gate that rises
 * automatically when ambient noise grows.
 *
 * Caller is responsible for only feeding samples observed during non-speech.
 */
export class NoiseFloorTracker {
  private history: number[] = [];
  private readonly capacity: number;
  private readonly percentile: number;

  /**
   * @param capacity   Max number of RMS samples retained (sliding window).
   * @param percentile Low percentile (0-1) used as the noise floor estimate.
   */
  constructor(capacity: number, percentile = 0.5) {
    this.capacity = Math.max(1, capacity);
    this.percentile = Math.min(1, Math.max(0, percentile));
  }

  add(rms: number): void {
    this.history.push(rms);
    if (this.history.length > this.capacity) {
      this.history.shift();
    }
  }

  /** Returns the percentile RMS in linear [0, 1], or null if no samples yet. */
  estimate(): number | null {
    if (this.history.length === 0) return null;
    const sorted = [...this.history].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * this.percentile));
    return sorted[idx]!;
  }

  reset(): void {
    this.history = [];
  }

  get size(): number {
    return this.history.length;
  }
}

/**
 * Normalize samples to target dBFS RMS level with a max gain cap.
 * Returns a new Int16Array. Clips to INT16 range.
 *
 * If current level is already above target, returns samples unchanged (no attenuation).
 * If required gain exceeds maxGainDb, caps at maxGainDb to avoid boosting noise floor.
 */
export function normalizeToTarget(
  samples: Int16Array,
  targetDbfs: number,
  maxGainDb = 20,
): Int16Array {
  const rms = computeRms(samples);
  const currentDbfs = linearToDbfs(rms);
  if (!Number.isFinite(currentDbfs)) return samples;
  if (currentDbfs >= targetDbfs) return samples;

  const gainDb = Math.min(targetDbfs - currentDbfs, maxGainDb);
  const gain = dbfsToLinear(gainDb);

  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const amplified = Math.round(samples[i]! * gain);
    out[i] = amplified > 32767 ? 32767 : amplified < -32768 ? -32768 : amplified;
  }
  return out;
}
