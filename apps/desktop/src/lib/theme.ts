import { getPref, setPref } from './prefs';

/**
 * Colour theme. Persisted via prefs (XDG file in Electron / localStorage on the web) and
 * applied as `data-theme="light|dark"` on `<html>` — the attribute both this app's CSS and
 * `@semiont/react-ui`'s ResourceViewer CSS key off, so the whole window (including an open
 * document) themes together. `system` follows the OS preference live.
 */
export type Theme = 'light' | 'dark' | 'system';

const THEME_KEY = 'theme';

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Resolve `system` to the OS preference and set `data-theme` on the root element. */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const resolved = theme === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : theme;
  document.documentElement.setAttribute('data-theme', resolved);
}

export async function loadTheme(): Promise<Theme> {
  const t = await getPref<Theme>(THEME_KEY, 'system');
  return t === 'light' || t === 'dark' || t === 'system' ? t : 'system';
}

export async function saveTheme(theme: Theme): Promise<void> {
  await setPref(THEME_KEY, theme);
}
