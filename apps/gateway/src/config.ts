/**
 * The gateway's configuration: one document, `GatewayConfig` in the spec,
 * read once at boot from `~/.semiontconfig` and validated against the spec's
 * own schema. Nothing in it is resolved or defaulted here — the launcher (or
 * whoever starts a gateway another way) writes it resolved — and a document
 * that does not validate stops the process before it serves, naming each
 * failing field by its JSON pointer.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { components } from '@semiont/core';
import { validators } from '@semiont/core/openapi';

type Document = components['schemas']['GatewayConfig'];
type ValidationError = NonNullable<typeof validators.GatewayConfig.errors>[number];
type Signal = Document['signal'];

/** The document, with the one rule its schema cannot state made a type: a NATS plane has servers. */
export type GatewayConfig = Omit<Document, 'signal'> & {
  signal: (Signal & { type: 'in-process' }) | (Signal & { type: 'nats'; servers: string });
};

export const CONFIG_PATH = join(homedir(), '.semiontconfig');

function describe(error: ValidationError): string {
  const where = error.instancePath || '/';
  if (error.keyword === 'required') return `${where} is missing ${String(error.params['missingProperty'])}`;
  if (error.keyword === 'additionalProperties') return `${where} does not declare ${String(error.params['additionalProperty'])}`;
  return `${where} ${error.message ?? 'is invalid'}`;
}

export function readGatewayConfig(path: string): GatewayConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (error) {
    throw new Error(`Cannot read the gateway's configuration document at ${path} (${error instanceof Error ? error.message : String(error)}). The launcher writes it; a gateway started another way is given one (GatewayConfig in specs/).`);
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const validate = validators.GatewayConfig;
  if (!validate(document)) {
    throw new Error(`${path} is not a gateway configuration document (GatewayConfig):\n${(validate.errors ?? []).map((e) => `  ${describe(e)}`).join('\n')}`);
  }
  // The one rule the schema does not state.
  const { signal } = document;
  if (signal.type === 'in-process') return { ...document, signal: { ...signal, type: 'in-process' } };
  if (!signal.servers) {
    throw new Error(`${path} is not a gateway configuration document (GatewayConfig):\n  /signal is missing servers: a nats plane needs its broker's address`);
  }
  return { ...document, signal: { ...signal, type: 'nats', servers: signal.servers } };
}

/** The value of the environment variable a document field names; absence refuses. */
export function fromEnvironment(field: string, name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${field} names the environment variable ${name}, which is not set`);
  return value;
}
