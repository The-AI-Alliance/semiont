import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

// dist/frontend/ is copied here by build.mjs from .npm-stage/frontend
const FRONTEND_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'frontend');

/**
 * Resolve the frontend package directory bundled alongside the CLI in dist/frontend/.
 * Returns the directory or null if not present.
 */
export function resolveFrontendNpmPackage(): string | null {
  return existsSync(FRONTEND_DIR) ? FRONTEND_DIR : null;
}

/**
 * Resolve the path to the frontend server.js entry point bundled in dist/frontend/.
 * Returns null if not present.
 */
export function resolveFrontendServerScript(): string | null {
  const script = path.join(FRONTEND_DIR, 'server.js');
  return existsSync(script) ? script : null;
}

export interface FrontendXdgPaths {
  pidFile: string;
  logsDir: string;
  appLogFile: string;
  errorLogFile: string;
}

/**
 * Compute XDG-compliant paths for frontend runtime files.
 * Keyed by service name ("frontend"), not project name.
 */
export function frontendXdgPaths(): FrontendXdgPaths {
  const xdgState = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state');
  const logsDir = path.join(xdgState, 'semiont', 'frontend');

  const xdgRuntime = process.env.XDG_RUNTIME_DIR;
  const runtimeBase = xdgRuntime ?? process.env.TMPDIR ?? '/tmp';
  const pidFile = path.join(runtimeBase, 'semiont', 'frontend', 'frontend.pid');

  return {
    pidFile,
    logsDir,
    appLogFile: path.join(logsDir, 'app.log'),
    errorLogFile: path.join(logsDir, 'error.log'),
  };
}
