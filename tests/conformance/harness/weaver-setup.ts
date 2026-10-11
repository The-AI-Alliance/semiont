/**
 * Once per weaver run: refuse to start when a Weaver, the Archivist or the
 * graph database the run needs is missing, so each reads as that, never as
 * every case failing.
 *
 * The run is told where its neo4j is, in NEO4J_HOST and NEO4J_PASSWORD. It
 * starts none: the database is a server, and a run inside a container cannot
 * start another. A run without them fails here and says so. It is not skipped.
 * The suite CLEARS the database it is given, so it is given one of its own
 * (`scripts/ci/neo4j-image.sh` prints the image to start).
 */
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { TestProject } from 'vitest/node';
import type { WeaverService } from './weaver-process';

declare module 'vitest' {
  export interface ProvidedContext {
    /** How each implementation of the Weaver is started: the configuration provides them. */
    weaverServices: Readonly<Record<string, WeaverService>>;
    /** Where the run's graph database is. */
    graphDatabase: { host: string; password: string };
  }
}

/** What builds each implementation, said when a file its command names is missing. */
const BUILDS: Readonly<Record<string, string>> = {
  typescript: '`npm run build:packages` at the repository root',
};

export default function setup(project: TestProject): void {
  const services = project.getProvidedContext().weaverServices;
  if (Object.keys(services).length === 0) throw new Error('harness/paths.ts names no Weaver: WEAVER_SERVICES is empty.');
  for (const [implementation, service] of Object.entries(services)) {
    for (const built of service.command.filter((part) => isAbsolute(part))) {
      if (!existsSync(built)) {
        throw new Error(`The ${implementation} Weaver is not built: ${built} does not exist. Run ${BUILDS[implementation] ?? 'its build'}.`);
      }
    }
  }

  const host = process.env['NEO4J_HOST'];
  const password = process.env['NEO4J_PASSWORD'];
  if (!host || !password) {
    const missing = [...(host ? [] : ['NEO4J_HOST']), ...(password ? [] : ['NEO4J_PASSWORD'])];
    throw new Error(
      `The weaver suite runs against a real neo4j, which it clears, and ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set. ` +
        'Start one for it alone (`scripts/ci/neo4j-image.sh` prints the image; NEO4J_AUTH=neo4j/<password>) ' +
        'and set NEO4J_HOST to its address and NEO4J_PASSWORD to that password.',
    );
  }
  project.provide('graphDatabase', { host, password });
}
