import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTomlConfigLoader, DEFAULT_ARCHIVIST_PORT } from './toml-loader.js';
import type { ArchivistServiceConfig, EnvironmentConfig } from './config.types.js';

export { SemiontProject, SemiontState, stateDirFor } from '../project.js';

const nodeTomlFileReader = {
  readIfExists: (filePath: string): string | null =>
    fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null,
};

/**
 * Load semiont environment config for a Node.js process.
 *
 * Reads ~/.semiontconfig (global) merged with .semiont/config (project-local),
 * then selects the given environment overlay.
 *
 * This is the canonical config loader for any Node.js process. The environment
 * is resolved by the loader itself — an explicit `environment` argument, else
 * `[defaults] environment` from the committed config — so entry points call this
 * without selecting one; one config selects the environment for the gateway the
 * same way the launcher selects it. There is no environment-variable override.
 */
export function loadEnvironmentConfig(
  projectRoot: string | null,
  environment?: string
): EnvironmentConfig {
  const globalConfigPath = path.join(os.homedir(), '.semiontconfig');
  return createTomlConfigLoader(
    nodeTomlFileReader,
    globalConfigPath,
    process.env
  )(projectRoot, environment);
}

/**
 * The slice of config the Archivist's address needs — nothing wider, and
 * DERIVED from the schema's own service type rather than restating
 * `host`/`port`.
 */
export interface ArchivistAddressConfig {
  services?: { archivist?: Pick<ArchivistServiceConfig, 'host' | 'port'> };
}

/**
 * Base URL and auth header for the Archivist, resolved together because they
 * are useless apart. Throws on either absence.
 *
 * Lives HERE, and not with the byte reads that ride it, because it is neither
 * a content concern nor a make-meaning one: it is a config value plus an
 * environment variable, which is exactly what this module already is. Putting
 * it in `@semiont/content` gave the gateway a runtime edge to a package it
 * otherwise touches only for types — and since that package is a
 * devDependency there, the bundler INLINED its PDF/OCR stack into an ESM
 * bundle and the process died at load on a CJS `require`.
 *
 * Absence fails loudly. A missing host or secret is a misconfiguration, never
 * a reason to fall back to reading a tree locally: the point of
 * SINGLE-KB-MOUNT is that exactly one process touches it.
 */
export function archivistEndpoint(config: ArchivistAddressConfig): {
  base: string;
  headers: { authorization: string };
} {
  const host = config.services?.archivist?.host;
  if (!host) {
    throw new Error('services.archivist.host is not configured — cannot reach the record');
  }
  const port = config.services?.archivist?.port ?? DEFAULT_ARCHIVIST_PORT;
  const secret = process.env.SEMIONT_WORKER_SECRET;
  if (!secret) {
    throw new Error('SEMIONT_WORKER_SECRET is not set — cannot authenticate to the Archivist');
  }
  return { base: `http://${host}:${port}`, headers: { authorization: `Bearer ${secret}` } };
}
