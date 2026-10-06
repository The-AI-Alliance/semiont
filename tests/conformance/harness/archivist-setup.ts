/**
 * Once per Archivist run: refuse to start when the Archivist is not built or
 * git is missing, so either reads as that, never as every case failing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** How an Archivist is started: the configuration provides it. */
    archivistCommand: readonly string[];
  }
}

export default function setup(project: TestProject): void {
  const command = project.getProvidedContext().archivistCommand;
  const entry = command[command.length - 1]!;
  if (!existsSync(entry)) {
    throw new Error(`The Archivist is not built: ${entry} does not exist. Run \`cargo build --release -p semiont-archivist\` at the repository root.`);
  }
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    throw new Error('git is not on PATH. The staging cases run it, as an Archivist whose knowledge base syncs git does.');
  }
}
