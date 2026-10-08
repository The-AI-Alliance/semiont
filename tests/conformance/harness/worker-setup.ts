/**
 * Once per worker run: refuse to start when a driver cannot run, so a missing
 * build reads as that, never as every case failing — make the Python SDK's
 * environment, and type-check the TypeScript driver, because Node runs it
 * with its types stripped and would run a mistyped one.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { REPO_ROOT } from './paths';
import { makePythonSdkEnvironment } from './python-sdk';

export default function setup(project: TestProject): void {
  const drivers = project.getProvidedContext().sdkDrivers;
  const rust = drivers['rust']?.worker?.[0];
  if (rust !== undefined && !existsSync(rust)) {
    throw new Error(`The Rust worker driver is not built: ${rust} does not exist. Run \`cargo build --release -p semiont-conformance-drivers\` at the repository root.`);
  }
  if (drivers['python']?.worker) makePythonSdkEnvironment();
  if (!drivers['typescript']?.worker) return;
  // The worker driver runs the built SDK over the built transport.
  for (const pkg of ['http-transport', 'sdk']) {
    const built = join(REPO_ROOT, 'packages', pkg, 'dist/index.js');
    if (!existsSync(built)) {
      throw new Error(`The TypeScript worker is not built: ${built} does not exist. Run \`npm run build:packages\` at the repository root.`);
    }
  }
  try {
    execFileSync(join(REPO_ROOT, 'node_modules/.bin/tsc'), ['-p', join('packages', 'sdk', 'conformance')], { cwd: REPO_ROOT, stdio: 'pipe' });
  } catch (error) {
    const output = (error as { stdout?: Buffer }).stdout?.toString('utf8') ?? String(error);
    throw new Error(`The TypeScript drivers in packages/sdk/conformance do not type-check:\n${output}`);
  }
}
