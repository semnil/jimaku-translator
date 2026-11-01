import type { App, AutoUpdater } from 'electron';

/** How long a quit waits for the pipeline to stop before it quits anyway. */
export const QUIT_STOP_TIMEOUT_MS = 5000;

/**
 * Stops the pipeline before the app quits: when the last window closes, and on any other quit
 * (app.quit(), the Quit menu item) except a quit that installs an update, whose caller stops the
 * pipeline before it quits. The quit waits for the stop for at most timeoutMs; a failed or
 * unfinished stop is logged and the quit goes on.
 * Returns that wait; every call shares the first one.
 */
export function stopPipelineOnQuit(
  app: App,
  nativeUpdater: AutoUpdater,
  stopPipeline: () => Promise<void>,
  timeoutMs = QUIT_STOP_TIMEOUT_MS,
): () => Promise<void> {
  let waiting: Promise<void> | null = null;
  let released = false;
  let quittingForUpdate = false;

  const waitForStop = (): Promise<void> => {
    if (!waiting) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stop = stopPipeline()
        .catch((err) => {
          console.error(`Pipeline stop failed: ${err instanceof Error ? err.message : String(err)}`);
        })
        .then(() => clearTimeout(timer));
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          console.error(`Pipeline stop did not finish within ${timeoutMs} ms; quitting without it`);
          resolve();
        }, timeoutMs);
      });
      waiting = Promise.race([stop, timeout]).then(() => {
        released = true;
      });
    }
    return waiting;
  };

  nativeUpdater.on('before-quit-for-update', () => {
    quittingForUpdate = true;
  });
  app.on('before-quit', (event) => {
    if (released || quittingForUpdate) return;
    event.preventDefault();
    void waitForStop().then(() => app.quit());
  });
  app.on('window-all-closed', () => {
    void waitForStop().then(() => app.quit());
  });

  return waitForStop;
}
