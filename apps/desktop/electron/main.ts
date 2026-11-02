import { app, BrowserWindow, ipcMain, screen, shell } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseAppManifest } from '../src/lib/app-manifest';
import { registerAuthHandlers } from './auth';
import { appendLog, configDir, logPath } from './paths';

registerAuthHandlers();

ipcMain.on('log:append', (_event, line: string) => appendLog(String(line)));
process.on('uncaughtException', (err) => appendLog(`${new Date().toISOString()} [main uncaught] ${err.stack ?? String(err)}`));

// Per-user runtime config (the KBs): an XDG TOML file at
// $XDG_CONFIG_HOME/semiont-desktop/config.toml (default ~/.config/…). The
// renderer reads/writes it through `window.configBridge` (see preload.ts).
function configPath(): string {
  return join(configDir(), 'config.toml');
}

ipcMain.handle('config:read', () => {
  const path = configPath();
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
});

ipcMain.handle('config:write', (_event, toml: string) => {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, toml, { mode: 0o600 });
  chmodSync(path, 0o600); // enforce 0600 on an existing file too
});

// Chat history — same XDG dir, a JSON file. localStorage isn't reliably persisted for
// file:// origins in the packaged app, so the renderer routes history through here too
// (window.historyBridge). 0600 since it holds conversation content.
function historyPath(): string {
  return join(configDir(), 'history.json');
}

ipcMain.handle('history:read', () => {
  const path = historyPath();
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
});

ipcMain.handle('history:write', (_event, json: string) => {
  const path = historyPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, json, { mode: 0o600 });
});

// UI preferences (e.g. sidebar width) — same XDG dir, a JSON file. Routed through the
// main process for the same file:// localStorage reason; not credentials, so no 0600.
function prefsPath(): string {
  return join(configDir(), 'prefs.json');
}

ipcMain.handle('prefs:read', () => {
  const path = prefsPath();
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
});

ipcMain.handle('prefs:write', (_event, json: string) => {
  const path = prefsPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, json);
});

// Split-view nicety: when a document opens beside the chat and the window is too narrow
// for both panes, grow it toward the display's work-area edge; on close, restore the old
// bounds ONLY if the user hasn't resized meanwhile (their manual size always wins).
// Maximized/fullscreen windows are left alone. Web builds have no such lever — the
// renderer's split simply falls back to the swap there.
let preGrowBounds: Electron.Rectangle | null = null;
let grownWidth: number | null = null;

ipcMain.handle('window:ensure-width', (event, desired: number) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const want = Math.round(Number(desired));
  if (!win || !Number.isFinite(want) || want <= 0 || win.isMaximized() || win.isFullScreen()) return;
  const bounds = win.getBounds();
  if (bounds.width >= want) return;
  const area = screen.getDisplayMatching(bounds).workArea;
  const width = Math.min(want, area.width);
  // Keep the window on-screen: shift left only as far as needed to fit the new width.
  const x = Math.max(area.x, Math.min(bounds.x, area.x + area.width - width));
  preGrowBounds = bounds;
  grownWidth = width;
  win.setBounds({ ...bounds, x, width });
});

ipcMain.handle('window:restore-width', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && preGrowBounds !== null && grownWidth !== null && win.getBounds().width === grownWidth) {
    win.setBounds(preGrowBounds);
  }
  preGrowBounds = null;
  grownWidth = null;
});

// Build-time app title, from app.toml. Present next to the launch dir in dev; in a
// packaged app it's absent, so parseAppManifest(null) yields the default and the
// renderer corrects the window/tab title on load (document.title = appTitle).
function windowTitle(): string {
  try {
    const path = join(process.cwd(), 'app.toml');
    return parseAppManifest(existsSync(path) ? readFileSync(path, 'utf8') : null).title;
  } catch {
    return parseAppManifest(null).title;
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    title: windowTitle(),
    // Drop the native macOS title bar; the renderer adds a slim draggable strip
    // (.app__dragbar) and the traffic-light buttons float over it.
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Deep-links (sidebar docs, upload records, answer references) use target=_blank /
  // window.open. In Electron that would otherwise spawn a bare in-app window — instead
  // route http(s) to the user's DEFAULT browser (where the Semiont Browser runs), and
  // deny the in-app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // dev: `electron:dev` sets ELECTRON_RENDERER_URL to the Vite dev server.
  // packaged: load the Vite-built renderer from out/renderer.
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

void app.whenReady().then(() => {
  // Fresh log each launch (so it stays small); the renderer appends after this.
  try {
    mkdirSync(dirname(logPath()), { recursive: true, mode: 0o700 });
    writeFileSync(logPath(), `${new Date().toISOString()} [main] app start — ${app.getVersion()}\n`);
  } catch {
    // best-effort
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
