/**
 * Once per worker-service run: refuse to start when a Worker service cannot
 * run, so a missing build reads as that, never as every case failing.
 */
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** How each implementation of the Worker service is started: the configuration provides them. */
    workerServices: Readonly<Record<string, readonly string[]>>;
  }
}

/** What builds each implementation, said when a file its command names is missing. */
const BUILDS: Readonly<Record<string, string>> = {
  python: '`uv sync --locked --no-dev --all-extras --project images/worker` at the repository root',
};

export default function setup(project: TestProject): void {
  const services = project.getProvidedContext().workerServices;
  if (Object.keys(services).length === 0) throw new Error('harness/paths.ts names no Worker service: WORKER_SERVICES is empty.');
  for (const [implementation, command] of Object.entries(services)) {
    // Every file a command names by its path is what a build makes: the interpreter of an environment, for one.
    for (const built of command.filter((part) => isAbsolute(part))) {
      if (!existsSync(built)) {
        const build = BUILDS[implementation] ?? 'its build';
        throw new Error(`The ${implementation} Worker service is not built: ${built} does not exist. Run ${build}.`);
      }
    }
  }
}
