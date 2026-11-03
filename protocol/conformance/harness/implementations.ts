/**
 * The implementations a run is held to, read from the JSON file it names after
 * vitest's own arguments: `vitest run --project <suite> -- --implementations
 * <file>`. The kit's npm scripts name semiont.implementations.json, Semiont's
 * own builds; another implementation writes a file of its own and names that.
 * There is no default: a run that names no file, or names one twice, refuses
 * to start, and so does a file that is not of the shape below.
 *
 * Every list of strings in the file is the argument list a suite starts a
 * process with. An argument that starts with `./` or `../` is a path, resolved
 * against the file's own directory; every other argument is passed as written.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Ajv, type JTDDataType } from 'ajv/dist/jtd.js';

const COMMAND = { elements: { type: 'string' } } as const;

/** The file's shape, as a JSON Type Definition (RFC 8927). The types below are derived from it. */
const SCHEMA = {
  properties: {
    /** How a gateway is started: the suites hand it its configuration document and talk to it over HTTP. */
    gateway: COMMAND,
    /** How a dispatcher is started: run with `--config <document>`, met on the bus and at its health port. */
    dispatcher: COMMAND,
    /** How an Archivist is started: run with `--config <document>`, met on the bus, at its HTTP surface and in the files it keeps. */
    archivist: COMMAND,
    /** Each SDK's drivers, the programs the SDK and worker suites talk to in that SDK's place (sdk/README.md § The driver protocol). */
    sdks: {
      values: {
        optionalProperties: {
          /** How its wire driver is started. */
          wire: COMMAND,
          /**
           * How its live driver is started, and the tier of the live corpus
           * the SDK is held to: `fleet`, what every live layer does, or
           * `parity`, all of CACHE-SEMANTICS.
           */
          live: { properties: { command: COMMAND, tier: { enum: ['fleet', 'parity'] } } },
          /** How its worker driver is started, when the SDK has a worker's surface (worker/README.md). */
          worker: COMMAND,
          /**
           * The wire cases its driver cannot be put through, each with why.
           * The suite holds an exemption as it holds a case: the driver must
           * answer `unsupported` to what the case asks, or the exemption is
           * stale.
           */
          exempt: { values: { type: 'string' } },
        },
      },
    },
    /** How each Worker service is started: run with `--config <document>` (worker-service/README.md). */
    workerServices: { values: COMMAND },
    /** How each Weaver is started, and the port its health answers on, which the harness writes into its document (weaver/README.md). */
    weaverServices: { values: { properties: { command: COMMAND, healthPort: { type: 'uint16' } } } },
    /** How each Smelter is started: run with `--config <document>` (smelter/README.md). */
    smelterServices: { values: COMMAND },
    /** How each Librarian is started: run with `--config <document>` (librarian/README.md). */
    librarianServices: { values: COMMAND },
  },
} as const;

export type Implementations = JTDDataType<typeof SCHEMA>;
/** How one implementation of the Weaver is started and reached. */
export type WeaverService = Implementations['weaverServices'][string];

const ajv = new Ajv();
const validate = ajv.compile<Implementations>(SCHEMA);

/** The file `argv` names after `--implementations`, read, checked against the shape, and with its paths resolved. */
export function readImplementations(argv: readonly string[]): Implementations {
  const named = argv.flatMap((argument, index) => (argument === '--implementations' ? [index] : []));
  const [at] = named;
  if (named.length !== 1 || at === undefined) {
    throw new Error(
      `Name the implementations to test once, after vitest's own arguments: \`-- --implementations <file>\` ` +
        `(Semiont's own builds are semiont.implementations.json). This run names ${named.length === 0 ? 'none' : `${named.length}`}.`,
    );
  }
  const given = argv[at + 1];
  if (given === undefined || given.startsWith('--')) {
    throw new Error('`--implementations` names no file: give the path of a JSON file of the implementations to test.');
  }
  const file = resolve(given);
  const base = dirname(file);
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'), function (this: unknown, _key: string, value: unknown) {
      return Array.isArray(this) && typeof value === 'string' && (value.startsWith('./') || value.startsWith('../'))
        ? resolve(base, value)
        : value;
    });
  } catch (error) {
    throw new Error(`The implementations file ${file} cannot be read as JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!validate(data)) {
    throw new Error(`The implementations file ${file} is not of the shape harness/implementations.ts gives: ${ajv.errorsText(validate.errors)}`);
  }
  return data;
}
