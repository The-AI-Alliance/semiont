import { serviceAccountToken, type ServiceAccountCredential } from '../service-account';
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
  services?: {
    archivist?: Pick<ArchivistServiceConfig, 'host' | 'port'>;
    /** Where this process authenticates before dialling the Archivist. */
    identity?: { issuer: string };
  };
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
 * Absence fails loudly. A missing host or credential is a misconfiguration,
 * never a reason to fall back to reading a tree locally: the point of
 * SINGLE-KB-MOUNT is that exactly one process touches it.
 *
 * Split in two on purpose. `archivistAddress` validates the configuration
 * SYNCHRONOUSLY, so a process with no Archivist address or no credential dies
 * at construction while an operator is watching rather than failing every read
 * quietly later. `archivistEndpoint` adds the token, which is inherently async.
 *
 * The credential is a TOKEN now, obtained from the issuer with this process's
 * own service account, rather than a shared static string read out of the
 * environment. The Archivist verifies it against the issuer's
 * published keys — it serves the event log and accepts byte writes, and a
 * string compared by equality was guarding both.
 */
export function archivistAddress(config: ArchivistAddressConfig): {
  base: string;
  credential: ServiceAccountCredential;
} {
  const host = config.services?.archivist?.host;
  if (!host) {
    throw new Error('services.archivist.host is not configured — cannot reach the record');
  }
  const port = config.services?.archivist?.port ?? DEFAULT_ARCHIVIST_PORT;
  const issuer = config.services?.identity?.issuer;
  if (!issuer) {
    throw new Error('services.identity.issuer is not configured — cannot authenticate to the Archivist');
  }
  const clientId = process.env.SEMIONT_OIDC_CLIENT_ID;
  const clientSecret = process.env.SEMIONT_OIDC_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'SEMIONT_OIDC_CLIENT_ID and SEMIONT_OIDC_CLIENT_SECRET are not set — cannot authenticate to the Archivist',
    );
  }
  return { base: `http://${host}:${port}`, credential: { issuer, clientId, clientSecret } };
}

export async function archivistEndpoint(config: ArchivistAddressConfig): Promise<{
  base: string;
  headers: { authorization: string };
}> {
  const { base, credential } = archivistAddress(config);
  const token = await serviceAccountToken(credential);
  return { base, headers: { authorization: `Bearer ${token}` } };
}
