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

  /** A limit on a principal: its baseline, and a coefficient per role (`'unlimited'`, or the baseline's shape). */
  principalLimit<C>(method: Method, path: string, key: string): { baseline: C; roles: Record<string, C | 'unlimited'> } {
    const limit = (this.operation(method, path)['x-semiont-limits'] as Record<string, unknown> | undefined)?.[key];
    if (!isObject(limit) || !('baseline' in limit)) throw new Error(`${method.toUpperCase()} ${path} states no principal limit ${key}`);
    return { baseline: limit['baseline'] as C, roles: (limit['roles'] ?? {}) as Record<string, C | 'unlimited'> };
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
  shape: string;
  /** The payload's schema, when `shape` is `schema`: what a frame on the channel carries. */
  schema?: string;
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

/** The names of the environment variables `service` reads (service-environment/variables.json). */
/** A Rust service the spec's service tables (service-environment, service-telemetry) cover. */
export type Service = 'gateway' | 'dispatcher';
const SERVICES: readonly Service[] = ['gateway', 'dispatcher'];

export function serviceEnvironment(service: Service): string[] {
  const table: unknown = JSON.parse(readFileSync(join(SPEC_SOURCE, 'service-environment/variables.json'), 'utf8'));
  const rows = isObject(table) && Array.isArray(table['variables']) ? table['variables'] : [];
  const names = rows.flatMap((row) =>
    isObject(row) && typeof row['name'] === 'string' && Array.isArray(row['services']) && row['services'].includes(service) ? [row['name']] : [],
  );
  if (names.length === 0) throw new Error(`service-environment/variables.json lists no variables for the ${service}`);
  return names;
}

export interface TelemetryAttribute {
  key: string;
  /** The only values it may carry, where the spec lists them. */
  values?: string[];
  /** Why it may be absent: it is carried only under this condition. */
  only?: string;
}

export interface TelemetryRow {
  name: string;
  /** The services that export it. */
  services: Service[];
  /** A span's OTLP kind, or a metric's instrument. */
  kind: string;
  when: 'export' | 'traffic' | 'supervised' | 'fatal';
  attributes: TelemetryAttribute[];
  planes?: string[];
}

const WHEN = ['export', 'traffic', 'supervised', 'fatal'] as const;
const isWhen = (v: unknown): v is TelemetryRow['when'] => WHEN.some((w) => w === v);

const isService = (v: unknown): v is Service => SERVICES.some((s) => s === v);

function telemetryRows(rows: unknown, kindKey: 'kind' | 'instrument'): TelemetryRow[] {
  if (!Array.isArray(rows)) throw new Error('service-telemetry/telemetry.json: spans and metrics must be lists');
  return rows.map((r) => {
    if (!isObject(r) || typeof r['name'] !== 'string' || typeof r[kindKey] !== 'string' || !isWhen(r['when']) || !Array.isArray(r['attributes'])) {
      throw new Error(`service-telemetry/telemetry.json: a row is malformed: ${JSON.stringify(r)}`);
    }
    const services = r['services'];
    if (!Array.isArray(services) || services.length === 0 || !services.every(isService)) {
      throw new Error(`service-telemetry/telemetry.json: ${r['name']} names no services, or one that is not ${SERVICES.join(' or ')}`);
    }
    const attributes = r['attributes'].map((a): TelemetryAttribute => {
      if (!isObject(a) || typeof a['key'] !== 'string') throw new Error(`service-telemetry/telemetry.json: ${r['name']} has a malformed attribute`);
      const values = Array.isArray(a['values']) ? a['values'].map(String) : undefined;
      return { key: a['key'], ...(values ? { values } : {}), ...(typeof a['only'] === 'string' ? { only: a['only'] } : {}) };
    });
    const planes = Array.isArray(r['planes']) ? r['planes'].map(String) : undefined;
    return { name: r['name'], services, kind: String(r[kindKey]), when: r['when'], attributes, ...(planes ? { planes } : {}) };
  });
}

export interface Telemetry {
  spans: TelemetryRow[];
  metrics: TelemetryRow[];
}

let telemetryTable: Telemetry | undefined;

/** Every row of service-telemetry/telemetry.json. */
function telemetryAll(): Telemetry {
  if (telemetryTable) return telemetryTable;
  const table: unknown = JSON.parse(readFileSync(join(SPEC_SOURCE, 'service-telemetry/telemetry.json'), 'utf8'));
  if (!isObject(table)) throw new Error('service-telemetry/telemetry.json is not an object');
  telemetryTable = { spans: telemetryRows(table['spans'], 'kind'), metrics: telemetryRows(table['metrics'], 'instrument') };
  return telemetryTable;
}

/** The telemetry `service` exports (service-telemetry/telemetry.json): the spans and metrics that list it. */
export function telemetry(service: Service): Telemetry {
  const { spans, metrics } = telemetryAll();
  const of = (rows: TelemetryRow[]) => rows.filter((r) => r.services.includes(service));
  return { spans: of(spans), metrics: of(metrics) };
}

/** What an exported span name looks like for a row: `{channel}` stands for any channel. */
export function spanPattern(row: TelemetryRow): RegExp {
  const parts = row.name.split(/\{[a-z]+\}/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('.+')}$`);
}

/** A span's exported name, from the row the spec lists: `spanName('bus.dispatch:{channel}', { channel })`. */
export function spanName(template: string, fill: Record<string, string> = {}): string {
  if (!telemetryAll().spans.some((r) => r.name === template)) throw new Error(`the spec lists no span ${template}`);
  return template.replace(/\{([a-z]+)\}/g, (_, key: string) => {
    const value = fill[key];
    if (value === undefined) throw new Error(`span ${template} needs a value for {${key}}`);
    return value;
  });
}

/** A metric's name, as the spec lists it. */
export function metricName(name: string): string {
  if (!telemetryAll().metrics.some((r) => r.name === name)) throw new Error(`the spec lists no metric ${name}`);
  return name;
}

export interface PersonCase {
  why: string;
  subject: string;
  did: string;
}

export interface AgentCase {
  why: string;
  provider: string;
  model: string;
  did: string;
  email: string;
  name: string;
}

interface Principals {
  personDid(subject: string): string;
  people: PersonCase[];
  agents: AgentCase[];
}

const principalsByDomain = new Map<string, Principals>();

/**
 * How the gateway names its principals under `domain` (principals/cases.json):
 * a person's DID from the table's `person` form, each part after the domain
 * percent-encoded as the table states — encodeURIComponent's encoding — and
 * checked against every person case when loaded; and the table's cases for
 * this domain — people, and agents with the DID, address and name the gateway
 * must give each.
 */
export function principals(domain: string): Principals {
  const known = principalsByDomain.get(domain);
  if (known) return known;
  const table: unknown = JSON.parse(readFileSync(join(SPEC_SOURCE, 'principals/cases.json'), 'utf8'));
  if (!isObject(table) || typeof table['person'] !== 'string' || !Array.isArray(table['people']) || !Array.isArray(table['agents'])) {
    throw new Error('principals/cases.json has no person form, people or agents');
  }
  const form = table['person'];
  const person = (d: string, subject: string) => form.replace('{domain}', d).replace('{subject}', encodeURIComponent(subject));
  const people: PersonCase[] = [];
  for (const c of table['people']) {
    if (!isObject(c) || typeof c['why'] !== 'string' || typeof c['domain'] !== 'string' || typeof c['subject'] !== 'string' || typeof c['did'] !== 'string') {
      throw new Error(`principals/cases.json: a person case is malformed: ${JSON.stringify(c)}`);
    }
    if (person(c['domain'], c['subject']) !== c['did']) {
      throw new Error(`principals/cases.json: "${c['why']}" — the person form gives ${person(c['domain'], c['subject'])}, the case says ${c['did']}`);
    }
    if (c['domain'] === domain) people.push({ why: c['why'], subject: c['subject'], did: c['did'] });
  }
  const agents = table['agents'].flatMap((c): AgentCase[] => {
    if (!isObject(c) || c['domain'] !== domain) return [];
    const { why, provider, model, did, email, name } = c;
    if (![why, provider, model, did, email, name].every((v) => typeof v === 'string')) {
      throw new Error(`principals/cases.json: an agent case is malformed: ${JSON.stringify(c)}`);
    }
    return [{ why: String(why), provider: String(provider), model: String(model), did: String(did), email: String(email), name: String(name) }];
  });
  if (people.length === 0 || agents.length === 0) throw new Error(`principals/cases.json needs person and agent cases under ${domain}, the suite's knowledge base`);
  const loaded = { personDid: (subject: string) => person(domain, subject), people, agents };
  principalsByDomain.set(domain, loaded);
  return loaded;
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
