import { parse as parseToml } from 'smol-toml';
import { isObject, isString } from '@semiont/core';

/**
 * Build-time app config, from `app.toml`. Defines how the app presents itself —
 * baked into the build (read by the Vite plugin), never holds credentials.
 */
export interface AppManifest {
  title: string;
}

const DEFAULTS: AppManifest = {
  title: 'Semiont Desktop',
};

/** Parse `app.toml` (or fall back to defaults when absent or partial). Pure. */
export function parseAppManifest(toml: string | null): AppManifest {
  if (toml === null) return { ...DEFAULTS };
  const root = parseToml(toml);
  const app = isObject(root) && isObject(root.app) ? root.app : {};
  return {
    title: isString(app.title) ? app.title : DEFAULTS.title,
  };
}
