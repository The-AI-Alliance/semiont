/**
 * The dispatcher's configuration document: DispatcherConfig in specs/,
 * resolved by whoever starts the dispatcher and named by its `--config`
 * flag. The dispatcher parses no TOML and resolves or defaults nothing: a
 * missing flag, an unreadable file, or a document the schema refuses ends the
 * process before it serves, and the refusal says which.
 */

import { readFileSync } from 'fs';
import type { components } from '@semiont/core';
import { validators, formatErrors } from '@semiont/core/openapi';

export type DispatcherConfig = components['schemas']['DispatcherConfig'];

/**
 * The path `--config` names, as `--config <path>` or `--config=<path>`.
 * There is no default path: one the dispatcher guessed would hide exactly the
 * drift the document exists to prevent.
 */
export function configPathFrom(argv: readonly string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--config=')) {
      const path = arg.slice('--config='.length);
      if (path) return path;
    } else if (arg === '--config') {
      const path = argv[i + 1];
      if (path && !path.startsWith('--')) return path;
    }
  }
  throw new Error(
    "The dispatcher's configuration document is not named: start it with --config <path>",
  );
}

/** The document at `path`, validated against the spec's DispatcherConfig. */
export function readDispatcherConfig(path: string): DispatcherConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(
      `Cannot read the dispatcher's configuration document at ${path}: ${(error as Error).message}`,
    );
  }
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `The dispatcher's configuration document at ${path} is not JSON: ${(error as Error).message}`,
    );
  }
  const validate = validators.DispatcherConfig;
  if (!validate(document)) {
    throw new Error(
      `The dispatcher's configuration document at ${path} is not valid: ${formatErrors(validate.errors)}`,
    );
  }
  return document as DispatcherConfig;
}

/**
 * The value of the environment variable a document field names. A named
 * variable that is unset refuses, naming the field and the variable.
 */
export function namedSecret(field: string, name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`The dispatcher's configuration document names ${name} for ${field}, which is not set`);
  }
  return value;
}
