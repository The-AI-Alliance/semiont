import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * How a gateway is started. The one line that names an implementation: the
 * suite starts whatever this runs, hands it the configuration document and
 * the environment, and talks to it over HTTP. vitest.config.ts provides it to
 * the cases as `gatewayCommand`.
 */
export const GATEWAY_COMMAND: readonly string[] = [join(REPO_ROOT, 'apps/gateway/target/release/semiont-gateway')];

export const SPEC_SOURCE = join(REPO_ROOT, 'specs/src');
