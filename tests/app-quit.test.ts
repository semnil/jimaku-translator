import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { App, AutoUpdater } from 'electron';
import { stopPipelineOnQuit } from '../src/app-quit.js';

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

  function install(stop: () => Promise<void>) {
    return stopPipelineOnQuit(app as unknown as App, native as unknown as AutoUpdater, stop);
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

  it('returns the shared stop', async () => {
    const stopPipeline = vi.fn(async () => {});
    const stopOnce = install(stopPipeline);
    await stopOnce();
    await stopOnce();
    expect(beforeQuit(app)).toBe(false);
    expect(stopPipeline).toHaveBeenCalledTimes(1);
  });
});
