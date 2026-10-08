/**
 * Once per worker-service run: refuse to start when a Worker service cannot
 * run, so a missing build reads as that, never as every case failing.
 */
import { existsSync } from 'node:fs';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** How each implementation of the Worker service is started: the configuration provides them. */
    workerServices: Readonly<Record<string, readonly string[]>>;
  }
}

/** What builds each implementation's entry, said when the entry is missing. */
const BUILDS: Readonly<Record<string, string>> = {
  typescript: '`npm run build:packages` at the repository root',
};

export default function setup(project: TestProject): void {
  const services = project.getProvidedContext().workerServices;
  if (Object.keys(services).length === 0) throw new Error('harness/paths.ts names no Worker service: WORKER_SERVICES is empty.');
  for (const [implementation, command] of Object.entries(services)) {
    const entry = command[command.length - 1]!;
    if (!existsSync(entry)) {
      const build = BUILDS[implementation] ?? 'its build';
      throw new Error(`The ${implementation} Worker service is not built: ${entry} does not exist. Run ${build}.`);
    }
  }
}
