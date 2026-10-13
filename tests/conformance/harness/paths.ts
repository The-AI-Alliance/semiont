import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WeaverService } from './weaver-process';

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
    worker: [join(REPO_ROOT, 'target/release/semiont-worker-driver')],
  },
  python: {
    wire: [PYTHON, join(PYTHON_SDK, 'conformance/wire.py')],
    live: { command: [PYTHON, join(PYTHON_SDK, 'conformance/live.py')], tier: 'parity' },
    worker: [PYTHON, join(PYTHON_SDK, 'conformance/worker.py')],
  },
};

/**
 * How each implementation of the Worker service is started. The
 * worker-service suite runs each one with `--config <document>` and the
 * environment, and meets it on the bus, at the gateway's HTTP surface, at its
 * provider and at its health port (worker-service/README.md). An
 * implementation joins the suite by adding its line. vitest.config.ts
 * provides them as `workerServices`.
 */
/**
 * The model catalogue file a worker's document and a Librarian's each name:
 * the repository's one generated copy, which their images carry. A service
 * reads it only for a provider whose own API does not state a model's facts,
 * and no suite here runs one.
 */
export const MODEL_CATALOGUE = join(REPO_ROOT, 'packages/inference-python/tests/catalogue/model-catalogue.json');

export const WORKER_SERVICES: Readonly<Record<string, readonly string[]>> = {
  // The interpreter of the project's locked environment: nothing is resolved or installed when a case starts it.
  // `-P` keeps the directory a case starts it in off its import path, as the image's command does.
  python: [join(REPO_ROOT, 'apps/worker/.venv/bin/python'), '-P', '-m', 'semiont_worker'],
};

/**
 * How each implementation of the Weaver is started and reached. The weaver
 * suite runs each one with `--config <document>` and the environment, against
 * a real gateway, a real Archivist and a real neo4j, and meets it on the bus,
 * in the graph it writes and at its health port (weaver/README.md). An
 * implementation joins the suite by adding its line. vitest.config.ts
 * provides them as `weaverServices`.
 */
export const WEAVER_SERVICES: Readonly<Record<string, WeaverService>> = {
  // The interpreter of the project's locked environment: nothing is resolved or installed when a case starts it.
  // `-P` keeps the directory a case starts it in off its import path, as the image's command does.
  python: {
    command: [join(REPO_ROOT, 'apps/weaver/.venv/bin/python'), '-P', '-m', 'semiont_weaver'],
    healthPort: 24102,
  },
};

/**
 * How each implementation of the Smelter is started. The smelter suite runs
 * each one with `--config <document>` and the environment, against a real
 * gateway, a real Archivist, a real Qdrant and a stand-in for its embedding
 * provider, and meets it in the index and the anchored-text store it writes,
 * on the bus and at its health port (smelter/README.md). An implementation
 * joins the suite by adding its line. vitest.config.ts provides them as
 * `smelterServices`.
 */
export const SMELTER_SERVICES: Readonly<Record<string, readonly string[]>> = {
  // The interpreter of the project's locked environment: nothing is resolved or installed when a case starts it.
  // `-P` keeps the directory a case starts it in off its import path, as the image's command does.
  // It reads a scan with the `tesseract` program, which it finds on PATH.
  python: [join(REPO_ROOT, 'apps/smelter/.venv/bin/python'), '-P', '-m', 'semiont_smelter'],
};

/**
 * How each implementation of the Librarian is started. The librarian suite
 * runs each one with `--config <document>` and the environment, behind a real
 * gateway, beside a real Archivist, a Weaver and a Smelter, against a real
 * neo4j and a real Qdrant and stand-ins for its providers, and meets it on
 * the bus, at its providers and at its health port (librarian/README.md). An
 * implementation joins the suite by adding its line. vitest.config.ts
 * provides them as `librarianServices`.
 */
export const LIBRARIAN_SERVICES: Readonly<Record<string, readonly string[]>> = {
  // The interpreter of the project's locked environment: nothing is resolved or installed when a case starts it.
  // `-P` keeps the directory a case starts it in off its import path, as the image's command does.
  python: [join(REPO_ROOT, 'apps/librarian/.venv/bin/python'), '-P', '-m', 'semiont_librarian'],
};

export const SPEC_SOURCE = join(REPO_ROOT, 'specs/src');
