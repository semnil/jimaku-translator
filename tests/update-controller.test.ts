import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import type { AppUpdater } from 'electron-updater';
import { createUpdateController, UpdateNotOfferedError } from '../src/update-controller.js';

function fakeUpdater() {
  const emitter = new EventEmitter();
  const updater = Object.assign(emitter, {
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(async () => [] as string[]),
    quitAndInstall: vi.fn(),
  });
  return updater;
}

function offering(version: string, isUpdateAvailable = true) {
  return { isUpdateAvailable, updateInfo: { version }, versionInfo: { version } };
}

function controllerFor(updater: ReturnType<typeof fakeUpdater>) {
  return createUpdateController(updater as unknown as AppUpdater);
}

describe('createUpdateController check()', () => {
  it('returns the version the latest release offers', async () => {
    const updater = fakeUpdater();
    updater.checkForUpdates.mockResolvedValue(offering('9.9.9'));
    await expect(controllerFor(updater).check()).resolves.toBe('9.9.9');
  });

  it('returns null when the latest release is not newer', async () => {
    const updater = fakeUpdater();
    updater.checkForUpdates.mockResolvedValue(offering('1.0.0', false));
    await expect(controllerFor(updater).check()).resolves.toBeNull();
  });

  it('returns null when the updater is inactive', async () => {
    const updater = fakeUpdater();
    updater.checkForUpdates.mockResolvedValue(null);
    await expect(controllerFor(updater).check()).resolves.toBeNull();
  });

  it('rejects with the updater error', async () => {
    const updater = fakeUpdater();
    updater.checkForUpdates.mockRejectedValue(new Error('net::ERR_INTERNET_DISCONNECTED'));
    await expect(controllerFor(updater).check()).rejects.toThrow('net::ERR_INTERNET_DISCONNECTED');
  });
});

describe('createUpdateController download()', () => {
  it('refuses a version before any check', async () => {
    const updater = fakeUpdater();
    await expect(controllerFor(updater).download('9.9.9')).rejects.toBeInstanceOf(UpdateNotOfferedError);
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it('refuses a version the last check did not offer', async () => {
    const updater = fakeUpdater();
    updater.checkForUpdates.mockResolvedValue(offering('9.9.9'));
    const controller = controllerFor(updater);
    await controller.check();
    await expect(controller.download('9.9.8')).rejects.toBeInstanceOf(UpdateNotOfferedError);
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it('refuses the offered version once a later check finds none', async () => {
    const updater = fakeUpdater();
    updater.checkForUpdates.mockResolvedValueOnce(offering('9.9.9')).mockResolvedValueOnce(offering('9.9.9', false));
    const controller = controllerFor(updater);
    await controller.check();
    await controller.check();
    await expect(controller.download('9.9.9')).rejects.toBeInstanceOf(UpdateNotOfferedError);
  });

  it('downloads the offered version', async () => {
    const updater = fakeUpdater();
    updater.checkForUpdates.mockResolvedValue(offering('9.9.9'));
    const controller = controllerFor(updater);
    await controller.check();
    await controller.download('9.9.9');
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('downloads again on a retry after electron-updater reported that version downloaded', async () => {
    const updater = fakeUpdater();
    updater.checkForUpdates.mockResolvedValue(offering('9.9.9'));
    updater.downloadUpdate.mockImplementationOnce(async () => {
      updater.emit('update-downloaded', { version: '9.9.9' });
      throw new Error('Squirrel.Mac: the update could not be staged');
    });
    const controller = controllerFor(updater);
    await controller.check();
    await expect(controller.download('9.9.9')).rejects.toThrow('could not be staged');
    await controller.check();
    await controller.download('9.9.9');
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(2);
  });

  it('rejects with the download error', async () => {
    const updater = fakeUpdater();
    updater.checkForUpdates.mockResolvedValue(offering('9.9.9'));
    updater.downloadUpdate.mockRejectedValue(new Error('sha512 checksum mismatch'));
    const controller = controllerFor(updater);
    await controller.check();
    await expect(controller.download('9.9.9')).rejects.toThrow('sha512 checksum mismatch');
  });
});

describe('createUpdateController restart()', () => {
  it('installs silently and starts the new version', () => {
    const updater = fakeUpdater();
    controllerFor(updater).restart();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it('reports the first updater error raised after restart()', () => {
    const updater = fakeUpdater();
    const controller = controllerFor(updater);
    const listener = vi.fn();
    controller.onRestartError(listener);
    controller.restart();
    updater.emit('error', new Error('Squirrel.Mac: code signature invalid'));
    updater.emit('error', new Error('a later check failed'));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('Squirrel.Mac: code signature invalid');
  });

  it('does not report updater errors raised before restart()', () => {
    const updater = fakeUpdater();
    const controller = controllerFor(updater);
    const listener = vi.fn();
    controller.onRestartError(listener);
    updater.emit('error', new Error('check failed'));
    expect(listener).not.toHaveBeenCalled();
  });

  it('reports an error thrown by quitAndInstall', () => {
    const updater = fakeUpdater();
    updater.quitAndInstall.mockImplementation(() => { throw new Error('No update available'); });
    const controller = controllerFor(updater);
    const listener = vi.fn();
    controller.onRestartError(listener);
    controller.restart();
    expect(listener).toHaveBeenCalledWith('No update available');
  });
});
