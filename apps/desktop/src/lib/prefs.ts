/**
 * Small key-value app preferences (e.g. the sidebar width). In Electron these persist
 * via the main process (`window.prefsBridge` → a JSON file in the XDG dir), since
 * file:// localStorage isn't reliably persisted in the packaged app; on the web they
 * use localStorage. One JSON object holds them all.
 */
const STORE_KEY = 'semiont-desktop.prefs';
const OLD_STORE_KEY = 'document-grounded-chat.prefs';
type Prefs = Record<string, unknown>;

async function readRaw(): Promise<string | null> {
  if (typeof window !== 'undefined' && window.prefsBridge) return window.prefsBridge.read();
  if (typeof localStorage !== 'undefined') return localStorage.getItem(STORE_KEY) ?? localStorage.getItem(OLD_STORE_KEY);
  return null;
}

async function writeRaw(json: string): Promise<void> {
  if (typeof window !== 'undefined' && window.prefsBridge) {
    await window.prefsBridge.write(json);
    return;
  }
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(STORE_KEY, json);
    localStorage.removeItem(OLD_STORE_KEY);
  }
}

let cache: Prefs | null = null;

async function prefs(): Promise<Prefs> {
  if (cache) return cache;
  try {
    const raw = await readRaw();
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    cache = parsed !== null && typeof parsed === 'object' ? (parsed as Prefs) : {};
  } catch {
    cache = {};
  }
  return cache;
}

export async function getPref<T>(key: string, fallback: T): Promise<T> {
  const value = (await prefs())[key];
  return value === undefined ? fallback : (value as T);
}

export async function setPref(key: string, value: unknown): Promise<void> {
  try {
    const p = await prefs();
    p[key] = value;
    await writeRaw(JSON.stringify(p));
  } catch {
    // best-effort — pref loss is non-fatal
  }
}
