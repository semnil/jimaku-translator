import { app } from 'electron';
import pkg from 'electron-updater';
const { autoUpdater } = pkg;

export function initAutoUpdater(): void {
  if (!app.isPackaged) {
    console.log('[updater] skipped (not packaged)');
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] checking for update');
  });
  autoUpdater.on('update-available', (info) => {
    console.log(`[updater] update available: ${info.version}`);
  });
  autoUpdater.on('update-not-available', (info) => {
    console.log(`[updater] up to date: ${info.version}`);
  });
  autoUpdater.on('error', (err) => {
    console.error(`[updater] error: ${err instanceof Error ? err.message : String(err)}`);
  });
  autoUpdater.on('download-progress', (p) => {
    console.log(`[updater] downloading: ${p.percent.toFixed(1)}% (${Math.round(p.bytesPerSecond / 1024)} KB/s)`);
  });
  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[updater] downloaded ${info.version}; will install on quit`);
  });

  autoUpdater.checkForUpdates().catch((err) => {
    console.error(`[updater] check failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}
