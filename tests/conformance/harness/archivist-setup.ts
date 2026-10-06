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
    /** How the other implementation of the Archivist is started, for the cases that pass a tree between the two. */
    archivistPeerCommand: readonly string[];
  }
}

export default function setup(project: TestProject): void {
  for (const command of [project.getProvidedContext().archivistCommand, project.getProvidedContext().archivistPeerCommand]) {
    const entry = command[command.length - 1]!;
    if (!existsSync(entry)) {
      throw new Error(`An Archivist is not built: ${entry} does not exist. Run \`npm run build:packages\` and \`cargo build --release -p semiont-archivist\` at the repository root.`);
    }
  }
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    throw new Error('git is not on PATH. The staging cases run it, as an Archivist whose knowledge base syncs git does.');
  }
}
