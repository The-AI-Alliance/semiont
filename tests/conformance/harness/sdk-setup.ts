/**
 * Once per SDK run: refuse to start when a driver cannot run, so a missing
 * build reads as that, never as every case failing — make the Python SDK's
 * environment, and type-check the TypeScript drivers, because Node runs them
 * with their types stripped and would run a mistyped one.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { PYTHON_SDK, REPO_ROOT, type SdkDrivers } from './paths';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Each SDK's drivers: the configuration provides them. */
    sdkDrivers: Readonly<Record<string, SdkDrivers>>;
  }
}

export default function setup(project: TestProject): void {
  const drivers = project.getProvidedContext().sdkDrivers;
  for (const rust of [drivers['rust']?.wire?.[0], drivers['rust']?.live?.command[0]]) {
    if (rust !== undefined && !existsSync(rust)) {
      throw new Error(`A Rust driver is not built: ${rust} does not exist. Run \`cargo build --release -p semiont-conformance-drivers\` at the repository root.`);
    }
  }
  if ('python' in drivers) {
    // The Python drivers run the SDK from its locked environment, without what only its development needs.
    try {
      execFileSync('uv', ['sync', '--locked', '--no-dev', '--project', PYTHON_SDK], { cwd: REPO_ROOT, stdio: 'pipe' });
    } catch (error) {
      const said = (error as { stderr?: Buffer }).stderr?.toString('utf8') ?? String(error);
      throw new Error(`The Python SDK's environment could not be made. It needs \`uv\` and Python 3.12 or later on PATH:\n${said}`);
    }
  }
  if (!('typescript' in drivers)) return;
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
