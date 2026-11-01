import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { App, AutoUpdater } from 'electron';
import { QUIT_STOP_TIMEOUT_MS, stopPipelineOnQuit } from '../src/app-quit.js';

function fakeApp() {
  const app = Object.assign(new EventEmitter(), { quit: vi.fn() });
  return app;
}

/** Emits before-quit the way Electron does and reports whether a listener prevented it. */
function beforeQuit(app: EventEmitter): boolean {
  let prevented = false;
  app.emit('before-quit', { preventDefault: () => { prevented = true; } });
  return prevented;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('stopPipelineOnQuit', () => {
  let app: ReturnType<typeof fakeApp>;
  let native: EventEmitter;

  beforeEach(() => {
    app = fakeApp();
    native = new EventEmitter();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  function install(stop: () => Promise<void>, timeoutMs?: number) {
    return stopPipelineOnQuit(app as unknown as App, native as unknown as AutoUpdater, stop, timeoutMs);
  }

  it('holds a quit until the pipeline has stopped, then quits', async () => {
    const stop = deferred();
    const stopPipeline = vi.fn(() => stop.promise);
    install(stopPipeline);
    expect(beforeQuit(app)).toBe(true);
    expect(stopPipeline).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(app.quit).not.toHaveBeenCalled();
    stop.resolve();
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1));
    expect(beforeQuit(app)).toBe(false);
    expect(stopPipeline).toHaveBeenCalledTimes(1);
  });

  it('stops once when the quit is asked again while the pipeline is stopping', async () => {
    const stop = deferred();
    const stopPipeline = vi.fn(() => stop.promise);
    install(stopPipeline);
    expect(beforeQuit(app)).toBe(true);
    expect(beforeQuit(app)).toBe(true);
    stop.resolve();
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalled());
    expect(stopPipeline).toHaveBeenCalledTimes(1);
  });

  it('stops the pipeline and quits when the last window closes', async () => {
    const stopPipeline = vi.fn(async () => {});
    install(stopPipeline);
    app.emit('window-all-closed');
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1));
    expect(beforeQuit(app)).toBe(false);
    expect(stopPipeline).toHaveBeenCalledTimes(1);
  });

  it('leaves a quit that installs an update alone', () => {
    const stopPipeline = vi.fn(async () => {});
    install(stopPipeline);
    native.emit('before-quit-for-update');
    expect(beforeQuit(app)).toBe(false);
    expect(stopPipeline).not.toHaveBeenCalled();
  });

  it('logs a failed stop and quits anyway', async () => {
    install(vi.fn(async () => { throw new Error('OBS disconnect failed'); }));
    expect(beforeQuit(app)).toBe(true);
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1));
    expect(console.error).toHaveBeenCalledWith('Pipeline stop failed: OBS disconnect failed');
    expect(beforeQuit(app)).toBe(false);
  });

  it('quits without the stop once the timeout has passed', async () => {
    const stopPipeline = vi.fn(() => new Promise<void>(() => {}));
    install(stopPipeline, 20);
    expect(beforeQuit(app)).toBe(true);
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1));
    expect(console.error).toHaveBeenCalledWith('Pipeline stop did not finish within 20 ms; quitting without it');
    expect(beforeQuit(app)).toBe(false);
  });

  it('does not report a timeout for a stop that finished in time', async () => {
    vi.useFakeTimers();
    try {
      install(vi.fn(async () => {}), 20);
      expect(beforeQuit(app)).toBe(true);
      await vi.advanceTimersByTimeAsync(100);
      expect(app.quit).toHaveBeenCalledTimes(1);
      expect(console.error).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits up to 5 seconds by default', () => {
    expect(QUIT_STOP_TIMEOUT_MS).toBe(5000);
  });

  it('returns the shared stop', async () => {
    const stopPipeline = vi.fn(async () => {});
    const stopOnce = install(stopPipeline);
    await stopOnce();
    await stopOnce();
    expect(beforeQuit(app)).toBe(false);
    expect(stopPipeline).toHaveBeenCalledTimes(1);
  });
});
