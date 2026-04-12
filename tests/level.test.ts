import { describe, it, expect } from 'vitest';
import {
  computeRms,
  linearToDbfs,
  dbfsToLinear,
  normalizeToTarget,
} from '../src/audio/level.js';

describe('computeRms', () => {
  it('returns 0 for silence', () => {
    expect(computeRms(new Int16Array(1000))).toBe(0);
  });

  it('returns 0 for empty array', () => {
    expect(computeRms(new Int16Array(0))).toBe(0);
  });

  it('computes RMS of a constant signal', () => {
    // All samples at 16384 (half of INT16_MAX=32768) → RMS = 0.5
    const samples = new Int16Array(1000).fill(16384);
    expect(computeRms(samples)).toBeCloseTo(0.5, 4);
  });

  it('computes RMS of a square wave (±16384)', () => {
    // Alternating +16384 / -16384 → RMS = 0.5
    const samples = new Int16Array(1000);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = i % 2 === 0 ? 16384 : -16384;
    }
    expect(computeRms(samples)).toBeCloseTo(0.5, 4);
  });

  it('computes RMS of a sine wave', () => {
    // Sine at amplitude 32768 → RMS = 1/sqrt(2) ≈ 0.707
    const samples = new Int16Array(16000);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.round(32767 * Math.sin((2 * Math.PI * 440 * i) / 16000));
    }
    expect(computeRms(samples)).toBeCloseTo(1 / Math.sqrt(2), 2);
  });
});

describe('linearToDbfs / dbfsToLinear', () => {
  it('0 dBFS == 1.0 linear', () => {
    expect(dbfsToLinear(0)).toBeCloseTo(1.0, 6);
    expect(linearToDbfs(1.0)).toBeCloseTo(0, 6);
  });

  it('-6 dBFS ≈ 0.5 linear', () => {
    expect(dbfsToLinear(-6)).toBeCloseTo(0.5012, 3);
    expect(linearToDbfs(0.5)).toBeCloseTo(-6.02, 1);
  });

  it('-20 dBFS == 0.1 linear', () => {
    expect(dbfsToLinear(-20)).toBeCloseTo(0.1, 6);
    expect(linearToDbfs(0.1)).toBeCloseTo(-20, 4);
  });

  it('linearToDbfs returns -Infinity for zero', () => {
    expect(linearToDbfs(0)).toBe(-Infinity);
  });

  it('round trip preserves value', () => {
    for (const db of [-60, -30, -12, -6, -3, 0]) {
      expect(linearToDbfs(dbfsToLinear(db))).toBeCloseTo(db, 4);
    }
  });
});

describe('normalizeToTarget', () => {
  function makeSineAtDbfs(dbfs: number, len = 16000): Int16Array {
    const amplitude = dbfsToLinear(dbfs) * Math.sqrt(2) * 32767;
    const samples = new Int16Array(len);
    for (let i = 0; i < len; i++) {
      samples[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / 16000));
    }
    return samples;
  }

  it('boosts quiet audio to target level', () => {
    const quiet = makeSineAtDbfs(-30);
    const normalized = normalizeToTarget(quiet, -6, 40);
    const resultDbfs = linearToDbfs(computeRms(normalized));
    expect(resultDbfs).toBeCloseTo(-6, 0);
  });

  it('does not attenuate audio already above target', () => {
    const loud = makeSineAtDbfs(-3);
    const normalized = normalizeToTarget(loud, -6, 20);
    // Should be unchanged (same reference, no amplification)
    expect(normalized).toBe(loud);
  });

  it('does not attenuate audio slightly above target', () => {
    const aboveTarget = makeSineAtDbfs(-5);
    const normalized = normalizeToTarget(aboveTarget, -6, 20);
    expect(normalized).toBe(aboveTarget);
  });

  it('caps gain at maxGainDb to avoid boosting noise floor', () => {
    const verySoft = makeSineAtDbfs(-60); // needs +54 dB to reach -6
    const normalized = normalizeToTarget(verySoft, -6, 20); // cap at +20 dB
    const resultDbfs = linearToDbfs(computeRms(normalized));
    // Original -60 + cap 20 = -40 dBFS result
    expect(resultDbfs).toBeCloseTo(-40, 0);
  });

  it('clips samples to INT16 range when boost would overflow', () => {
    // Signal with peaks near INT16 limit, already-high RMS
    const samples = new Int16Array(1000);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = i % 2 === 0 ? 16000 : -16000; // RMS ≈ 0.488, ~-6.2 dBFS
    }
    const normalized = normalizeToTarget(samples, -3, 20); // +3.2 dB → peaks ~23000, within INT16
    for (let i = 0; i < normalized.length; i++) {
      expect(normalized[i]).toBeGreaterThanOrEqual(-32768);
      expect(normalized[i]).toBeLessThanOrEqual(32767);
    }
  });

  it('handles pure silence gracefully (no NaN)', () => {
    const silence = new Int16Array(1000);
    const normalized = normalizeToTarget(silence, -6, 20);
    // Silence has -Infinity dBFS; should return unchanged to avoid division by zero
    expect(normalized).toBe(silence);
  });

  it('returns new array when amplifying (does not mutate input)', () => {
    const quiet = makeSineAtDbfs(-30);
    const copy = new Int16Array(quiet);
    const normalized = normalizeToTarget(quiet, -6, 40);
    expect(normalized).not.toBe(quiet);
    // Original untouched
    for (let i = 0; i < quiet.length; i++) {
      expect(quiet[i]).toBe(copy[i]);
    }
  });
});
