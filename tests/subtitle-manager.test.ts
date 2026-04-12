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

  it('clear calls clearSubtitle', async () => {
    const obs = mockObs();
    const mgr = new SubtitleManager(obs as any, { clearDelay: 10, charsPerLine: 40, closedCaption: false, ccLanguage: 'ja' as const });
    await mgr.clear();
    expect(obs.clearSubtitle).toHaveBeenCalled();
  });
});
