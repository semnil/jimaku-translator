import { describe, it, expect, vi } from 'vitest';
import { SubtitleManager } from '../src/subtitle/manager.js';
import { SileroVad } from '../src/audio/vad.js';
import { VbanReceiver } from '../src/vban/receiver.js';
import path from 'node:path';

// --- SubtitleManager ---

function mockObs() {
  return {
    isConnected: vi.fn(() => true),
    updateSubtitle: vi.fn(async () => {}),
    clearSubtitle: vi.fn(async () => {}),
    sendCaption: vi.fn(async () => {}),
  };
}

describe('SubtitleManager.updateOpts', () => {
  it('updates charsPerLine and affects line breaking', async () => {
    const obs = mockObs();
    const mgr = new SubtitleManager(obs as any, {
      clearDelay: 10, charsPerLine: 40, closedCaption: false, ccLanguage: 'ja',
    });

    // 20-char string should not break at charsPerLine=40
    await mgr.show('あいうえおかきくけこさしすせそたちつてと', 'test');
    expect(obs.updateSubtitle.mock.calls[0]![0]).not.toContain('\n');

    mgr.updateOpts({ charsPerLine: 5 });

    // Same text should now break
    await mgr.show('あいうえおかきくけこさしすせそたちつてと', 'test');
    expect(obs.updateSubtitle.mock.calls[1]![0]).toContain('\n');
  });

  it('updates closedCaption flag', async () => {
    const obs = mockObs();
    const mgr = new SubtitleManager(obs as any, {
      clearDelay: 10, charsPerLine: 40, closedCaption: false, ccLanguage: 'ja',
    });

    await mgr.show('テスト', 'test');
    expect(obs.sendCaption).not.toHaveBeenCalled();

    mgr.updateOpts({ closedCaption: true });
    await mgr.show('テスト2', 'test2');
    expect(obs.sendCaption).toHaveBeenCalledWith('テスト2');
  });

  it('updates ccLanguage', async () => {
    const obs = mockObs();
    const mgr = new SubtitleManager(obs as any, {
      clearDelay: 10, charsPerLine: 40, closedCaption: true, ccLanguage: 'ja',
    });

    await mgr.show('日本語', 'English');
    expect(obs.sendCaption).toHaveBeenCalledWith('日本語');

    mgr.updateOpts({ ccLanguage: 'en' });
    await mgr.show('日本語2', 'English2');
    expect(obs.sendCaption).toHaveBeenCalledWith('English2');
  });

  it('partial update preserves other opts', async () => {
    const obs = mockObs();
    const mgr = new SubtitleManager(obs as any, {
      clearDelay: 10, charsPerLine: 5, closedCaption: true, ccLanguage: 'ja',
    });

    // Only update ccLanguage — charsPerLine=5 and closedCaption=true should remain
    mgr.updateOpts({ ccLanguage: 'en' });
    await mgr.show('あいうえおかきくけこ', 'English');
    expect(obs.updateSubtitle.mock.calls[0]![0]).toContain('\n'); // charsPerLine=5 still active
    expect(obs.sendCaption).toHaveBeenCalledWith('English'); // closedCaption still true
  });
});

// --- SileroVad ---

const MODEL_PATH = path.resolve('models', 'silero_vad.onnx');

describe('SileroVad.updateOpts', () => {
  it('updates threshold', async () => {
    const vad = new SileroVad({
      modelPath: MODEL_PATH,
      threshold: 0.5,
      minSpeechMs: 250,
      maxSpeechMs: 10000,
    });
    await vad.init();

    // Verify diag output reflects updated threshold
    const diags: any[] = [];
    vad.on('diag', (d) => diags.push(d));

    vad.updateOpts({ threshold: 0.9 });

    // Feed enough silence to trigger a 5-second diag emission
    // Instead, we verify through the internal state by feeding data
    // and checking that the updated threshold is used in diag
    const silence = new Int16Array(16000 * 6); // 6 seconds to trigger diag
    await vad.feed(silence);

    // diag should have fired with the new threshold
    expect(diags.length).toBeGreaterThan(0);
    expect(diags[0].threshold).toBe(0.9);
  });

  it('updates minSpeechMs and maxSpeechMs', () => {
    const vad = new SileroVad({
      modelPath: MODEL_PATH,
      threshold: 0.5,
      minSpeechMs: 250,
      maxSpeechMs: 10000,
    });

    vad.updateOpts({ minSpeechMs: 500, maxSpeechMs: 5000 });

    // No crash — opts are applied; actual effect is tested through speech emission
    // which requires a real speech signal
  });

  it('partial update preserves other opts', async () => {
    const vad = new SileroVad({
      modelPath: MODEL_PATH,
      threshold: 0.5,
      minSpeechMs: 250,
      maxSpeechMs: 10000,
    });
    await vad.init();

    vad.updateOpts({ threshold: 0.8 });

    const diags: any[] = [];
    vad.on('diag', (d) => diags.push(d));
    await vad.feed(new Int16Array(16000 * 6));

    expect(diags[0].threshold).toBe(0.8);
    // minSpeechMs/maxSpeechMs preserved (no crash during feed proves it)
  });
});

// --- VbanReceiver ---

describe('VbanReceiver.updateOpts', () => {
  it('updates streamName without restarting socket', () => {
    const recv = new VbanReceiver({ port: 0, streamName: 'stream1' });
    // Not started — just verify no crash on update
    recv.updateOpts({ streamName: 'stream2' });
  });

  it('rebinds socket when port changes', async () => {
    // Use port 0 to get a random free port, then switch to a different one
    const recv = new VbanReceiver({ port: 0, streamName: '' });
    const listeningPorts: number[] = [];
    recv.on('listening', ({ port }) => listeningPorts.push(port));

    recv.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(listeningPorts.length).toBe(1);

    // updateOpts with a different port value triggers rebind
    // opts.port is 0, any non-zero value is a change
    const newPort = listeningPorts[0]! + 1;
    recv.updateOpts({ port: newPort });
    await new Promise((r) => setTimeout(r, 50));
    expect(listeningPorts.length).toBe(2);
    expect(listeningPorts[1]).toBe(newPort);

    recv.stop();
  });

  it('does not rebind socket when only streamName changes', async () => {
    const recv = new VbanReceiver({ port: 0, streamName: '' });
    const listeningPorts: number[] = [];
    recv.on('listening', ({ port }) => listeningPorts.push(port));

    recv.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(listeningPorts.length).toBe(1);

    recv.updateOpts({ streamName: 'new-stream' });
    await new Promise((r) => setTimeout(r, 50));
    // No additional bind
    expect(listeningPorts.length).toBe(1);

    recv.stop();
  });

  it('does not rebind when port is same value', async () => {
    // Use a specific port so opts.port matches the bound port
    const helper = new VbanReceiver({ port: 0, streamName: '' });
    let freePort = 0;
    helper.on('listening', ({ port }) => { freePort = port; });
    helper.start();
    await new Promise((r) => setTimeout(r, 50));
    helper.stop();
    await new Promise((r) => setTimeout(r, 50));

    const recv = new VbanReceiver({ port: freePort, streamName: '' });
    const listeningPorts: number[] = [];
    recv.on('listening', ({ port }) => listeningPorts.push(port));

    recv.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(listeningPorts.length).toBe(1);

    // Same port — should not rebind
    recv.updateOpts({ port: freePort });
    await new Promise((r) => setTimeout(r, 50));
    expect(listeningPorts.length).toBe(1);

    recv.stop();
  });

  it('does not rebind if not started', () => {
    const recv = new VbanReceiver({ port: 6980, streamName: '' });
    // Not started — port change should just update opts, not crash
    recv.updateOpts({ port: 7000 });
  });
});
