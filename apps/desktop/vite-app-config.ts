import { existsSync, readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
import { parseAppManifest } from './src/lib/app-manifest.ts';

/**
 * Bake the build-time app manifest (`app.toml`) into the renderer via the virtual
 * module `virtual:app-config` — app title and package version. No credentials: those are
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
      const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { version?: unknown };
      const packageVersion = typeof packageJson.version === 'string' ? packageJson.version : 'unknown';
      const appVersion = process.env.SEMIONT_BUILD_VERSION ?? packageVersion;
      const appCommit = process.env.SEMIONT_BUILD_COMMIT ?? 'unknown';
      const appBuildDate = process.env.SEMIONT_BUILD_DATE ?? 'unknown';
      return [
        `export const appTitle = ${JSON.stringify(manifest.title)};`,
        `export const appVersion = ${JSON.stringify(appVersion)};`,
        `export const appCommit = ${JSON.stringify(appCommit)};`,
        `export const appBuildDate = ${JSON.stringify(appBuildDate)};`,
      ].join('\n');
    },
  };
}
