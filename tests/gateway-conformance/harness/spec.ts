/**
 * The specs, as the suite reads them — the gateway's API, and the Archivist's
 * HTTP surface its stand-in Archivist is held to: operations, their declared
 * responses, the limits, and validators compiled from the component schemas.
 * Everything a case asserts about shape comes from here — nothing is restated.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { inject } from 'vitest';
import { SPEC_SOURCE } from './paths';

// ajv-formats is CommonJS; its default export arrives wrapped under ESM.
const addFormats = (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

export const METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;
export type Method = (typeof METHODS)[number];

export interface Operation {
  method: Method;
  /** OpenAPI form: `/resources/{id}`. */
  path: string;
  op: JsonObject;
}

const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

const SCHEMA_BASE = 'https://spec.local/schemas/';

/** OpenAPI 3.0 `nullable` → draft-07, as the gateway's own validators convert it. */
function convertNullable(node: Json): void {
  if (Array.isArray(node)) {
    node.forEach(convertNullable);
    return;
  }
  if (!isObject(node)) return;
  if (node['nullable'] === true) {
    delete node['nullable'];
    if (typeof node['type'] === 'string') {
      node['type'] = [node['type'], 'null'];
    } else {
      const inner: JsonObject = { ...node };
      for (const key of Object.keys(node)) delete node[key];
      node['anyOf'] = [{ type: 'null' }, inner];
    }
  }
  Object.values(node).forEach(convertNullable);
}

/** `#/components/schemas/X` → an absolute id, so a schema compiles on its own. */
function absolutize(node: Json): void {
  if (Array.isArray(node)) {
    node.forEach(absolutize);
    return;
  }
  if (!isObject(node)) return;
  const ref = node['$ref'];
  if (typeof ref === 'string' && ref.startsWith('#/components/schemas/')) {
    node['$ref'] = SCHEMA_BASE + ref.slice('#/components/schemas/'.length);
  }
  Object.values(node).forEach(absolutize);
}

export class Spec {
  readonly doc: JsonObject;
  private readonly ajv: Ajv;
  private readonly compiled = new Map<string, ValidateFunction>();

  constructor(path: string) {
    this.doc = JSON.parse(readFileSync(path, 'utf8')) as JsonObject;
    this.ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(this.ajv);
    const components = this.doc['components'];
    const schemas = isObject(components) && isObject(components['schemas']) ? components['schemas'] : {};
    for (const [name, schema] of Object.entries(schemas)) {
      const copy = structuredClone(schema);
      convertNullable(copy);
      absolutize(copy);
      this.ajv.addSchema(copy as object, SCHEMA_BASE + name);
    }
  }

  operations(): Operation[] {
    const out: Operation[] = [];
    const paths = this.doc['paths'];
    if (!isObject(paths)) return out;
    for (const [path, item] of Object.entries(paths)) {
      if (!isObject(item)) continue;
      for (const method of METHODS) {
        const op = item[method];
        if (isObject(op)) out.push({ method, path, op });
      }
    }
    return out;
  }

  operation(method: Method, path: string): JsonObject {
    const found = this.operations().find((o) => o.method === method && o.path === path);
    if (!found) throw new Error(`the spec declares no ${method.toUpperCase()} ${path}`);
    return found.op;
  }

  /** Follow a `#/components/...` reference inside the bundle. */
  deref(node: Json | undefined): Json | undefined {
    let current = node;
    while (isObject(current) && typeof current['$ref'] === 'string' && current['$ref'].startsWith('#/')) {
      let target: Json | undefined = this.doc;
      for (const segment of current['$ref'].slice(2).split('/')) {
        target = isObject(target) ? target[segment] : undefined;
      }
      current = target;
    }
    return current;
  }

  /** The declared response for a status, or undefined when it is not declared. */
  response(method: Method, path: string, status: number): JsonObject | undefined {
    const responses = this.operation(method, path)['responses'];
    if (!isObject(responses)) return undefined;
    const declared = this.deref(responses[String(status)]);
    return isObject(declared) ? declared : undefined;
  }

  /** A validator for a schema node as it appears in the bundle. */
  validator(schema: Json): ValidateFunction {
    const key = JSON.stringify(schema);
    let validate = this.compiled.get(key);
    if (!validate) {
      const copy = structuredClone(schema);
      convertNullable(copy);
      absolutize(copy);
      validate = this.ajv.compile(copy as object);
      this.compiled.set(key, validate);
    }
    return validate;
  }

  /** The validator of a named component schema. */
  component(name: string): ValidateFunction {
    const validate = this.ajv.getSchema(SCHEMA_BASE + name);
    if (!validate) throw new Error(`the spec has no component schema ${name}`);
    return validate;
  }

  /** A component schema's own document, for reading its keywords (`maxItems`, patterns). */
  schema(name: string): JsonObject {
    const components = this.doc['components'];
    const schemas = isObject(components) ? components['schemas'] : undefined;
    const schema = isObject(schemas) ? schemas[name] : undefined;
    if (!isObject(schema)) throw new Error(`the spec has no component schema ${name}`);
    return schema;
  }

  /** An operation's `x-semiont-limits`, every value a positive integer. */
  limits(method: Method, path: string): Record<string, number> {
    const limits = this.operation(method, path)['x-semiont-limits'];
    const out: Record<string, number> = {};
    if (isObject(limits)) for (const [k, v] of Object.entries(limits)) if (typeof v === 'number') out[k] = v;
    return out;
  }
}

let cached: Spec | undefined;
/** The gateway's API. */
export function spec(): Spec {
  cached ??= new Spec(inject('specPath'));
  return cached;
}

let archivistCached: Spec | undefined;
/** The Archivist's HTTP surface. */
export function archivistSpec(): Spec {
  archivistCached ??= new Spec(inject('archivistSpecPath'));
  return archivistCached;
}

export function errorsOf(validate: ValidateFunction): string {
  return (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`).join('; ');
}

// ── The bus registry, read from its source ────────────────────────────────

interface RegistryChannel {
  channel: string;
  validate: string | null;
}
interface RegistryOperation {
  request: string;
  result: string;
  failure: string;
}
interface Registry {
  channels: RegistryChannel[];
  operations: RegistryOperation[];
  effect: { writes: string[]; reads: string[] };
}

let registryCache: Registry | undefined;
export function registry(): Registry {
  registryCache ??= JSON.parse(readFileSync(join(SPEC_SOURCE, 'bus/registry.json'), 'utf8')) as Registry;
  return registryCache;
}

export function operationFor(request: string): RegistryOperation {
  const op = registry().operations.find((o) => o.request === request);
  if (!op) throw new Error(`the registry declares no operation ${request}`);
  return op;
}

/** The names of the environment variables a gateway reads (gateway-environment/variables.json). */
export function gatewayEnvironment(): string[] {
  const table: unknown = JSON.parse(readFileSync(join(SPEC_SOURCE, 'gateway-environment/variables.json'), 'utf8'));
  const rows = isObject(table) && Array.isArray(table['variables']) ? table['variables'] : [];
  const names = rows.flatMap((row) => (isObject(row) && typeof row['name'] === 'string' ? [row['name']] : []));
  if (names.length === 0) throw new Error('gateway-environment/variables.json lists no variables');
  return names;
}

/** The knowledge-base identity the suite runs under, from the shared case table. */
export function kbIdentity(): { name: string; domain: string; did: string; resource: string } {
  const table = JSON.parse(readFileSync(join(SPEC_SOURCE, 'kb-identity/cases.json'), 'utf8')) as {
    cases: Array<{ why: string; name: string; domain: string | null; did: string | null; resource: string | null }>;
  };
  const chosen = table.cases.find((c) => c.why === 'the shape semiont init writes');
  if (!chosen?.domain || !chosen.did || !chosen.resource) throw new Error('kb-identity/cases.json has no "the shape semiont init writes" case');
  return { name: chosen.name, domain: chosen.domain, did: chosen.did, resource: chosen.resource };
}
