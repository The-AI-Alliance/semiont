import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * How a gateway is started. One of the two lines that name an implementation:
 * the suites start whatever this runs, hand it the configuration document and
 * the environment, and talk to it over HTTP. vitest.config.ts provides it to
 * the cases as `gatewayCommand`.
 */
export const GATEWAY_COMMAND: readonly string[] = [join(REPO_ROOT, 'apps/gateway/target/release/semiont-gateway')];

/**
 * How a dispatcher is started: the other line. The dispatcher suite runs it
 * with `--config <document>` and the environment, and meets it only on the bus
 * and its health port. vitest.config.ts provides it as `dispatcherCommand`.
 */
export const DISPATCHER_COMMAND: readonly string[] = ['node', join(REPO_ROOT, 'packages/make-meaning/dist/dispatcher-main.js')];

export const SPEC_SOURCE = join(REPO_ROOT, 'specs/src');
