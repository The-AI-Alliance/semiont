/**
 * Login Command
 *
 * Authenticates against a Semiont backend and caches the token.
 * This is the only command that handles credentials — all other API commands
 * read the cached token via `loadCachedClient`.
 *
 * Usage:
 *   semiont login [--bus <url>] [--user <email>] [--password <password>]
 *   semiont login --refresh [--bus <url>]
 *
 * Credential resolution order (login only):
 *   1. --bus / --user / --password flags
 *   2. $SEMIONT_BUS / $SEMIONT_USER / $SEMIONT_PASSWORD
 *   3. ~/.semiontconfig [environments.<env>.auth] bus/email/password
 *   4. Interactive password prompt (TTY only)
 *
 * See CLI-LOGIN.md for full design.
 */

import { z } from 'zod';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { parse as parseToml } from 'smol-toml';
import { CommandResults } from '../command-types.js';
import { CommandBuilder } from '../command-definition.js';
import { BaseOptionsSchema, BASE_ARGS, BASE_ALIASES } from '../base-options-schema.js';
import { acquireToken, busSlug, resolveBusUrl } from '../api-client-factory.js';

// =====================================================================
// SCHEMA
// =====================================================================

export const LoginOptionsSchema = BaseOptionsSchema.extend({
  bus: z.string().optional(),
  user: z.string().optional(),
  password: z.string().optional(),
  refresh: z.boolean().optional().default(false),
});

export type LoginOptions = z.output<typeof LoginOptionsSchema>;

// =====================================================================
// CONFIG HELPERS
// =====================================================================

interface AuthSection {
  email?: string;
  password?: string;
}

interface LoginConfigFile {
  defaults?: { environment?: string };
  environments?: Record<string, { auth?: AuthSection; backend?: { publicURL?: string } }>;
}

function readLoginConfig(): LoginConfigFile {
  const configPath = path.join(os.homedir(), '.semiontconfig');
  try {
    const content = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : null;
    if (!content) return {};
    return parseToml(content) as LoginConfigFile;
  } catch {
    return {};
  }
}

function getDefaultEnvironment(config: LoginConfigFile): string | null {
  return config.defaults?.environment ?? null;
}

function promptPassword(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('No password provided and stdin is not a TTY. Use --password or $SEMIONT_PASSWORD.'));
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    process.stderr.write(prompt);
    // Disable echo if possible
    if ((process.stdin as any).setRawMode) {
      (process.stdin as any).setRawMode(true);
    }
    let value = '';
    process.stdin.on('data', function onData(chunk: Buffer) {
      const char = chunk.toString();
      if (char === '\r' || char === '\n') {
        process.stdin.removeListener('data', onData);
        if ((process.stdin as any).setRawMode) {
          (process.stdin as any).setRawMode(false);
        }
        process.stderr.write('\n');
        rl.close();
        resolve(value);
      } else if (char === '\u0003') { // Ctrl-C
        process.stderr.write('\n');
        rl.close();
        reject(new Error('Interrupted'));
      } else if (char === '\u007f' || char === '\b') { // backspace
        value = value.slice(0, -1);
      } else {
        value += char;
      }
    });
    process.stdin.resume();
  });
}

// =====================================================================
// IMPLEMENTATION
// =====================================================================

export async function runLogin(options: LoginOptions): Promise<CommandResults> {
  const startTime = Date.now();
  const config = readLoginConfig();
  const defaultEnv = getDefaultEnvironment(config);
  const envSection = defaultEnv ? config.environments?.[defaultEnv] : undefined;

  // Resolve bus URL
  const rawBusUrl = resolveBusUrl(
    options.bus
    ?? (envSection?.backend?.publicURL)
  );

  // Resolve email
  const emailStr =
    options.user
    ?? process.env.SEMIONT_USER
    ?? envSection?.auth?.email
    ?? null;

  if (!emailStr) {
    throw new Error(
      'No auth email configured. Use --user, set $SEMIONT_USER, or add:\n' +
      '  [environments.<env>.auth]\n  email = "you@example.com"\nto ~/.semiontconfig'
    );
  }

  // Resolve password
  let passwordStr: string =
    options.password
    ?? process.env.SEMIONT_PASSWORD
    ?? envSection?.auth?.password
    ?? '';

  if (!passwordStr) {
    passwordStr = await promptPassword(`Password for ${emailStr}: `);
  }

  if (!passwordStr) {
    throw new Error('Password is required.');
  }

  await acquireToken(rawBusUrl, emailStr, passwordStr);

  const slug = busSlug(rawBusUrl);
  const xdgState = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state');
  const cachePath = path.join(xdgState, 'semiont', 'auth', `${slug}.json`);

  if (!options.quiet) {
    process.stderr.write(`Logged in to ${rawBusUrl} as ${emailStr}\n`);
    process.stderr.write(`Token cached at ${cachePath} (expires in 24h)\n`);
  }

  return {
    command: 'login',
    environment: 'n/a',
    timestamp: new Date(),
    duration: Date.now() - startTime,
    summary: { succeeded: 1, failed: 0, total: 1, warnings: 0 },
    executionContext: { user: emailStr, workingDirectory: process.cwd(), dryRun: false },
    results: [{ entity: rawBusUrl, platform: 'posix', success: true, duration: Date.now() - startTime }],
  };
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const loginCmd = new CommandBuilder()
  .name('login')
  .description(
    'Authenticate against a Semiont backend and cache the token. ' +
    'Run this once before using browse, gather, mark, bind, match, listen, yield, or beckon. ' +
    'Credentials resolved from: --bus/--user/--password flags → $SEMIONT_BUS/$SEMIONT_USER/$SEMIONT_PASSWORD → ~/.semiontconfig → interactive prompt.'
  )
  .requiresEnvironment(false)
  .requiresServices(false)
  .examples(
    'semiont login --bus http://localhost:4000 --user alice@example.com',
    'semiont login --bus https://api.acme.com',
    'semiont login --refresh --bus https://api.acme.com',
  )
  .args({
    args: {
      ...BASE_ARGS,
      '--bus': {
        type: 'string',
        description: 'Backend URL (e.g. http://localhost:4000). Fallback: $SEMIONT_BUS → ~/.semiontconfig',
      },
      '--user': {
        type: 'string',
        description: 'Login email. Fallback: $SEMIONT_USER → ~/.semiontconfig [environments.<env>.auth] email',
      },
      '--password': {
        type: 'string',
        description: 'Login password. Fallback: $SEMIONT_PASSWORD → ~/.semiontconfig → interactive prompt',
      },
      '--refresh': {
        type: 'boolean',
        description: 'Re-authenticate using cached email without requiring a new password (if stored)',
        default: false,
      },
    },
    aliases: { ...BASE_ALIASES, '-b': '--bus', '-u': '--user' },
  })
  .schema(LoginOptionsSchema)
  .handler(runLogin)
  .build();
