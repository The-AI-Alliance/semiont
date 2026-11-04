import { app, BrowserWindow, ipcMain, Menu, screen, shell, type MenuItemConstructorOptions } from 'electron';
import { execFile } from 'node:child_process';
import { constants, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { parseAppManifest } from '../src/lib/app-manifest';
import type { LauncherStatusResult } from '../src/lib/launcher-bridge';
import type { OllamaInfo, OllamaModelInfo } from '../src/lib/ollama-info';
import { registerAuthHandlers } from './auth';
import { appendLog, configDir, logPath } from './paths';

registerAuthHandlers();

let mainWindow: BrowserWindow | null = null;

function launcherPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'launcher', 'semiont')
    : join(process.cwd(), '.build', 'launcher', 'semiont');
}

function launcherEnvironment(): NodeJS.ProcessEnv {
  // GUI apps on macOS do not inherit the user's shell PATH. Add the usual
  // Homebrew and Docker Desktop locations so `semiont` can find a runtime
  // when Desktop is opened from Finder or the Dock.
  const home = app.getPath('home');
  const defaults = process.platform === 'darwin'
    ? [
        '/opt/homebrew/bin',
        '/opt/homebrew/sbin',
        '/usr/local/bin',
        '/usr/local/sbin',
        '/Applications/Docker.app/Contents/Resources/bin',
        join(home, '.docker', 'bin'),
        join(home, '.local', 'bin'),
      ]
    : [join(home, '.local', 'bin'), '/usr/local/bin', '/usr/bin', '/bin'];
  const pathEntries = [...new Set([...(process.env.PATH ?? '').split(delimiter), ...defaults].filter(Boolean))];
  return { ...process.env, PATH: pathEntries.join(delimiter) };
}

function runLauncher(args: string[]): Promise<LauncherStatusResult> {
  return new Promise((resolve) => {
    execFile(
      launcherPath(),
      args,
      {
        cwd: app.getPath('home'),
        encoding: 'utf8',
        env: launcherEnvironment(),
        maxBuffer: 4 * 1024 * 1024,
        timeout: 120_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const output = [stdout.trimEnd(), stderr.trimEnd()].filter((part) => part.length > 0).join('\n\n');
        resolve({
          output: output || (error === null ? '(no output)' : error.message),
          exitCode: error === null ? 0 : (typeof error.code === 'number' ? error.code : null),
          error: error?.message ?? null,
        });
      },
    );
  });
}

ipcMain.handle('launcher:status', () => runLauncher(['status']));
ipcMain.handle('launcher:about', () => runLauncher(['about']));

async function ollamaInfo(): Promise<OllamaInfo> {
  const env = launcherEnvironment();
  const pathEntries = (env.PATH ?? '').split(delimiter).filter(Boolean);
  let executablePath: string | null = null;
  for (const directory of pathEntries) {
    const candidate = join(directory, process.platform === 'win32' ? 'ollama.exe' : 'ollama');
    try {
      await access(candidate, constants.X_OK);
      executablePath = candidate;
      break;
    } catch {
      // Keep looking through the same PATH Desktop gives the launcher.
    }
  }

  // The launcher may use a host Ollama or a containerized one. Try the usual
  // host address and Apple Container's host bridge; no model requests leave
  // the machine.
  const candidates = ['http://localhost:11434', 'http://127.0.0.1:11434', 'http://192.168.64.1:11434'];
  for (const endpoint of candidates) {
    try {
      const response = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) continue;
      const payload: unknown = await response.json();
      if (typeof payload !== 'object' || payload === null || !('models' in payload) || !Array.isArray(payload.models)) continue;

      let loadedNames = new Set<string>();
      try {
        const loadedResponse = await fetch(`${endpoint}/api/ps`, { signal: AbortSignal.timeout(1000) });
        if (loadedResponse.ok) {
          const loadedPayload: unknown = await loadedResponse.json();
          if (typeof loadedPayload === 'object' && loadedPayload !== null && 'models' in loadedPayload && Array.isArray(loadedPayload.models)) {
            loadedNames = new Set(loadedPayload.models.flatMap((model: unknown) =>
              typeof model === 'object' && model !== null && 'name' in model && typeof model.name === 'string'
                ? [model.name]
                : [],
            ));
          }
        }
      } catch {
        // /api/ps is optional; installed model metadata is still useful.
      }

      const models: OllamaModelInfo[] = payload.models.flatMap((model: unknown) => {
        if (typeof model !== 'object' || model === null || !('name' in model) || typeof model.name !== 'string') return [];
        const details = 'details' in model && typeof model.details === 'object' && model.details !== null ? model.details : {};
        return [{
          name: model.name,
          sizeBytes: 'size' in model && typeof model.size === 'number' ? model.size : 0,
          parameterSize: 'parameter_size' in details && typeof details.parameter_size === 'string' ? details.parameter_size : '',
          quantizationLevel: 'quantization_level' in details && typeof details.quantization_level === 'string' ? details.quantization_level : '',
          loaded: loadedNames.has(model.name),
        }];
      });
      return { executablePath, endpoint, models };
    } catch {
      // Try the next standard local Ollama endpoint.
    }
  }
  return { executablePath, endpoint: null, models: [] };
}

ipcMain.handle('system:ollama-info', () => ollamaInfo());

ipcMain.handle('system:git-path', async () => {
  const pathValue = launcherEnvironment().PATH ?? '';
  const executableNames = process.platform === 'win32' ? ['git.exe', 'git.cmd', 'git.bat'] : ['git'];
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const executableName of executableNames) {
      const candidate = join(directory, executableName);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Keep looking through the same PATH Desktop gives the launcher.
      }
    }
  }
  return null;
});

function setApplicationMenu(): void {
  const appMenu: MenuItemConstructorOptions[] = [
    { role: 'about' },
    { type: 'separator' },
    {
      label: 'Launcher Status…',
      click: () => mainWindow?.webContents.send('launcher:status-requested'),
    },
  ];
  if (process.platform === 'darwin') {
    appMenu.push(
      { type: 'separator' },
      { role: 'services', submenu: [] },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
    );
  }
  appMenu.push({ type: 'separator' }, { role: 'quit' });

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.getName(), submenu: appMenu },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));
}

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
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
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
  setApplicationMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
