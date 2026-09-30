/**
 * Once per dispatcher run: refuse to start when the dispatcher is not built, so
 * a missing build reads as that, never as every case failing.
 */
import { existsSync } from 'node:fs';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** How a dispatcher is started: the configuration provides it. */
    dispatcherCommand: readonly string[];
  }
}

export default function setup(project: TestProject): void {
  const command = project.getProvidedContext().dispatcherCommand;
  const entry = command[command.length - 1]!;
  if (!existsSync(entry)) {
    throw new Error(`The dispatcher is not built: ${entry} does not exist. Run \`npm run build:packages\` at the repository root.`);
  }
}
