import { parseUserConfig, serializeUserConfig, EMPTY_USER_CONFIG, type UserConfig } from './user-config';

const STORAGE_KEY = 'semiont-desktop.user-config';
const OLD_STORAGE_KEY = 'document-grounded-chat.user-config';

/**
 * Load/save the per-user runtime config. In Electron the preload exposes
 * `window.configBridge`, backed by the XDG file
 * (`~/.config/semiont-desktop/config.toml`); in the browser it falls back to
 * localStorage. Both store the same TOML, so there's one parse/serialize path.
 */
export async function loadUserConfig(): Promise<UserConfig> {
  const bridge = typeof window !== 'undefined' ? window.configBridge : undefined;
  const toml = bridge
    ? await bridge.read()
    : typeof localStorage !== 'undefined'
      ? (localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(OLD_STORAGE_KEY))
      : null;
  return toml ? parseUserConfig(toml) : { ...EMPTY_USER_CONFIG };
}

export async function saveUserConfig(config: UserConfig): Promise<void> {
  const toml = serializeUserConfig(config);
  const bridge = typeof window !== 'undefined' ? window.configBridge : undefined;
  if (bridge) {
    await bridge.write(toml);
    return;
  }
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, toml);
    localStorage.removeItem(OLD_STORAGE_KEY);
  }
}
