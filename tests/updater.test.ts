import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const electron = vi.hoisted(() => ({ app: { isPackaged: true } }));
const updaterModule = vi.hoisted(() => ({ autoUpdater: null as unknown }));

vi.mock('electron', () => electron);
vi.mock('electron-updater', () => updaterModule);

function fakeAutoUpdater() {
  return Object.assign(new EventEmitter(), {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkForUpdates: vi.fn(async () => ({ isUpdateAvailable: true, updateInfo: { version: '9.9.9' } })),
    downloadUpdate: vi.fn(async () => [] as string[]),
    quitAndInstall: vi.fn(),
  });
}

describe('initAutoUpdater', () => {
  let autoUpdater: ReturnType<typeof fakeAutoUpdater>;

  beforeEach(() => {
    autoUpdater = fakeAutoUpdater();
    updaterModule.autoUpdater = autoUpdater;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('returns null and leaves electron-updater alone when the app is not packaged', async () => {
    electron.app.isPackaged = false;
    const { initAutoUpdater } = await import('../src/updater.js');
    expect(initAutoUpdater()).toBeNull();
    expect(autoUpdater.listenerCount('error')).toBe(0);
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('downloads only when the update is accepted, and installs a downloaded update on quit', async () => {
    electron.app.isPackaged = true;
    const { initAutoUpdater } = await import('../src/updater.js');
    initAutoUpdater();
    expect(autoUpdater.autoDownload).toBe(false);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
  });

  it('leaves the launch check to the GUI', async () => {
    electron.app.isPackaged = true;
    const { initAutoUpdater } = await import('../src/updater.js');
    initAutoUpdater();
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('returns a controller driving electron-updater', async () => {
    electron.app.isPackaged = true;
    const { initAutoUpdater } = await import('../src/updater.js');
    const controller = initAutoUpdater();
    expect(controller).not.toBeNull();
    await expect(controller!.check()).resolves.toBe('9.9.9');
    await controller!.download('9.9.9');
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
    controller!.restart();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it('logs updater errors so an unhandled error event cannot throw', async () => {
    electron.app.isPackaged = true;
    const { initAutoUpdater } = await import('../src/updater.js');
    initAutoUpdater();
    expect(() => autoUpdater.emit('error', new Error('boom'))).not.toThrow();
    expect(console.error).toHaveBeenCalledWith('[updater] error: boom');
  });
});
