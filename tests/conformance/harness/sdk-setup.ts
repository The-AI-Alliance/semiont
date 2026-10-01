/**
 * Once per SDK run: refuse to start when the TypeScript driver cannot run, so
 * a missing build reads as that, never as every case failing — and type-check
 * it, because Node runs it with its types stripped and would run it wrong.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { REPO_ROOT, type SdkDrivers } from './paths';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Each SDK's drivers: the configuration provides them. */
    sdkDrivers: Readonly<Record<string, SdkDrivers>>;
  }
}

export default function setup(project: TestProject): void {
  if (!('typescript' in project.getProvidedContext().sdkDrivers)) return;
  // The wire driver runs the built transport; the live driver, the built SDK over it.
  for (const pkg of ['http-transport', 'sdk']) {
    const built = join(REPO_ROOT, 'packages', pkg, 'dist/index.js');
    if (!existsSync(built)) {
      throw new Error(`The TypeScript SDK is not built: ${built} does not exist. Run \`npm run build:packages\` at the repository root.`);
    }
    try {
      execFileSync(join(REPO_ROOT, 'node_modules/.bin/tsc'), ['-p', join('packages', pkg, 'conformance')], { cwd: REPO_ROOT, stdio: 'pipe' });
    } catch (error) {
      const output = (error as { stdout?: Buffer }).stdout?.toString('utf8') ?? String(error);
      throw new Error(`The TypeScript driver in packages/${pkg}/conformance does not type-check:\n${output}`);
    }
  }
}
