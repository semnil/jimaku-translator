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

  it('rapid successive shows: second update waits for clearDelay', async () => {
    vi.useFakeTimers();
    try {
      const obs = mockObs();
      const mgr = new SubtitleManager(obs as any, { clearDelay: 6, charsPerLine: 0, closedCaption: false, ccLanguage: 'ja' as const });

      await mgr.show('A', 'A');
      // First update: immediate
      expect(obs.updateSubtitle).toHaveBeenCalledTimes(1);
      expect(obs.updateSubtitle).toHaveBeenLastCalledWith('A', 'A');

      // Simulate q>=1 burst: B arrives 500ms later while A is still active
      await vi.advanceTimersByTimeAsync(500);
      await mgr.show('B', 'B');
      // B must not have been displayed yet
      expect(obs.updateSubtitle).toHaveBeenCalledTimes(1);

      // C arrives another 500ms later — should replace pending B, not display
      await vi.advanceTimersByTimeAsync(500);
      await mgr.show('C', 'C');
      expect(obs.updateSubtitle).toHaveBeenCalledTimes(1);

      // Just before clearDelay — still only A shown
      await vi.advanceTimersByTimeAsync(4900);
      expect(obs.updateSubtitle).toHaveBeenCalledTimes(1);

      // After clearDelay from A's display (total 6000ms): C displayed (latest wins)
      await vi.advanceTimersByTimeAsync(200);
      expect(obs.updateSubtitle).toHaveBeenCalledTimes(2);
      expect(obs.updateSubtitle).toHaveBeenLastCalledWith('C', 'C');

      // D arrives 1s after C — must wait another 5s
      await vi.advanceTimersByTimeAsync(1000);
      await mgr.show('D', 'D');
      expect(obs.updateSubtitle).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5100);
      expect(obs.updateSubtitle).toHaveBeenCalledTimes(3);
      expect(obs.updateSubtitle).toHaveBeenLastCalledWith('D', 'D');
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
