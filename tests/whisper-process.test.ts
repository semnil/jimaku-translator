import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';
import { resolveThreadsDefault } from '../src/recognition/whisper-process.js';

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function restorePlatform(): void {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
}

describe('resolveThreadsDefault', () => {
  afterEach(() => {
    restorePlatform();
    vi.restoreAllMocks();
  });

  it('returns 4 on darwin regardless of variant', () => {
    setPlatform('darwin');
    expect(resolveThreadsDefault('')).toBe(4);
    expect(resolveThreadsDefault('cpu')).toBe(4);
    expect(resolveThreadsDefault('cublas-12')).toBe(4);
    expect(resolveThreadsDefault('whatever')).toBe(4);
  });

  it('returns 4 on linux when variant indicates GPU acceleration', () => {
    setPlatform('linux');
    expect(resolveThreadsDefault('cublas-12')).toBe(4);
    expect(resolveThreadsDefault('cuda')).toBe(4);
    expect(resolveThreadsDefault('CUDA')).toBe(4);
    expect(resolveThreadsDefault('vulkan')).toBe(4);
  });

  it('returns half of logical cores (min 1) on linux with empty variant', () => {
    setPlatform('linux');
    const fakeCpus = new Array(8).fill(0).map(() => ({}) as os.CpuInfo);
    vi.spyOn(os, 'cpus').mockReturnValue(fakeCpus);
    expect(resolveThreadsDefault('')).toBe(4);
  });

  it('clamps to at least 1 when cpus() returns a single core', () => {
    setPlatform('linux');
    vi.spyOn(os, 'cpus').mockReturnValue([{} as os.CpuInfo]);
    expect(resolveThreadsDefault('')).toBe(1);
  });

  it('floors odd core counts', () => {
    setPlatform('linux');
    const fakeCpus = new Array(7).fill(0).map(() => ({}) as os.CpuInfo);
    vi.spyOn(os, 'cpus').mockReturnValue(fakeCpus);
    expect(resolveThreadsDefault('')).toBe(3);
  });
});
