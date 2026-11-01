import type { App, AutoUpdater } from 'electron';

/**
 * Stops the pipeline before the app quits: when the last window closes, and on any other quit
 * (app.quit(), the Quit menu item) except a quit that installs an update, whose caller stops the
 * pipeline before it quits. The quit waits for the stop; a failed stop is logged and the quit goes on.
 * Returns the stop; every call shares the first one.
 */
export function stopPipelineOnQuit(
  app: App,
  nativeUpdater: AutoUpdater,
  stopPipeline: () => Promise<void>,
): () => Promise<void> {
  let stopping: Promise<void> | null = null;
  let stopped = false;
  let quittingForUpdate = false;

  const stopOnce = (): Promise<void> => {
    if (!stopping) {
      stopping = stopPipeline()
        .catch((err) => {
          console.error(`Pipeline stop failed: ${err instanceof Error ? err.message : String(err)}`);
        })
        .then(() => {
          stopped = true;
        });
    }
    return stopping;
  };

  nativeUpdater.on('before-quit-for-update', () => {
    quittingForUpdate = true;
  });
  app.on('before-quit', (event) => {
    if (stopped || quittingForUpdate) return;
    event.preventDefault();
    void stopOnce().then(() => app.quit());
  });
  app.on('window-all-closed', () => {
    void stopOnce().then(() => app.quit());
  });

  return stopOnce;
}
