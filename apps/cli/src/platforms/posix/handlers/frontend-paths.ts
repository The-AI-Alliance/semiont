import * as path from 'path';
import * as os from 'os';
import { createRequire } from 'module';

/**
 * Resolve the frontend npm package directory from the CLI's own node_modules.
 * Returns the package directory or null if not installed.
 */
export function resolveFrontendNpmPackage(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('@semiont/frontend/package.json');
    return path.dirname(pkgPath);
  } catch {
    return null;
  }
}

/**
 * Resolve the path to the frontend server.js entry point from the CLI's own node_modules.
 * Uses the package's `main` field so the path is derived from the manifest rather than hardcoded.
 * Returns null if not installed.
 */
export function resolveFrontendServerScript(): string | null {
  try {
    const require = createRequire(import.meta.url);
    // @semiont/frontend declares `"main": "server.js"` — resolve() follows it directly
    return require.resolve('@semiont/frontend');
  } catch {
    return null;
  }
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
