import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';

import { app, BrowserWindow, screen } from 'electron';

import { Pipeline } from './pipeline.js';
import { createServer, GUI_PORT } from './server.js';
import { initAutoUpdater } from './updater.js';
import { migrateLegacyDataIfNeeded } from './recognition/whisper-setup.js';

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
    title: 'Jimaku Translator',
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

// On macOS, the Local Network privacy prompt only fires for mDNS/Bonjour/
// multicast/broadcast traffic. Without triggering it, unicast TCP to RFC1918
// addresses (e.g. OBS WebSocket on a LAN PC) is silently blocked by
// nw_path_evaluator with ECONNREFUSED/EHOSTUNREACH, and the app never appears
// in System Settings → Privacy & Security → Local Network. Sending a single
// mDNS query at startup surfaces the permission prompt through the documented
// path. macOS caches the answer, so subsequent runs are free.
function primeLocalNetworkPermission(): void {
  if (process.platform !== 'darwin') return;
  try {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.once('error', (err) => {
      console.log(`[LocalNetwork] dgram error: ${err.message}`);
      try { sock.close(); } catch {}
    });
    sock.bind(0, () => {
      try {
        sock.setMulticastTTL(1);
        const query = Buffer.from([
          0x00,0x00,0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x00,0x00,0x00,
          0x09,0x5f,0x73,0x65,0x72,0x76,0x69,0x63,0x65,0x73,
          0x07,0x5f,0x64,0x6e,0x73,0x2d,0x73,0x64,
          0x04,0x5f,0x75,0x64,0x70,
          0x05,0x6c,0x6f,0x63,0x61,0x6c,0x00,
          0x00,0x0c,0x00,0x01,
        ]);
        console.log('[LocalNetwork] Sending mDNS probe to 224.0.0.251:5353');
        sock.send(query, 5353, '224.0.0.251', (err) => {
          if (err) console.log(`[LocalNetwork] send error: ${err.message}`);
          else console.log('[LocalNetwork] mDNS probe sent');
          setTimeout(() => { try { sock.close(); } catch {} }, 200);
        });
      } catch (err) {
        console.log(`[LocalNetwork] setup error: ${err instanceof Error ? err.message : String(err)}`);
        try { sock.close(); } catch {}
      }
    });
  } catch (err) {
    console.log(`[LocalNetwork] createSocket error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Secondary trigger: spawn `dns-sd -B` briefly. dns-sd routes through
  // mDNSResponder, which is the documented path macOS uses to decide whether
  // to prompt for Local Network permission. Attribution flows back to the
  // parent process via the responsibility chain.
  try {
    const { spawn } = require('node:child_process') as typeof import('node:child_process');
    const child = spawn('/usr/bin/dns-sd', ['-B', '_services._dns-sd._udp', 'local.'], {
      stdio: 'ignore',
      detached: false,
    });
    child.on('error', (err) => console.log(`[LocalNetwork] dns-sd spawn error: ${err.message}`));
    setTimeout(() => { try { child.kill(); } catch {} }, 1500);
  } catch (err) {
    console.log(`[LocalNetwork] dns-sd fallback error: ${err instanceof Error ? err.message : String(err)}`);
  }
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

// Set data dirs for managed downloads and local config.
// JIMAKU_DATA_DIR pins the shared root so the CLI computes the same path.
process.env.JIMAKU_DATA_DIR = app.getPath('userData');
process.env.VBAN_LOCAL_CONFIG_DIR = app.getPath('userData');
migrateLegacyDataIfNeeded();

app.whenReady().then(async () => {
  primeLocalNetworkPermission();

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
  initAutoUpdater();
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
