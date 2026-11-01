import type { AppUpdater } from 'electron-updater';

/** What the GUI server asks of the updater. */
export interface UpdateController {
  /** The newer version the latest release offers, or null when the app is up to date. */
  check(): Promise<string | null>;
  /** Downloads the version the last check offered; resolves once it can be installed. */
  download(version: string): Promise<void>;
  /** Quits the app, installs the downloaded update silently and starts the new version. */
  restart(): void;
  /** Calls the listener with the message of the first updater error raised after each restart(). */
  onRestartError(listener: (message: string) => void): void;
}

/** download() was asked for a version the last check did not offer. */
export class UpdateNotOfferedError extends Error {}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createUpdateController(updater: AppUpdater): UpdateController {
  let offered: string | null = null;
  let downloaded: string | null = null;
  let restarting = false;
  const restartErrorListeners: Array<(message: string) => void> = [];

  updater.on('update-downloaded', (info) => {
    downloaded = info.version;
  });
  const reportRestartError = (err: unknown) => {
    restarting = false;
    for (const listener of restartErrorListeners) listener(errorMessage(err));
  };
  updater.on('error', (err) => {
    if (restarting) reportRestartError(err);
  });

  return {
    async check() {
      const result = await updater.checkForUpdates();
      offered = result?.isUpdateAvailable ? result.updateInfo.version : null;
      return offered;
    },
    async download(version) {
      if (offered !== version) {
        throw new UpdateNotOfferedError(`Version ${version} was not offered by the last check`);
      }
      // Joins the download already in progress, if any.
      if (downloaded !== version) await updater.downloadUpdate();
    },
    restart() {
      restarting = true;
      try {
        updater.quitAndInstall(true, true);
      } catch (err) {
        reportRestartError(err);
      }
    },
    onRestartError(listener) {
      restartErrorListeners.push(listener);
    },
  };
}
