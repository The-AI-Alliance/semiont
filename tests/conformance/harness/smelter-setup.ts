/**
 * Once per smelter run: refuse to start when a Smelter or the vector database
 * the run needs is missing, so each reads as that, never as every case
 * failing.
 *
 * The run is told where its Qdrant is, in QDRANT_HOST. It starts none: the
 * database is a server, and a run inside a container cannot start another. A
 * run without the variable fails here and says so. It is not skipped. The
 * suite CLEARS the index of the database it is given, so it is given one of
 * its own (`scripts/ci/qdrant-image.sh` prints the image to start).
 */
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { TestProject } from 'vitest/node';
import { QDRANT_PORT, vectorIndex } from './qdrant';

declare module 'vitest' {
  export interface ProvidedContext {
    /** How each implementation of the Smelter is started: the configuration provides them. */
    smelterServices: Readonly<Record<string, readonly string[]>>;
    /** Where the run's vector database is. */
    vectorDatabase: { host: string };
  }
}

/** What builds each implementation, said when a file its command names is missing. */
const BUILDS: Readonly<Record<string, string>> = {
  python: '`uv sync --locked --no-dev --project images/smelter` at the repository root',
};

export default async function setup(project: TestProject): Promise<void> {
  const services = project.getProvidedContext().smelterServices;
  if (Object.keys(services).length === 0) throw new Error('harness/paths.ts names no Smelter: SMELTER_SERVICES is empty.');
  for (const [implementation, command] of Object.entries(services)) {
    // Every file a command names by its path is what a build makes: the interpreter of an environment, for one.
    for (const built of command.filter((part) => isAbsolute(part))) {
      if (!existsSync(built)) {
        throw new Error(`The ${implementation} Smelter is not built: ${built} does not exist. Run ${BUILDS[implementation] ?? 'its build'}.`);
      }
    }
  }

  const host = process.env['QDRANT_HOST'];
  if (!host) {
    throw new Error(
      'The smelter suite runs against a real Qdrant, whose index it clears, and QDRANT_HOST is not set. ' +
        `Start one for it alone (\`scripts/ci/qdrant-image.sh\` prints the image; its REST port is ${QDRANT_PORT}) ` +
        'and set QDRANT_HOST to its address.',
    );
  }
  // Asked once here, so a database that is not there reads as that.
  await vectorIndex(host).collections();
  project.provide('vectorDatabase', { host });
}
