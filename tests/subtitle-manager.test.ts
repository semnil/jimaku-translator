import { describe, it, expect, vi } from 'vitest';
import { SubtitleManager } from '../src/subtitle/manager.js';

// Minimal mock of ObsClient
function mockObs() {
  return {
    isConnected: vi.fn(() => true),
    updateSubtitle: vi.fn(async () => {}),
    clearSubtitle: vi.fn(async () => {}),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
}

describe('SubtitleManager', () => {
  it('calls updateSubtitle on show', async () => {
    const obs = mockObs();
    const mgr = new SubtitleManager(obs as any, { clearDelay: 10, charsPerLine: 40, closedCaption: false, ccLanguage: 'ja' as const });
    await mgr.show('こんにちは', 'Hello');
    expect(obs.updateSubtitle).toHaveBeenCalledWith('こんにちは', 'Hello');
  });

  it('breaks long lines at charsPerLine', async () => {
    const obs = mockObs();
    const mgr = new SubtitleManager(obs as any, { clearDelay: 10, charsPerLine: 10, closedCaption: false, ccLanguage: 'ja' as const });
    // 20-char string with space at position 8
    await mgr.show('abcdefg hijklmnopqrs', 'short');
    const call = obs.updateSubtitle.mock.calls[0]!;
    // Should have been broken into multiple lines
    expect(call[0]).toContain('\n');
  });

  it('breaks Japanese text at charsPerLine', async () => {
    const obs = mockObs();
    const mgr = new SubtitleManager(obs as any, { clearDelay: 10, charsPerLine: 5, closedCaption: false, ccLanguage: 'ja' as const });
    await mgr.show('あいうえおかきくけこ', 'test');
    const ja = obs.updateSubtitle.mock.calls[0]![0] as string;
    expect(ja).toContain('\n');
    // Each line should be <= 5 chars
    for (const line of ja.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(5);
    }
  });

  it('does not break short text', async () => {
    const obs = mockObs();
    const mgr = new SubtitleManager(obs as any, { clearDelay: 10, charsPerLine: 40, closedCaption: false, ccLanguage: 'ja' as const });
    await mgr.show('短いテキスト', 'Short text');
    const ja = obs.updateSubtitle.mock.calls[0]![0] as string;
    expect(ja).not.toContain('\n');
  });

  it('does not call OBS if disconnected', async () => {
    const obs = mockObs();
    obs.isConnected.mockReturnValue(false);
    const mgr = new SubtitleManager(obs as any, { clearDelay: 10, charsPerLine: 40, closedCaption: false, ccLanguage: 'ja' as const });
    await mgr.show('test', 'test');
    expect(obs.updateSubtitle).not.toHaveBeenCalled();
  });

  it('rapid successive shows: every update dispatched in FIFO order, separated by clearDelay', async () => {
    vi.useFakeTimers();
    try {
      const obs = mockObs();
      const mgr = new SubtitleManager(obs as any, { clearDelay: 6, charsPerLine: 0, closedCaption: false, ccLanguage: 'ja' as const });

      await mgr.show('A', 'A');
      expect(obs.updateSubtitle).toHaveBeenCalledTimes(1);
      expect(obs.updateSubtitle).toHaveBeenLastCalledWith('A', 'A');
      expect(mgr.getPendingCount()).toBe(0);

      // B arrives 500ms later while A is still active — enqueued, not coalesced
      await vi.advanceTimersByTimeAsync(500);
      await mgr.show('B', 'B');
      expect(obs.updateSubtitle).toHaveBeenCalledTimes(1);
      expect(mgr.getPendingCount()).toBe(1);

      // C arrives another 500ms later — also enqueued, B is preserved
      await vi.advanceTimersByTimeAsync(500);
      await mgr.show('C', 'C');
      expect(obs.updateSubtitle).toHaveBeenCalledTimes(1);
      expect(mgr.getPendingCount()).toBe(2);

      // After clearDelay from A: B is sent (FIFO), C still pending
      await vi.advanceTimersByTimeAsync(5100);
      expect(obs.updateSubtitle).toHaveBeenCalledTimes(2);
      expect(obs.updateSubtitle).toHaveBeenLastCalledWith('B', 'B');
      expect(mgr.getPendingCount()).toBe(1);

      // After another clearDelay: C is sent
      await vi.advanceTimersByTimeAsync(6000);
      expect(obs.updateSubtitle).toHaveBeenCalledTimes(3);
      expect(obs.updateSubtitle).toHaveBeenLastCalledWith('C', 'C');
      expect(mgr.getPendingCount()).toBe(0);

      // D arrives 1s after C displayed — queued, not coalesced
      await vi.advanceTimersByTimeAsync(1000);
      await mgr.show('D', 'D');
      expect(obs.updateSubtitle).toHaveBeenCalledTimes(3);
      expect(mgr.getPendingCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(5100);
      expect(obs.updateSubtitle).toHaveBeenCalledTimes(4);
      expect(obs.updateSubtitle).toHaveBeenLastCalledWith('D', 'D');
      expect(mgr.getPendingCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits pendingChanged when queue grows and drains', async () => {
    vi.useFakeTimers();
    try {
      const obs = mockObs();
      const mgr = new SubtitleManager(obs as any, { clearDelay: 5, charsPerLine: 0, closedCaption: false, ccLanguage: 'ja' as const });
      const events: number[] = [];
      mgr.on('pendingChanged', (n) => events.push(n));

      await mgr.show('A', 'A');
      // A displayed immediately — no pendingChanged yet
      expect(events).toEqual([]);

      await mgr.show('B', 'B');
      await mgr.show('C', 'C');
      expect(events).toEqual([1, 2]);

      // Drain B
      await vi.advanceTimersByTimeAsync(5100);
      expect(events).toEqual([1, 2, 1]);

      // Drain C
      await vi.advanceTimersByTimeAsync(5100);
      expect(events).toEqual([1, 2, 1, 0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clear() flushes pending queue and emits pendingChanged 0', async () => {
    vi.useFakeTimers();
    try {
      const obs = mockObs();
      const mgr = new SubtitleManager(obs as any, { clearDelay: 5, charsPerLine: 0, closedCaption: false, ccLanguage: 'ja' as const });
      const events: number[] = [];
      mgr.on('pendingChanged', (n) => events.push(n));

      await mgr.show('A', 'A');
      await mgr.show('B', 'B');
      await mgr.show('C', 'C');
      expect(mgr.getPendingCount()).toBe(2);

      await mgr.clear();
      expect(mgr.getPendingCount()).toBe(0);
      // Last pendingChanged event must be 0
      expect(events.at(-1)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clear calls clearSubtitle', async () => {
    const obs = mockObs();
    const mgr = new SubtitleManager(obs as any, { clearDelay: 10, charsPerLine: 40, closedCaption: false, ccLanguage: 'ja' as const });
    await mgr.clear();
    expect(obs.clearSubtitle).toHaveBeenCalled();
  });
});
