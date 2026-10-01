/**
 * Once per SDK run: refuse to start when the TypeScript driver cannot run, so
 * a missing build reads as that, never as every case failing — and type-check
 * it, because Node runs it with its types stripped and would run it wrong.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { REPO_ROOT } from './paths';

declare module 'vitest' {
  export interface ProvidedContext {
    /** How each SDK's wire driver is started: the configuration provides them. */
    sdkDrivers: Readonly<Record<string, readonly string[]>>;
  }
}

export default function setup(project: TestProject): void {
  if (!('typescript' in project.getProvidedContext().sdkDrivers)) return;
  const built = join(REPO_ROOT, 'packages/http-transport/dist/index.js');
  if (!existsSync(built)) {
    throw new Error(`The TypeScript SDK is not built: ${built} does not exist. Run \`npm run build:packages\` at the repository root.`);
  }
  try {
    execFileSync(join(REPO_ROOT, 'node_modules/.bin/tsc'), ['-p', 'packages/http-transport/conformance'], { cwd: REPO_ROOT, stdio: 'pipe' });
  } catch (error) {
    const output = (error as { stdout?: Buffer }).stdout?.toString('utf8') ?? String(error);
    throw new Error(`The TypeScript driver does not type-check:\n${output}`);
  }
}
