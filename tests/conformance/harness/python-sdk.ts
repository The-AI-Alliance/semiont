/**
 * The Python SDK's environment, which its drivers run from.
 */
import { execFileSync } from 'node:child_process';
import { PYTHON_SDK, REPO_ROOT } from './paths';

/** Make the SDK's locked environment, without what only its development needs. */
export function makePythonSdkEnvironment(): void {
  try {
    execFileSync('uv', ['sync', '--locked', '--no-dev', '--project', PYTHON_SDK], { cwd: REPO_ROOT, stdio: 'pipe' });
  } catch (error) {
    const said = (error as { stderr?: Buffer }).stderr?.toString('utf8') ?? String(error);
    throw new Error(`The Python SDK's environment could not be made. It needs \`uv\` and Python 3.12 or later on PATH:\n${said}`);
  }
}
