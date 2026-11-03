/// <reference types="vite/client" />

declare module 'virtual:app-config' {
  /** App header / browser-tab title (from app.toml). */
  export const appTitle: string;
}

interface Window {
  /** Electron preload bridge to the per-user runtime config (the XDG TOML file).
   *  Absent in the browser, which falls back to localStorage. */
  configBridge?: {
    read(): Promise<string | null>;
    write(toml: string): Promise<void>;
  };
  /** Electron preload bridge to the per-KB chat history (the XDG history.json file).
   *  Absent in the browser, which falls back to localStorage. */
  historyBridge?: {
    read(): Promise<string | null>;
    write(json: string): Promise<void>;
  };
  /** Electron preload bridge to UI preferences (the XDG prefs.json file).
   *  Absent in the browser, which falls back to localStorage. */
  prefsBridge?: {
    read(): Promise<string | null>;
    write(json: string): Promise<void>;
  };
  /** Electron preload bridge that appends a diagnostics line to the XDG `log.txt`.
   *  Absent in the browser (nothing to write to). */
  logBridge?: {
    append(line: string): void;
  };
  /** Electron preload bridge for split-view window sizing (grow on doc-open, restore on
   *  close). Absent in the browser — the split falls back to the swap when narrow. */
  windowBridge?: {
    ensureWidth(px: number): Promise<void>;
    restoreWidth(): Promise<void>;
  };
  /** Electron preload bridge to the knowledge bases' issuers: signing in, and the stored
   *  sessions. Absent in the browser, where no sign-in is possible. */
  authBridge?: import('./lib/auth-bridge').AuthBridge;
  /** Electron bridge for the prototype launcher-status menu action. */
  launcherBridge?: import('./lib/launcher-bridge').LauncherBridge;
}
