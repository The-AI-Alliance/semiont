/**
 * The Archivist's HTTP surface as `specs/src/archivist/openapi.json` states it,
 * read from the source files rather than a bundle, which can be stale. A reply
 * is checked against its operation's declaration: the status is declared, each
 * declared header is present and matches its schema, and a JSON body passes the
 * validator `@semiont/core` generates from the same schema.
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isObject } from '@semiont/core';
import { formatErrors, validators } from '@semiont/core/openapi';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../specs/src/archivist/openapi.json');
const METHODS = ['get', 'put', 'post', 'delete', 'patch'];

const loaded = new Map<string, unknown>();
function load(file: string): unknown {
  if (!loaded.has(file)) loaded.set(file, JSON.parse(readFileSync(file, 'utf8')));
  return loaded.get(file);
}

/** Follow file `$ref`s to the node they name, with the file it lives in. */
function deref(node: unknown, file: string): { node: unknown; file: string } {
  let current = node;
  let at = file;
  while (isObject(current) && typeof current['$ref'] === 'string') {
    const [target = '', pointer = ''] = current['$ref'].split('#');
    at = target ? resolve(dirname(at), target) : at;
    current = load(at);
    for (const segment of pointer.split('/').filter(Boolean)) current = isObject(current) ? current[segment] : undefined;
  }
  return { node: current, file: at };
}

interface Operation {
  /** `GET /resources/{id}/content` */
  name: string;
  method: string;
  pattern: RegExp;
  node: Record<string, unknown>;
  file: string;
}

function operations(): Operation[] {
  const root = load(ROOT);
  const paths = isObject(root) && isObject(root['paths']) ? root['paths'] : {};
  const out: Operation[] = [];
  for (const [path, ref] of Object.entries(paths)) {
    const { node: item, file } = deref(ref, ROOT);
    if (!isObject(item)) continue;
    const pattern = new RegExp(`^${path.replace(/\{[^}]+\}/g, '(.+)')}$`);
    for (const method of METHODS) {
      const node = item[method];
      if (isObject(node)) out.push({ name: `${method.toUpperCase()} ${path}`, method: method.toUpperCase(), pattern, node, file });
    }
  }
  return out;
}

/** Every operation the Archivist's spec declares, as `METHOD /path`. */
export const archivistOperations = (): string[] => operations().map((o) => o.name);

const isValidatorName = (name: string): name is keyof typeof validators => name in validators;

/** The schema's name when it is a reference to a shared component — which `validators` holds. */
function componentName(schema: unknown): string | undefined {
  if (!isObject(schema) || typeof schema['$ref'] !== 'string') return undefined;
  const [target = ''] = schema['$ref'].split('#');
  return target.includes('components/schemas/') ? basename(target, '.json') : undefined;
}

export interface ArchivistReply {
  status: number;
  headers: Headers;
  body: string;
}

/**
 * The operation a request names, and everything its reply does that the spec
 * does not declare. `operation` is undefined for a request the spec declares no
 * operation for — a probe of a route the Archivist must not serve.
 */
export function archivistNonConformance(method: string, pathname: string, reply: ArchivistReply): { operation: string | undefined; problems: string[] } {
  const operation = operations().find((o) => o.method === method && o.pattern.test(pathname));
  if (!operation) return { operation: undefined, problems: reply.status === 404 ? [] : [`${method} ${pathname} is no declared operation, and answered ${reply.status}, not 404`] };

  const where = `${operation.name} ${reply.status}`;
  const responses = isObject(operation.node['responses']) ? operation.node['responses'] : {};
  const { node: declared, file } = deref(responses[String(reply.status)], operation.file);
  if (!isObject(declared)) return { operation: operation.name, problems: [`${where}: the spec does not declare this status (body: ${reply.body.slice(0, 200)})`] };

  const problems: string[] = [];
  for (const [header, ref] of Object.entries(isObject(declared['headers']) ? declared['headers'] : {})) {
    const { node: h } = deref(ref, file);
    const schema = isObject(h) && isObject(h['schema']) ? h['schema'] : {};
    const value = reply.headers.get(header);
    if (value === null) problems.push(`${where}: no ${header} header`);
    else if (typeof schema['pattern'] === 'string' && !new RegExp(schema['pattern']).test(value)) problems.push(`${where}: ${header} is ${JSON.stringify(value)}`);
  }

  const content = isObject(declared['content']) ? declared['content'] : {};
  const got = (reply.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  const media = Object.keys(content).find((m) => m === got) ?? Object.keys(content).find((m) => m === '*/*');
  if (!media) {
    problems.push(`${where}: came as ${got || 'no content type'}, not ${Object.keys(content).join(' or ')}`);
    return { operation: operation.name, problems };
  }
  const mediaNode = content[media];
  const name = componentName(isObject(mediaNode) ? mediaNode['schema'] : undefined);
  if (name) {
    if (!isValidatorName(name)) problems.push(`${where}: @semiont/core generates no validator ${name}`);
    else {
      const validate = validators[name];
      let body: unknown;
      try {
        body = JSON.parse(reply.body);
      } catch {
        problems.push(`${where}: the body is not JSON: ${reply.body.slice(0, 200)}`);
        return { operation: operation.name, problems };
      }
      if (!validate(body)) problems.push(`${where}: the body is not a ${name}: ${formatErrors(validate.errors)}`);
    }
  }
  return { operation: operation.name, problems };
}
