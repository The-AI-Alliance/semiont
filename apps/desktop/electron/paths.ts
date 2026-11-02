import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

function copyMissing(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  chmodSync(destination, 0o700);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) {
      if (!existsSync(to) || lstatSync(to).isDirectory()) copyMissing(from, to);
    } else if (entry.isFile() && !existsSync(to)) {
      copyFileSync(from, to);
      chmodSync(to, 0o600);
    }
  }
}

let userConfigDir: string | undefined;

/** The per-user directory everything Semiont Desktop keeps lives in:
 *  $XDG_CONFIG_HOME/semiont-desktop (default ~/.config/…). */
export function configDir(): string {
  if (userConfigDir !== undefined) return userConfigDir;

  const base = process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config');
  const oldPath = join(base, 'document-grounded-chat');
  const newPath = join(base, 'semiont-desktop');

  if (existsSync(oldPath)) {
    if (existsSync(newPath)) copyMissing(oldPath, newPath);
    else renameSync(oldPath, newPath);
  }

  mkdirSync(newPath, { recursive: true, mode: 0o700 });
  chmodSync(newPath, 0o700);
  userConfigDir = newPath;
  return userConfigDir;
}

// Diagnostics log — the renderer (src/lib/error-log.ts) and the main process append here so
// failures in the packaged app are readable without devtools. Truncated on each launch so
// it stays small and relevant.
export function logPath(): string {
  return join(configDir(), 'log.txt');
}

export function appendLog(text: string): void {
  try {
    const path = logPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, text.endsWith('\n') ? text : `${text}\n`);
  } catch {
    // logging is best-effort — never let it crash the app
  }
}
