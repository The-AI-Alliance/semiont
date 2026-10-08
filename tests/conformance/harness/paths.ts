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

/**
 * How an Archivist is started. The Archivist suite runs it with
 * `--config <document>` and the environment, and meets it on the bus, at its
 * HTTP surface, and in the files it keeps. vitest.config.ts provides it as
 * `archivistCommand`.
 */
export const ARCHIVIST_COMMAND: readonly string[] = [join(REPO_ROOT, 'target/release/semiont-archivist')];

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
  /** How its worker driver is started, when the SDK has a worker's surface (worker/README.md). */
  worker?: readonly string[];
  /**
   * The wire cases its driver cannot be put through, each with why. The suite
   * holds an exemption as it holds a case: the driver must answer
   * `unsupported` to what the case asks, or the exemption is stale.
   */
  exempt?: Readonly<Record<string, string>>;
}

/** The Python SDK, and the interpreter of its locked environment, which the suite's setup makes. */
export const PYTHON_SDK = join(REPO_ROOT, 'packages/sdk-python');
const PYTHON = join(PYTHON_SDK, '.venv/bin/python');

/**
 * Each SDK's drivers. An SDK joins a layer of the suite by adding its line.
 * vitest.config.ts provides them as `sdkDrivers`.
 */
export const SDK_DRIVERS: Readonly<Record<string, SdkDrivers>> = {
  typescript: {
    wire: ['node', join(REPO_ROOT, 'packages/http-transport/conformance/driver.ts')],
    live: { command: ['node', join(REPO_ROOT, 'packages/sdk/conformance/driver.ts')], tier: 'parity' },
    worker: ['node', join(REPO_ROOT, 'packages/sdk/conformance/worker-driver.ts')],
  },
  rust: {
    wire: [join(REPO_ROOT, 'target/release/semiont-wire-driver')],
    live: { command: [join(REPO_ROOT, 'target/release/semiont-live-driver')], tier: 'parity' },
  },
  python: {
    wire: [PYTHON, join(PYTHON_SDK, 'conformance/wire.py')],
    live: { command: [PYTHON, join(PYTHON_SDK, 'conformance/live.py')], tier: 'parity' },
  },
};

export const SPEC_SOURCE = join(REPO_ROOT, 'specs/src');
