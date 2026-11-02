import { existsSync, readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
import { parseAppManifest } from './src/lib/app-manifest.ts';

/**
 * Bake the build-time app manifest (`app.toml`) into the renderer via the virtual
 * module `virtual:app-config` — currently just `appTitle`. No credentials: those are
 * per-user runtime config (managed in the nav), never baked into the build.
 */
export function appConfigPlugin(): Plugin {
  const VIRTUAL = 'virtual:app-config';
  const RESOLVED = '\0' + VIRTUAL;
  return {
    name: 'app-config',
    resolveId(id) {
      return id === VIRTUAL ? RESOLVED : null;
    },
    load(id) {
      if (id !== RESOLVED) return null;
      const toml = existsSync('app.toml') ? readFileSync('app.toml', 'utf8') : null;
      const manifest = parseAppManifest(toml);
      return `export const appTitle = ${JSON.stringify(manifest.title)};`;
    },
  };
}
