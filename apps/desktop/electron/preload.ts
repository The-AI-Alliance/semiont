import { contextBridge, ipcRenderer } from 'electron';
import type { AuthBridge } from '../src/lib/auth-bridge';
import type { LauncherBridge } from '../src/lib/launcher-bridge';

/** The main process answers a sign-in or a resume as `{ value }` or `{ error }` (a sentence
 *  a person may read); thrown here, it reaches the renderer unwrapped. */
async function answer<T>(pending: Promise<{ value: T } | { error: string }>): Promise<T> {
  const outcome = await pending;
  if ('error' in outcome) throw new Error(outcome.error);
  return outcome.value;
}

// Bridge the per-user runtime config (the XDG TOML file) to the renderer on
// `window.configBridge`. The renderer reads/writes it via src/lib/config-store.ts;
// the actual file I/O happens in the main process (config:read / config:write).
contextBridge.exposeInMainWorld('configBridge', {
  read: (): Promise<string | null> => ipcRenderer.invoke('config:read'),
  write: (toml: string): Promise<void> => ipcRenderer.invoke('config:write', toml),
});

// Chat history bridge — same pattern, backed by the XDG history.json (file:// localStorage
// isn't reliably persisted in the packaged app). The renderer uses it via src/lib/chat-history.ts.
contextBridge.exposeInMainWorld('historyBridge', {
  read: (): Promise<string | null> => ipcRenderer.invoke('history:read'),
  write: (json: string): Promise<void> => ipcRenderer.invoke('history:write', json),
});

// UI preferences bridge — same pattern, backed by the XDG prefs.json. Used via src/lib/prefs.ts.
contextBridge.exposeInMainWorld('prefsBridge', {
  read: (): Promise<string | null> => ipcRenderer.invoke('prefs:read'),
  write: (json: string): Promise<void> => ipcRenderer.invoke('prefs:write', json),
});

// Diagnostics: forward renderer errors/console output to an XDG log file (via the main
// process). Fire-and-forget — logging must never block or throw in the renderer. Used via
// src/lib/error-log.ts.
contextBridge.exposeInMainWorld('logBridge', {
  append: (line: string): void => ipcRenderer.send('log:append', line),
});

// Split-view window sizing: grow the window when a document opens beside the chat and
// restore on close (main process owns the policy — work-area clamp, untouched-only restore).
contextBridge.exposeInMainWorld('windowBridge', {
  ensureWidth: (px: number): Promise<void> => ipcRenderer.invoke('window:ensure-width', px),
  restoreWidth: (): Promise<void> => ipcRenderer.invoke('window:restore-width'),
});

// Signing in, and the stored sessions: the main process talks to each knowledge base's
// issuer and keeps the tokens (electron/auth.ts). Used via src/lib/session.ts.
const authBridge: AuthBridge = {
  resume: (kbId) => answer(ipcRenderer.invoke('auth:resume', kbId)),
  signIn: (kbId, address) => answer(ipcRenderer.invoke('auth:sign-in', kbId, address)),
  refresh: (kbId) => ipcRenderer.invoke('auth:refresh', kbId),
  signOut: (kbId) => ipcRenderer.invoke('auth:sign-out', kbId),
};
contextBridge.exposeInMainWorld('authBridge', authBridge);

const launcherBridge: LauncherBridge = {
  onStatusRequested(listener) {
    const handler = () => listener();
    ipcRenderer.on('launcher:status-requested', handler);
    return () => ipcRenderer.removeListener('launcher:status-requested', handler);
  },
  status: () => ipcRenderer.invoke('launcher:status'),
  about: () => ipcRenderer.invoke('launcher:about'),
  gitPath: () => ipcRenderer.invoke('system:git-path'),
  opPath: () => ipcRenderer.invoke('system:op-path'),
  ollamaInfo: () => ipcRenderer.invoke('system:ollama-info'),
};
contextBridge.exposeInMainWorld('launcherBridge', launcherBridge);
