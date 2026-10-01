import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * How a gateway is started. One of the lines that name an implementation:
 * the suites start whatever this runs, hand it the configuration document and
 * the environment, and talk to it over HTTP. vitest.config.ts provides it to
 * the cases as `gatewayCommand`.
 */
export const GATEWAY_COMMAND: readonly string[] = [join(REPO_ROOT, 'target/release/semiont-gateway')];

/**
 * How a dispatcher is started. The dispatcher suite runs it
 * with `--config <document>` and the environment, and meets it only on the bus
 * and its health port. vitest.config.ts provides it as `dispatcherCommand`.
 */
export const DISPATCHER_COMMAND: readonly string[] = [join(REPO_ROOT, 'target/release/semiont-dispatcher')];

/** An SDK's drivers: the programs the SDK suite talks to in that SDK's place (sdk/README.md § The driver protocol). */
export interface SdkDrivers {
  /** How its wire driver is started. */
  wire?: readonly string[];
  /**
   * How its live driver is started, and the tier of the live corpus the SDK
   * is held to: `fleet`, what every live layer does, or `parity`, all of
   * CACHE-SEMANTICS.
   */
  live?: { command: readonly string[]; tier: 'fleet' | 'parity' };
  /**
   * The wire cases its driver cannot be put through, each with why. The suite
   * holds an exemption as it holds a case: the driver must answer
   * `unsupported` to what the case asks, or the exemption is stale.
   */
  exempt?: Readonly<Record<string, string>>;
}

/**
 * Each SDK's drivers. An SDK joins a layer of the suite by adding its line.
 * vitest.config.ts provides them as `sdkDrivers`.
 */
export const SDK_DRIVERS: Readonly<Record<string, SdkDrivers>> = {
  typescript: {
    wire: ['node', join(REPO_ROOT, 'packages/http-transport/conformance/driver.ts')],
    live: { command: ['node', join(REPO_ROOT, 'packages/sdk/conformance/driver.ts')], tier: 'parity' },
    exempt: {
      'upload-progress': 'the transport reports an upload\'s progress through XMLHttpRequest, which a browser has and Node, where the driver runs, does not',
      'upload-cancelled': 'the transport cancels an upload through XMLHttpRequest, which a browser has and Node, where the driver runs, does not',
    },
  },
  rust: {
    wire: [join(REPO_ROOT, 'target/release/semiont-wire-driver')],
  },
};

export const SPEC_SOURCE = join(REPO_ROOT, 'specs/src');
