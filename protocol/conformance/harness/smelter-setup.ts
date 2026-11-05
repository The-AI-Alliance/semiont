/**
 * Once per smelter run: refuse to start when a Smelter or the vector database
 * the run needs is missing, so each reads as that, never as every case
 * failing.
 *
 * The run is told where its Qdrant is, in QDRANT_HOST, and the API key it was
 * started with, in QDRANT_API_KEY. It starts none: the database is a server,
 * and a run inside a container cannot start another. A run without either
 * variable fails here and names the one that is missing. It is not skipped.
 * The Qdrant is run with its JWT access control on, as the launcher runs one,
 * and the suite mints the Smelter's token from the key. The suite CLEARS
 * every collection of the database it is given, so it is given one of its own
 * (`packages/go/launcher/scripts/qdrant-image.sh` prints the image to start).
 */
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { TestProject } from 'vitest/node';
import type { Implementations } from './implementations';
import { guarded, QDRANT_PORT, type VectorDatabase } from './qdrant';

declare module 'vitest' {
  export interface ProvidedContext {
    /** How each implementation of the Smelter is started: the configuration provides them. */
    smelterServices: Implementations['smelterServices'];
    /** Where the run's vector database is, and its key. */
    vectorDatabase: VectorDatabase;
  }
}

/** What builds each implementation, said when a file its command names is missing. */
const BUILDS: Readonly<Record<string, string>> = {
  python: '`uv sync --locked --no-dev --project images/smelter` at the repository root',
};

export default async function setup(project: TestProject): Promise<void> {
  const services = project.getProvidedContext().smelterServices;
  if (Object.keys(services).length === 0) throw new Error('The implementations file names no Smelter: its `smelterServices` is empty.');
  for (const [implementation, command] of Object.entries(services)) {
    // Every file a command names by its path is what a build makes: the interpreter of an environment, for one.
    for (const built of command.filter((part) => isAbsolute(part))) {
      if (!existsSync(built)) {
        throw new Error(`The ${implementation} Smelter is not built: ${built} does not exist. Run ${BUILDS[implementation] ?? 'its build'}.`);
      }
    }
  }

  const host = process.env['QDRANT_HOST'];
  const key = process.env['QDRANT_API_KEY'];
  if (!host || !key) {
    const missing = [...(host ? [] : ['QDRANT_HOST']), ...(key ? [] : ['QDRANT_API_KEY'])];
    throw new Error(
      `The smelter suite runs against a real Qdrant, whose index it clears, and ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set. ` +
        `Start one for it alone (\`packages/go/launcher/scripts/qdrant-image.sh\` prints the image; its REST port is ${QDRANT_PORT}), ` +
        'with QDRANT__SERVICE__API_KEY=<key> and QDRANT__SERVICE__JWT_RBAC=true, and set QDRANT_HOST to its address and QDRANT_API_KEY to its key.',
    );
  }
  const database = { host, key };
  // Asked once here, so a database that is not there, refuses the key or asks for none reads as that.
  await guarded(database);
  project.provide('vectorDatabase', database);
}
