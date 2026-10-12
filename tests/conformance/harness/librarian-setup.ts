/**
 * Once per librarian run: refuse to start when a Librarian, the Weaver, the
 * Smelter or a database the run needs is missing, so each reads as that,
 * never as every case failing.
 *
 * The run is told where its neo4j is, in NEO4J_HOST and NEO4J_PASSWORD, and
 * where its Qdrant is, in QDRANT_HOST. It starts neither: each is a server,
 * and a run inside a container cannot start another. A run without the three
 * fails here and names the ones that are missing. It is not skipped. The
 * suite CLEARS the graph database and the index it is given, so it is given
 * ones of its own (`scripts/ci/neo4j-image.sh` and `scripts/ci/qdrant-image.sh`
 * print the images to start).
 */
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { TestProject } from 'vitest/node';
import { QDRANT_PORT, vectorIndex } from './qdrant';

declare module 'vitest' {
  export interface ProvidedContext {
    /** How each implementation of the Librarian is started: the configuration provides them. */
    librarianServices: Readonly<Record<string, readonly string[]>>;
  }
}

/** What builds each implementation of each service the run starts, said when a file its command names is missing. */
const LIBRARIAN_BUILDS: Readonly<Record<string, string>> = { python: '`uv sync --locked --no-dev --all-extras --project apps/librarian` at the repository root' };
const WEAVER_BUILDS: Readonly<Record<string, string>> = { python: '`uv sync --locked --no-dev --all-extras --project apps/weaver` at the repository root' };
const SMELTER_BUILDS: Readonly<Record<string, string>> = { python: '`uv sync --locked --no-dev --project apps/smelter` at the repository root' };

/** Every file a command names by its path is what a build makes: refuse a run in which one is missing. */
function built(what: string, command: readonly string[], build: string | undefined): void {
  for (const file of command.filter((part) => isAbsolute(part))) {
    if (!existsSync(file)) throw new Error(`The ${what} is not built: ${file} does not exist. Run ${build ?? 'its build'}.`);
  }
}

export default async function setup(project: TestProject): Promise<void> {
  const provided = project.getProvidedContext();
  if (Object.keys(provided.librarianServices).length === 0) throw new Error('harness/paths.ts names no Librarian: LIBRARIAN_SERVICES is empty.');
  for (const [implementation, command] of Object.entries(provided.librarianServices)) built(`${implementation} Librarian`, command, LIBRARIAN_BUILDS[implementation]);
  for (const [implementation, service] of Object.entries(provided.weaverServices)) built(`${implementation} Weaver`, service.command, WEAVER_BUILDS[implementation]);
  for (const [implementation, command] of Object.entries(provided.smelterServices)) built(`${implementation} Smelter`, command, SMELTER_BUILDS[implementation]);

  const graphHost = process.env['NEO4J_HOST'];
  const graphPassword = process.env['NEO4J_PASSWORD'];
  const vectorHost = process.env['QDRANT_HOST'];
  if (!graphHost || !graphPassword || !vectorHost) {
    const missing = [...(graphHost ? [] : ['NEO4J_HOST']), ...(graphPassword ? [] : ['NEO4J_PASSWORD']), ...(vectorHost ? [] : ['QDRANT_HOST'])];
    throw new Error(
      `The librarian suite runs against a real neo4j and a real Qdrant, both of which it clears, and ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set. ` +
        'Start a neo4j for it alone (`scripts/ci/neo4j-image.sh` prints the image; NEO4J_AUTH=neo4j/<password>) and set NEO4J_HOST to its address and NEO4J_PASSWORD to that password. ' +
        `Start a Qdrant for it alone (\`scripts/ci/qdrant-image.sh\` prints the image; its REST port is ${QDRANT_PORT}) and set QDRANT_HOST to its address.`,
    );
  }
  // Asked once here, so a vector database that is not there reads as that.
  await vectorIndex(vectorHost).collections();
  project.provide('graphDatabase', { host: graphHost, password: graphPassword });
  project.provide('vectorDatabase', { host: vectorHost });
}
