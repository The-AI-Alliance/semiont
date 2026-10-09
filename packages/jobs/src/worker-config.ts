/**
 * The worker's configuration document: `WorkerConfig` in specs/.
 *
 * Whoever starts the worker writes it, resolved: the launcher for the worker
 * it starts, and anyone else to the same schema. So this reads and refuses,
 * and decides nothing. It parses no TOML, resolves no `${VAR}` and supplies no
 * value the document left out. A secret is never in the document: the
 * document names the variable that holds it, and the environment is read here.
 *
 * The refusals are worded as the gateway's, the dispatcher's and the
 * Archivist's are, so an operator reads one kind of message from every
 * service.
 */
import { readFileSync } from 'node:fs';
import type { ServiceAccountCredential, components } from '@semiont/core';
import { formatErrors, validators } from '@semiont/core/openapi';

export type WorkerConfig = components['schemas']['WorkerConfig'];

/** What a process's environment is, to a reader of it. */
type Environment = Readonly<Record<string, string | undefined>>;

const said = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The path the worker was started with: what follows `--config`, or is joined
 * to it by `=`. It is never guessed. A path the worker assumed would hide a
 * deployment that put the document somewhere else.
 */
export function configPathOf(argv: readonly string[]): string {
  for (const [at, arg] of argv.entries()) {
    if (arg.startsWith('--config=')) {
      const path = arg.slice('--config='.length);
      if (path !== '') return path;
    } else if (arg === '--config') {
      const path = argv[at + 1];
      if (path !== undefined && path !== '' && !path.startsWith('--')) return path;
    }
  }
  throw new Error('The worker\'s configuration document is not named: start it with --config <path>');
}

/** The document at `path`: read, and held to its schema before it is believed. */
export function readWorkerConfig(
  path: string,
  read: (path: string) => string = (file) => readFileSync(file, 'utf8'),
): WorkerConfig {
  let text: string;
  try {
    text = read(path);
  } catch (error) {
    throw new Error(
      `Cannot read the worker's configuration document at ${path} (${said(error)}). `
      + 'The launcher writes it; a worker started another way is given one (WorkerConfig in specs/).',
    );
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not JSON: ${said(error)}`);
  }
  if (!validators.WorkerConfig(document)) {
    // Each reason on a line of its own. The reasons name fields and what was
    // expected of them, never a value that was found there.
    const reasons = (validators.WorkerConfig.errors ?? []).map((reason) => `  ${formatErrors([reason])}`);
    throw new Error(`${path} is not a worker configuration document (WorkerConfig):\n${reasons.join('\n')}`);
  }
  return document;
}

/**
 * The key of the agent at `index`, read from the variable the document names
 * for it. An agent whose provider takes no key names no variable and has none.
 *
 * The refusal says which member named the variable and never what it named: a
 * key written where the name belongs is a value found in the document.
 */
export function apiKeyOf(config: WorkerConfig, index: number, env: Environment): string | undefined {
  const name = config.agents[index]?.apiKeyEnv;
  if (name === undefined) return undefined;
  const key = env[name];
  if (key === undefined || key === '') {
    throw new Error(`agents[${index}].apiKeyEnv names a variable that is not set in the worker's environment`);
  }
  return key;
}

/** The worker's own account at the issuer the document names. */
export function serviceAccountOf(config: WorkerConfig, env: Environment): ServiceAccountCredential {
  const held = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === '') {
      throw new Error(`${name} is not set in the worker's environment: a worker signs in as a service account`);
    }
    return value;
  };
  return {
    issuer: config.identity.issuer,
    clientId: held('SEMIONT_OIDC_CLIENT_ID'),
    clientSecret: held('SEMIONT_OIDC_CLIENT_SECRET'),
  };
}
