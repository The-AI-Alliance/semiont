import { app, BrowserWindow, dialog, Menu, net, protocol, screen, shell, type MenuItemConstructorOptions } from 'electron';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseAppManifest } from '../src/lib/app-manifest';
import { parseKbUri, parseUserConfig } from '../src/lib/user-config';
import type { McpProcessStatus } from '../src/lib/launcher-bridge';
import type { OllamaInfo, OllamaModelInfo } from '../src/lib/ollama-info';
import type { AgentHistoryMessage } from '../src/lib/agent-bridge';
import { isAgentModelId, isAgentProviderId } from '../src/lib/agent-bridge';
import { runLocalAgentTurn } from './agent-runtime';
import { registerAuthHandlers } from './auth';
import { ControlClient } from './control-client';
import { registerControlHandlers } from './control-ipc';
import { handleTrustedIpc, onTrustedIpc } from './ipc-security';
import { appendLog, configDir, logPath } from './paths';

protocol.registerSchemesAsPrivileged([{
  scheme: 'semiont-app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

registerAuthHandlers();

let mainWindow: BrowserWindow | null = null;
let mcpChild: ChildProcess | null = null;
let mcpStartedAt: number | null = null;
let mcpStopping = false;
let mcpError: string | null = null;
function configuredKbOrigins(toml: string | null): Set<string> {
  const origins = new Set<string>();
  if (toml === null) return origins;
  for (const kb of parseUserConfig(toml).kbs) {
    try {
      parseKbUri(kb.uri);
      origins.add(new URL(kb.uri).origin);
    } catch {
      // Invalid configured entries do not widen the renderer's network policy.
    }
  }
  return origins;
}

function kbRouteId(origin: string): string {
  return createHash('sha256').update(origin).digest('hex').slice(0, 32);
}

function configuredKbRoutes(toml: string | null): Map<string, string> {
  return new Map([...configuredKbOrigins(toml)].map((origin) => [kbRouteId(origin), origin]));
}

function rendererCsp(): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-src 'none'",
  ].join('; ');
}

function registerRendererProtocol(): void {
  protocol.handle('semiont-app', async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'desktop') return new Response('Not found', { status: 404 });
    if (url.pathname.startsWith('/kb/')) return proxyKnowledgeBaseRequest(request, url);
    if (request.method !== 'GET') return new Response('Not found', { status: 404 });
    let requestPath: string;
    try {
      requestPath = decodeURIComponent(url.pathname);
    } catch {
      return new Response('Bad path', { status: 400 });
    }
    const rendererRoot = resolve(__dirname, '../renderer');
    const filePath = resolve(rendererRoot, `.${requestPath.startsWith('/') ? requestPath : `/${requestPath}`}`);
    const fileRelative = relative(rendererRoot, filePath);
    if (fileRelative === '..' || fileRelative.startsWith(`..${sep}`) || fileRelative.startsWith(sep)) {
      return new Response('Not found', { status: 404 });
    }
    try {
      const fileResponse = await net.fetch(pathToFileURL(filePath).toString());
      if (!fileResponse.ok) return new Response('Not found', { status: 404 });
      const headers = new Headers(fileResponse.headers);
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Referrer-Policy', 'no-referrer');
      if (fileRelative === 'index.html') {
        headers.set('Content-Security-Policy', rendererCsp());
        headers.set('Cache-Control', 'no-store');
      }
      return new Response(fileResponse.body, { status: fileResponse.status, headers });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

const KB_REQUEST_HEADERS = new Set([
  'accept', 'authorization', 'content-type', 'if-match', 'if-none-match',
  'if-modified-since', 'if-unmodified-since', 'idempotency-key', 'last-event-id',
  'range', 'traceparent', 'tracestate', 'baggage',
]);
const KB_RESPONSE_HEADERS = new Set([
  'accept-ranges', 'cache-control', 'content-disposition', 'content-length',
  'content-range', 'content-type', 'etag', 'last-modified', 'vary',
]);

async function proxyKnowledgeBaseRequest(request: Request, appUrl: URL): Promise<Response> {
  const initiatorOrigin = (request as Request & { initiatorOrigin?: string }).initiatorOrigin;
  if (initiatorOrigin !== undefined && initiatorOrigin !== 'semiont-app://desktop') {
    return new Response('Forbidden', { status: 403 });
  }
  const match = /^\/kb\/([a-f0-9]{32})(\/.*)?$/u.exec(appUrl.pathname);
  if (match === null) return new Response('Not found', { status: 404 });
  const origin = configuredKbRoutes(readConfigText()).get(match[1]!);
  if (origin === undefined) return new Response('Knowledge Base route is not configured', { status: 404 });
  const upstreamUrl = new URL(`${match[2] ?? '/'}${appUrl.search}`, origin);
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
    return new Response('Method not allowed', { status: 405 });
  }

  const headers = new Headers();
  request.headers.forEach((value, name) => {
    if (KB_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  });
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    redirect: 'manual',
    signal: request.signal,
  };
  if (!['GET', 'HEAD'].includes(request.method) && request.body !== null) {
    init.body = request.body;
    init.duplex = 'half';
  }

  try {
    let response = await net.fetch(upstreamUrl.toString(), init);
    // Follow only safe, bodyless redirects which remain inside this configured KB.
    for (let redirects = 0; [301, 302, 303, 307, 308].includes(response.status); redirects += 1) {
      const location = response.headers.get('location');
      if (location === null) break;
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Knowledge Base redirect refused for a request with a body', { status: 502 });
      }
      if (redirects >= 5) return new Response('Too many Knowledge Base redirects', { status: 502 });
      const destination = new URL(location, upstreamUrl);
      if (destination.origin !== origin) return new Response('Cross-origin Knowledge Base redirect refused', { status: 502 });
      await response.body?.cancel();
      response = await net.fetch(destination.toString(), {
        method: request.method,
        headers,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'manual',
        signal: request.signal,
      });
      upstreamUrl.href = destination.href;
    }
    const safeHeaders = new Headers();
    response.headers.forEach((value, name) => {
      if (KB_RESPONSE_HEADERS.has(name.toLowerCase())) safeHeaders.set(name, value);
    });
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: safeHeaders,
    });
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    // Avoid logging request URLs, query tokens, auth headers, or response data.
    appendLog(`${new Date().toISOString()} [kb-proxy] ${request.method} ${appUrl.pathname} failed (${error instanceof Error ? error.name : 'unknown error'})`);
    return new Response('Knowledge Base request failed', { status: 502 });
  }
}

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

const control = new ControlClient(
  () => spawn(launcherPath(), ['control'], {
    cwd: app.getPath('home'),
    env: launcherEnvironment(),
    windowsHide: true,
  }),
  (line) => appendLog(`${new Date().toISOString()} [launcher] ${line}`),
);
registerControlHandlers(control);

handleTrustedIpc('dialog:choose-directory', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0] ?? null;
});

// Quitting waits for the launcher's control child to answer what it was asked and exit (at
// most SHUTDOWN_GRACE_MS), then exits directly. Calling app.quit() again from this async
// continuation can leave macOS with a closed window but a still-running app.
let quitInProgress = false;
app.on('before-quit', (event) => {
  event.preventDefault();
  if (quitInProgress) return;
  quitInProgress = true;
  void control.close()
    .catch((error: unknown) => appendLog(`${new Date().toISOString()} [quit] ${String(error)}`))
    .finally(() => app.exit(0));
});

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

handleTrustedIpc('system:ollama-info', () => ollamaInfo());

function validatedAgentToolCalls(value: unknown): AgentHistoryMessage['toolCalls'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls = value.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return [];
    const call = item as Record<string, unknown>;
    const args = call['arguments'];
    if (
      typeof call['name'] !== 'string' || typeof args !== 'object' || args === null || Array.isArray(args)
    ) return [];
    return [{ name: call['name'], arguments: args as Record<string, unknown> }];
  });
  return calls;
}

handleTrustedIpc('agent:complete', async (_event, input: unknown) => {
  const request = typeof input === 'object' && input !== null ? input as Record<string, unknown> : null;
  if (
    request === null ||
    !isAgentProviderId(request['provider']) ||
    !isAgentModelId(request['model']) ||
    typeof request['kbDid'] !== 'string' ||
    !Array.isArray(request['messages'])
  ) {
    throw new Error('Invalid Semiont agent request');
  }
  if (request['messages'].length > 80) throw new Error('Chat context is too long for one request');
  const messages: AgentHistoryMessage[] = request['messages'].flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return [];
    const message = item as Record<string, unknown>;
    if (!['user', 'assistant', 'tool'].includes(String(message['role'])) || typeof message['content'] !== 'string') return [];
    if (message['content'].length > 40_000) throw new Error('A chat message exceeds the Desktop limit');
    const toolCalls = validatedAgentToolCalls(message['toolCalls']);
    return [{
      role: message['role'] as AgentHistoryMessage['role'],
      content: message['content'],
      ...(typeof message['toolName'] === 'string' ? { toolName: message['toolName'] } : {}),
      ...(toolCalls !== undefined ? { toolCalls } : {}),
    }];
  });
  if (messages.length !== request['messages'].length || messages.at(-1)?.role !== 'user') {
    throw new Error('Invalid Semiont agent conversation messages');
  }
  const info = await ollamaInfo();
  if (info.endpoint === null) throw new Error('Ollama is not reachable. Start Ollama and try again.');
  if (!info.models.some((model) => model.name === request['model'])) {
    throw new Error(`Ollama is reachable, but ${request['model']} is not installed. Pull it with \`ollama pull ${request['model']}\`.`);
  }
  return runLocalAgentTurn({
    endpoint: info.endpoint,
    launcherPath: launcherPath(),
    env: launcherEnvironment(),
    cwd: app.getPath('home'),
    kbDid: request['kbDid'],
    model: request['model'],
    messages,
    confirmDestructiveTool: async (toolName, args) => {
      if (mainWindow === null || mainWindow.isDestroyed()) return false;
      const confirmation = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Confirm Semiont action',
        message: `Allow “${toolName}” to make this change?`,
        detail: JSON.stringify(args, null, 2).slice(0, 1800),
        buttons: ['Cancel', 'Allow once'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return confirmation.response === 1;
    },
  });
});

handleTrustedIpc('system:git-path', async () => {
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

handleTrustedIpc('system:op-path', async () => {
  const pathValue = launcherEnvironment().PATH ?? '';
  const executableNames = process.platform === 'win32' ? ['op.exe'] : ['op'];
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

async function mcpProcessStatus(): Promise<McpProcessStatus> {
  const child = mcpChild;
  if (child === null) {
    return {
      state: mcpError === null ? 'stopped' : 'failed',
      pid: null,
      startedAt: null,
      memoryBytes: null,
      cpuPercent: null,
      error: mcpError,
    };
  }

  const pid = child.pid ?? null;
  let memoryBytes: number | null = null;
  let cpuPercent: number | null = null;
  if (pid !== null && !mcpStopping) {
    const stats = await new Promise<{ memoryBytes: number | null; cpuPercent: number | null }>((resolve) => {
      execFile('ps', ['-o', 'rss=', '-o', '%cpu=', '-p', String(pid)], { encoding: 'utf8' }, (error, output) => {
        const values = output.trim().match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/);
        const memoryKb = values === null ? null : Number(values[1]);
        const cpu = values === null ? null : Number(values[2]);
        resolve({
          memoryBytes: error === null && memoryKb !== null && Number.isFinite(memoryKb) ? memoryKb * 1024 : null,
          cpuPercent: error === null && cpu !== null && Number.isFinite(cpu) ? cpu : null,
        });
      });
    });
    memoryBytes = stats.memoryBytes;
    cpuPercent = stats.cpuPercent;
  }

  return {
    state: mcpStopping ? 'stopping' : pid === null ? 'starting' : 'running',
    pid,
    startedAt: mcpStartedAt,
    memoryBytes,
    cpuPercent,
    error: null,
  };
}

handleTrustedIpc('mcp:status', () => mcpProcessStatus());

handleTrustedIpc('mcp:start', async () => {
  if (mcpChild !== null) return mcpProcessStatus();
  mcpError = null;
  mcpStopping = false;
  const child = spawn(launcherPath(), ['mcp'], {
    cwd: app.getPath('home'),
    env: launcherEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  mcpChild = child;
  mcpStartedAt = Date.now();
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});
  child.once('error', (error) => {
    mcpError = error.message;
    if (mcpChild === child) {
      mcpChild = null;
      mcpStartedAt = null;
    }
  });
  child.once('close', (code, signal) => {
    if (mcpChild !== child) return;
    if (!mcpStopping && (code !== 0 || signal !== null)) {
      mcpError = `semiont mcp exited${code === null ? '' : ` with code ${code}`}${signal === null ? '' : ` (${signal})`}.`;
    }
    mcpChild = null;
    mcpStartedAt = null;
    mcpStopping = false;
  });

  await new Promise<void>((resolve) => {
    child.once('spawn', resolve);
    child.once('error', resolve);
  });
  return mcpProcessStatus();
});

handleTrustedIpc('mcp:stop', async () => {
  const child = mcpChild;
  if (child === null) return mcpProcessStatus();
  mcpStopping = true;
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  child.kill('SIGTERM');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const stopped = await Promise.race([
    closed.then(() => true),
    new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), 3000);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  if (!stopped) {
    child.kill('SIGKILL');
    await closed;
  }
  return mcpProcessStatus();
});

app.on('before-quit', () => {
  if (mcpChild !== null && mcpChild.exitCode === null && mcpChild.signalCode === null) {
    mcpChild.kill('SIGTERM');
  }
});

function setApplicationMenu(): void {
  const appMenu: MenuItemConstructorOptions[] = [
    {
      label: `About ${app.getName()}`,
      click: () => mainWindow?.webContents.send('about:requested'),
    },
    { type: 'separator' },
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

  const fileMenu: MenuItemConstructorOptions[] = [
    {
      label: 'Print…',
      accelerator: 'CommandOrControl+P',
      click: () => {
        if (mainWindow === null || mainWindow.isDestroyed()) return;
        mainWindow.webContents.print({ printBackground: true }, (success, failureReason) => {
          if (!success) appendLog(`${new Date().toISOString()} [print] ${failureReason}`);
        });
      },
    },
  ];

  const viewMenu: MenuItemConstructorOptions[] = [
    {
      label: 'Reload',
      accelerator: 'CommandOrControl+R',
      click: () => mainWindow?.webContents.send('documents:reload-requested'),
    },
    { role: 'forceReload' },
    { type: 'separator' },
    { role: 'toggleDevTools' },
    { type: 'separator' },
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.getName(), submenu: appMenu },
    { label: 'File', submenu: fileMenu },
    { role: 'editMenu' },
    { label: 'View', submenu: viewMenu },
    { role: 'windowMenu' },
  ]));
}

onTrustedIpc('log:append', (_event, line: string) => appendLog(String(line)));
process.on('uncaughtException', (err) => appendLog(`${new Date().toISOString()} [main uncaught] ${err.stack ?? String(err)}`));

// Per-user runtime config (the KBs): an XDG TOML file at
// $XDG_CONFIG_HOME/semiont-desktop/config.toml (default ~/.config/…). The
// renderer reads/writes it through `window.configBridge` (see preload.ts).
function configPath(): string {
  return join(configDir(), 'config.toml');
}

function readConfigText(): string | null {
  const path = configPath();
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

handleTrustedIpc('config:read', () => {
  return readConfigText();
});

handleTrustedIpc('config:write', (_event, toml: string) => {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, toml, { mode: 0o600 });
  chmodSync(path, 0o600); // enforce 0600 on an existing file too
});

handleTrustedIpc('config:kb-route', (_event, gatewayUrl: string) => {
  let origin: string;
  try {
    parseKbUri(gatewayUrl);
    origin = new URL(gatewayUrl).origin;
  } catch {
    throw new Error('Invalid Knowledge Base gateway URL');
  }
  if (!configuredKbOrigins(readConfigText()).has(origin)) {
    throw new Error('Knowledge Base gateway is not in the saved Desktop configuration');
  }
  return `semiont-app://desktop/kb/${kbRouteId(origin)}`;
});

// Chat history — same XDG dir, a JSON file. localStorage isn't reliably persisted for
// file:// origins in the packaged app, so the renderer routes history through here too
// (window.historyBridge). 0600 since it holds conversation content.
function historyPath(): string {
  return join(configDir(), 'history.json');
}

handleTrustedIpc('history:read', () => {
  const path = historyPath();
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
});

handleTrustedIpc('history:write', (_event, json: string) => {
  const path = historyPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, json, { mode: 0o600 });
});

// UI preferences (e.g. sidebar width) — same XDG dir, a JSON file. Routed through the
// main process for the same file:// localStorage reason; not credentials, so no 0600.
function prefsPath(): string {
  return join(configDir(), 'prefs.json');
}

handleTrustedIpc('prefs:read', () => {
  const path = prefsPath();
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
});

handleTrustedIpc('prefs:write', (_event, json: string) => {
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

handleTrustedIpc('window:ensure-width', (event, desired: number) => {
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

handleTrustedIpc('window:restore-width', (event) => {
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

  // Only the app document may stay in this window. In development, allow the
  // local Vite origin; in packaged builds, allow only the app's index document.
  // Links to external sites are handled separately by setWindowOpenHandler.
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  let devOrigin: string | null = null;
  if (devUrl !== undefined) {
    try {
      const candidate = new URL(devUrl);
      if (candidate.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(candidate.hostname)) {
        devOrigin = candidate.origin;
      }
    } catch {
      // An invalid dev URL cannot widen the allowed navigation boundary.
    }
  }
  const allowTopLevelNavigation = (candidateUrl: string): boolean => {
    try {
      const candidate = new URL(candidateUrl);
      return devOrigin !== null
        ? candidate.origin === devOrigin
        : candidate.protocol === 'semiont-app:' && candidate.hostname === 'desktop' && candidate.pathname === '/index.html';
    } catch {
      return false;
    }
  };
  const blockUnexpectedNavigation = (event: Electron.Event, candidateUrl: string) => {
    if (allowTopLevelNavigation(candidateUrl)) return;
    event.preventDefault();
    appendLog(`${new Date().toISOString()} [navigation] blocked top-level navigation`);
  };
  win.webContents.on('will-navigate', blockUnexpectedNavigation);
  win.webContents.on('will-redirect', blockUnexpectedNavigation);

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
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadURL('semiont-app://desktop/index.html');
  }
}

void app.whenReady().then(() => {
  registerRendererProtocol();
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
