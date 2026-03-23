import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { PreflightCheck, PreflightResult } from './types.js';

export function checkContainerRuntime(runtime: string): PreflightCheck {
  try {
    execFileSync(runtime, ['--version'], { stdio: 'ignore', timeout: 5000 });
    return { name: 'container-runtime', pass: true, message: `${runtime} is available` };
  } catch {
    return { name: 'container-runtime', pass: false, message: `${runtime} is not installed or not in PATH` };
  }
}

/**
 * Try to find the PID(s) holding a port using lsof (macOS/Linux) or fuser (Linux).
 * Returns a human-readable string like "PID 1234" or null if unable to determine.
 */
function findPortOwner(port: number): string | null {
  try {
    if (process.platform === 'darwin' || process.platform === 'linux') {
      const out = execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }) as string;
      const pids = out.trim().split('\n').filter(Boolean);
      if (pids.length > 0) return `PID ${pids.join(', ')}`;
    }
  } catch { /* lsof not available or no match */ }
  try {
    const out = execFileSync('fuser', [`${port}/tcp`], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }) as string;
    const pids = out.trim().split(/\s+/).filter(Boolean);
    if (pids.length > 0) return `PID ${pids.join(', ')}`;
  } catch { /* fuser not available or no match */ }
  return null;
}

export async function checkPortFree(port: number): Promise<PreflightCheck> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        const owner = findPortOwner(port);
        const hint = owner ? ` (${owner})` : '';
        resolve({ name: `port-${port}`, pass: false, message: `Port ${port} is in use${hint}` });
      } else {
        resolve({ name: `port-${port}`, pass: false, message: `Cannot check port ${port}: ${err.message}` });
      }
    });
    server.once('listening', () => {
      server.close(() => {
        resolve({ name: `port-${port}`, pass: true, message: `Port ${port} is available` });
      });
    });
    server.listen(port, '127.0.0.1');
  });
}

export function checkEnvVarResolved(value: string | undefined, varDescription: string): PreflightCheck {
  if (!value) {
    return { name: `env-${varDescription}`, pass: false, message: `${varDescription} is not configured` };
  }
  const match = value.match(/\$\{([A-Z0-9_]+)\}/);
  if (match) {
    const envVar = match[1];
    if (process.env[envVar]) {
      return { name: `env-${envVar}`, pass: true, message: `${envVar} is set` };
    }
    return { name: `env-${envVar}`, pass: false, message: `Environment variable ${envVar} is not set` };
  }
  return { name: `env-${varDescription}`, pass: true, message: `${varDescription} is configured` };
}

export function checkEnvVarsInConfig(config: Record<string, unknown>): PreflightCheck[] {
  const checks: PreflightCheck[] = [];
  const seen = new Set<string>();

  function scan(obj: unknown): void {
    if (typeof obj === 'string') {
      const matches = obj.matchAll(/\$\{([A-Z0-9_]+)\}/g);
      for (const match of matches) {
        const varName = match[1];
        if (!seen.has(varName)) {
          seen.add(varName);
          checks.push(
            process.env[varName]
              ? { name: `env-${varName}`, pass: true, message: `${varName} is set` }
              : { name: `env-${varName}`, pass: false, message: `${varName} is not set` }
          );
        }
      }
    } else if (Array.isArray(obj)) {
      for (const item of obj) scan(item);
    } else if (obj && typeof obj === 'object') {
      for (const value of Object.values(obj)) scan(value);
    }
  }

  scan(config);
  return checks;
}

export function checkCommandAvailable(command: string): PreflightCheck {
  try {
    execFileSync('which', [command], { stdio: 'ignore', timeout: 5000 });
    return { name: `command-${command}`, pass: true, message: `${command} is available` };
  } catch {
    return { name: `command-${command}`, pass: false, message: `${command} is not installed or not in PATH` };
  }
}

export function checkFileExists(filePath: string, description: string): PreflightCheck {
  if (fs.existsSync(filePath)) {
    return { name: `file-${description}`, pass: true, message: `${description} exists` };
  }
  return { name: `file-${description}`, pass: false, message: `${description} not found: ${filePath}` };
}

export function checkDirectoryWritable(dirPath: string): PreflightCheck {
  try {
    fs.accessSync(dirPath, fs.constants.W_OK);
    return { name: `writable-${dirPath}`, pass: true, message: `${dirPath} is writable` };
  } catch {
    return { name: `writable-${dirPath}`, pass: false, message: `${dirPath} is not writable or does not exist` };
  }
}

export function checkAwsCredentials(): PreflightCheck {
  const hasKeys = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
  const hasProfile = !!process.env.AWS_PROFILE;
  const hasConfig = fs.existsSync(`${process.env.HOME}/.aws/credentials`);

  if (hasKeys || hasProfile || hasConfig) {
    return { name: 'aws-credentials', pass: true, message: 'AWS credentials are configured' };
  }
  return { name: 'aws-credentials', pass: false, message: 'No AWS credentials found (set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, AWS_PROFILE, or ~/.aws/credentials)' };
}

export function checkPortLookupCommand(): PreflightCheck {
  const command = process.platform === 'darwin' ? 'lsof' : 'fuser';
  return checkCommandAvailable(command);
}

export function checkConfigField(value: unknown, fieldPath: string): PreflightCheck {
  if (value === undefined || value === null || value === '') {
    return { name: `config-${fieldPath}`, pass: false, message: `${fieldPath} is not configured` };
  }
  return { name: `config-${fieldPath}`, pass: true, message: `${fieldPath} is configured` };
}

export function checkConfigPort(port: unknown, fieldPath: string): PreflightCheck {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { name: `config-${fieldPath}`, pass: false, message: `${fieldPath} must be a port number (1–65535), got ${port}` };
  }
  return { name: `config-${fieldPath}`, pass: true, message: `${fieldPath} = ${port}` };
}

export function checkConfigUrl(url: unknown, fieldPath: string): PreflightCheck {
  if (typeof url !== 'string' || !url) {
    return { name: `config-${fieldPath}`, pass: false, message: `${fieldPath} is not configured` };
  }
  try {
    new URL(url);
    return { name: `config-${fieldPath}`, pass: true, message: `${fieldPath} = ${url}` };
  } catch {
    return { name: `config-${fieldPath}`, pass: false, message: `${fieldPath} is not a valid URL: ${url}` };
  }
}

export function checkConfigNonEmptyArray(arr: unknown, fieldPath: string): PreflightCheck {
  if (!Array.isArray(arr) || arr.length === 0) {
    return { name: `config-${fieldPath}`, pass: false, message: `${fieldPath} must be a non-empty array` };
  }
  return { name: `config-${fieldPath}`, pass: true, message: `${fieldPath} has ${arr.length} entries` };
}

export function getSecretsFilePath(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdgConfig, 'semiont', 'secrets');
}

export function readSecret(key: string): string | undefined {
  const filePath = getSecretsFilePath();
  if (!fs.existsSync(filePath)) return undefined;
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [k, ...rest] = trimmed.split('=');
    if (k.trim() === key) return rest.join('=').trim().replace(/^"(.*)"$/, '$1');
  }
  return undefined;
}

export function writeSecret(key: string, value: string): void {
  const filePath = getSecretsFilePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  let content = '';
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const idx = lines.findIndex(l => l.trim().startsWith(key + ' =') || l.trim().startsWith(key + '='));
    if (idx >= 0) {
      lines[idx] = `${key} = "${value}"`;
      fs.writeFileSync(filePath, lines.join('\n'), { mode: 0o600 });
      return;
    }
    content = content.trimEnd() + '\n';
  } else {
    content = '[secrets]\n';
  }
  fs.writeFileSync(filePath, content + `${key} = "${value}"\n`, { mode: 0o600 });
}

export function checkJwtSecretExists(): PreflightCheck {
  const secret = readSecret('JWT_SECRET');
  if (!secret) {
    return {
      name: 'jwt-secret-exists',
      pass: false,
      message: `JWT_SECRET not found in ${getSecretsFilePath()} — run: semiont provision`
    };
  }
  return { name: 'jwt-secret-exists', pass: true, message: 'JWT_SECRET is present' };
}

export function passingPreflight(): PreflightResult {
  return { pass: true, checks: [] };
}

export function preflightFromChecks(checks: PreflightCheck[]): PreflightResult {
  return {
    pass: checks.every(c => c.pass),
    checks,
  };
}
