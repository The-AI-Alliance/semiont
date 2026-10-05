/**
 * The Archivist's configuration document: ArchivistConfig in specs/, resolved
 * by whoever starts the Archivist and named by its `--config` flag. The
 * Archivist parses no environment TOML and resolves or defaults nothing: a
 * missing flag, an unreadable file, or a document the schema refuses ends the
 * process before it serves, and the refusal says which.
 */

import { readFileSync } from 'fs';
import type { components } from '@semiont/core';
import { validators, formatErrors } from '@semiont/core/openapi';

export type ArchivistConfig = components['schemas']['ArchivistConfig'];

/**
 * The path `--config` names, as `--config <path>` or `--config=<path>`.
 * There is no default path: one the Archivist guessed would hide exactly the
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
    "The Archivist's configuration document is not named: start it with --config <path>",
  );
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The document at `path`, validated against the spec's ArchivistConfig. */
export function readArchivistConfig(path: string): ArchivistConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read the Archivist's configuration document at ${path}: ${reason(error)}`);
  }
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new Error(`The Archivist's configuration document at ${path} is not JSON: ${reason(error)}`);
  }
  const validate = validators.ArchivistConfig;
  if (!validate(document)) {
    throw new Error(
      `The Archivist's configuration document at ${path} is not valid: ${formatErrors(validate.errors)}`,
    );
  }
  return document;
}
