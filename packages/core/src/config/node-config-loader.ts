import { serviceAccountToken, type ServiceAccountCredential } from '../service-account';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTomlConfigLoader, DEFAULT_ARCHIVIST_PORT } from './toml-loader.js';
import type { ConfigService } from '../generated/service-config-sections.js';
import type { ArchivistServiceConfig, EnvironmentConfig } from './config.types.js';

export { SemiontProject, SemiontState } from '../project.js';

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
 * A service names itself, and may then read only the sections
 * specs/src/service-config/sections.json lists for it; a tool names none.
 */
export function loadEnvironmentConfig(
  projectRoot: string | null,
  options: { environment?: string; service?: ConfigService } = {},
): EnvironmentConfig {
  const globalConfigPath = path.join(os.homedir(), '.semiontconfig');
  return createTomlConfigLoader(
    nodeTomlFileReader,
    globalConfigPath,
    process.env,
    options.service,
  )(projectRoot, options.environment);
}

/**
 * The slice of config the Archivist's address needs — nothing wider, and
 * DERIVED from the schema's own service type rather than restating
 * `host`/`port`.
 */
export interface ArchivistAddressConfig {
  services?: {
    archivist?: Pick<ArchivistServiceConfig, 'host' | 'port'>;
  };
}

/**
 * Base URL and auth header for the Archivist, resolved together because they
 * are useless apart. Throws on either absence.
 *
 * Lives HERE, and not with the byte reads that ride it, because it is neither
 * a content concern nor a make-meaning one: it is a config value plus a
 * credential, and config is what this module already is.
 *
 * Absence fails loudly. A missing host or credential is a misconfiguration,
 * never a reason to fall back to reading a tree locally: the point is that
 * exactly one process, the Archivist, touches it.
 *
 * Split in two on purpose. `archivistAddress` validates the configuration
 * SYNCHRONOUSLY, so a process with no Archivist address or no credential dies
 * at construction while an operator is watching rather than failing every read
 * quietly later. `archivistEndpoint` adds the token, which is inherently async.
 *
 * The credential is a TOKEN, obtained from the issuer with this process's own
 * service account. The Archivist verifies it against the issuer's published
 * keys: it serves the event log and accepts byte writes, and the token guards
 * both.
 *
 * The credential is a PARAMETER, and the issuer travels inside it, so the
 * function's whole dependency appears in its signature. Nothing here reads
 * `process.env`: each entry point reads its service-account pair at its own
 * boundary, builds the credential, and passes it in — which also lets a caller
 * stub one, or hold two.
 */
export function archivistAddress(
  config: ArchivistAddressConfig,
  credential: ServiceAccountCredential,
): { base: string; credential: ServiceAccountCredential } {
  const host = config.services?.archivist?.host;
  if (!host) {
    throw new Error('services.archivist.host is not configured — cannot reach the record');
  }
  const port = config.services?.archivist?.port ?? DEFAULT_ARCHIVIST_PORT;
  return { base: `http://${host}:${port}`, credential };
}

export async function archivistEndpoint(
  config: ArchivistAddressConfig,
  credential: ServiceAccountCredential,
): Promise<{ base: string; headers: { authorization: string } }> {
  const { base } = archivistAddress(config, credential);
  const token = await serviceAccountToken(credential);
  return { base, headers: { authorization: `Bearer ${token}` } };
}
