import fs from 'node:fs';
import path from 'node:path';

import { app, BrowserWindow, screen } from 'electron';

import { Pipeline } from './pipeline.js';
import { createServer, GUI_PORT } from './server.js';

let mainWindow: BrowserWindow | null = null;
let pipeline: Pipeline | null = null;

interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
}

function getWindowStatePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState(): WindowState | null {
  try {
    const data = fs.readFileSync(getWindowStatePath(), 'utf-8');
    const state = JSON.parse(data) as WindowState;
    // Validate that the saved position is on a visible display
    const displays = screen.getAllDisplays();
    const visible = displays.some(d => {
      const b = d.bounds;
      return state.x >= b.x - 100 && state.x < b.x + b.width
          && state.y >= b.y - 100 && state.y < b.y + b.height;
    });
    if (!visible) return null;
    return state;
  } catch {
    return null;
  }
}

function saveWindowState(win: BrowserWindow): void {
  if (win.isMinimized() || win.isMaximized()) return;
  const bounds = win.getBounds();
  const state: WindowState = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  try {
    fs.writeFileSync(getWindowStatePath(), JSON.stringify(state), 'utf-8');
  } catch { /* ignore */ }
}

function createMainWindow(): BrowserWindow {
  const saved = loadWindowState();
  const win = new BrowserWindow({
    width: saved?.width ?? 800,
    height: saved?.height ?? 900,
    x: saved?.x,
    y: saved?.y,
    minWidth: 600,
    minHeight: 500,
    title: 'jimaku-translator',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  win.loadURL(`http://127.0.0.1:${GUI_PORT}/`);
  win.on('close', () => { saveWindowState(win); });
  win.on('closed', () => { mainWindow = null; });
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) {
      win.show();
      win.focus();
    }
  });
  return win;
}

// Prevent multiple instances — focus existing window instead
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// Set data dirs for managed downloads and local config
process.env.VBAN_WHISPER_DIR = path.join(app.getPath('userData'), 'whisper');
process.env.VBAN_LOCAL_CONFIG_DIR = app.getPath('userData');

app.whenReady().then(async () => {
  const configPath = process.argv.find(a => a.endsWith('.toml'))
    ?? path.join(app.isPackaged
      ? process.resourcesPath
      : path.resolve(app.getAppPath()),
      'config.toml');

  pipeline = new Pipeline(configPath);

  const server = createServer({ pipeline });
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(GUI_PORT, '127.0.0.1', resolve);
  });

  await pipeline.start().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Pipeline startup failed:', msg);
  });

  mainWindow = createMainWindow();
}).catch((err) => {
  console.error('Startup failed:', err);
  app.quit();
});

app.on('window-all-closed', async () => {
  if (pipeline) await pipeline.stop();
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) {
    mainWindow = createMainWindow();
  }
});
