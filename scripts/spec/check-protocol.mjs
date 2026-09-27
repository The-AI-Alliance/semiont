// The protocol-completeness gate (GATEWAY-SIMPLIFY P0).
//
// Each service's protocol lives in the spec: a client, a conformance suite or a
// second implementation reads `specs/src/` and learns everything the service
// answers. Two documents are held to it — the gateway's API
// (`specs/src/openapi.json`) and the Archivist's HTTP surface
// (`specs/src/archivist/openapi.json`) — and the check fails when either leaves
// something to be learned from the code instead:
//
//   - a security scheme an operation names but the spec never defines;
//   - an operation that does not say whether it is public;
//   - a protected operation whose 401 carries no challenge header;
//   - a response with no body schema, or an error whose body is not
//     ErrorResponse (or an `allOf` refinement of it);
//   - an operation with no 500 (every route can fail, and the failure has a
//     body like any other error), or with a request body and no 400;
//   - a stream whose event names, frame or id formats no schema names;
//   - a declared header with no schema;
//   - a limit that is not a positive integer.
//
// It reads the SOURCE files and resolves `$ref`s itself, so it needs no bundle
// and cannot pass on a stale one.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const ROOT_FILES = ['specs/src/openapi.json', 'specs/src/archivist/openapi.json'].map((f) => resolve(REPO, f));

const cache = new Map();
function load(file) {
  if (!cache.has(file)) cache.set(file, JSON.parse(readFileSync(file, 'utf8')));
  return cache.get(file);
}

/** Follow `$ref` chains to the node they name, returning it with the file it lives in. */
function deref(node, file) {
  let current = node;
  let currentFile = file;
  const seen = new Set();
  while (current && typeof current === 'object' && typeof current.$ref === 'string') {
    const [target, pointer = ''] = current.$ref.split('#');
    const targetFile = target ? resolve(dirname(currentFile), target) : currentFile;
    const key = `${targetFile}#${pointer}`;
    if (seen.has(key)) throw new Error(`$ref cycle at ${key}`);
    seen.add(key);
    let doc = load(targetFile);
    for (const segment of pointer.split('/').filter(Boolean)) {
      doc = doc?.[segment.replaceAll('~1', '/').replaceAll('~0', '~')];
    }
    if (doc === undefined) throw new Error(`unresolvable $ref ${current.$ref} in ${currentFile}`);
    current = doc;
    currentFile = targetFile;
  }
  return { node: current, file: currentFile };
}

/**
 * An error body is an ErrorResponse, or a refinement of one: `allOf` naming
 * ErrorResponse, narrowing what a route's errors carry (a `code` it defines).
 */
function isErrorBody(schema, file) {
  if (refTarget(schema, file) === ERROR_RESPONSE) return true;
  const { node, file: at } = deref(schema, file);
  return Array.isArray(node.allOf) && node.allOf.some((member) => refTarget(member, at) === ERROR_RESPONSE);
}

/** The file a `$ref` names, so a schema can be recognised by what it is. */
function refTarget(node, file) {
  if (!node || typeof node.$ref !== 'string') return undefined;
  const [target] = node.$ref.split('#');
  return target ? resolve(dirname(file), target) : undefined;
}

const ERROR_RESPONSE = resolve(REPO, 'specs/src/components/schemas/ErrorResponse.json');
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];
const failures = [];
/** The document being checked, so each failure names it. */
let current = '';
const fail = (where, message) => failures.push(`${current} ${where}: ${message}`);

// ── Limits ────────────────────────────────────────────────────────────────
function checkLimits(where, limits) {
  if (limits === undefined) return;
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value <= 0) fail(where, `x-semiont-limits.${key} is ${JSON.stringify(value)}, not a positive integer`);
  }
}

// ── Streams ───────────────────────────────────────────────────────────────
/**
 * A stream's schema is a `oneOf` of its messages. Each message is an object
 * whose `event` is a one-value enum and whose `data` has a schema; a message
 * that carries an `id` names its formats by `pattern`.
 */
function checkStream(where, schema, file) {
  const { node, file: at } = deref(schema, file);
  if (!Array.isArray(node.oneOf) || node.oneOf.length === 0) {
    fail(where, 'the stream schema is not a oneOf of its messages, so its event names are written nowhere');
    return;
  }
  for (const [i, member] of node.oneOf.entries()) {
    const { node: message, file: messageFile } = deref(member, at);
    const label = `${where} message ${i}`;
    const props = message.properties ?? {};
    const event = props.event && deref(props.event, messageFile).node;
    if (!event || !Array.isArray(event.enum) || event.enum.length !== 1) {
      fail(label, '`event` is not a one-value enum');
    }
    if (!props.data) fail(label, 'has no `data` schema');
    if (!(message.required ?? []).includes('event') || !(message.required ?? []).includes('data')) {
      fail(label, '`event` and `data` are not both required');
    }
    if (props.id) {
      const { node: id, file: idFile } = deref(props.id, messageFile);
      const formats = id.oneOf ? id.oneOf.map((f) => deref(f, idFile).node) : [id];
      for (const format of formats) {
        if (typeof format.pattern !== 'string') fail(label, 'an `id` format has no `pattern`');
      }
    }
  }
}

for (const ROOT_FILE of ROOT_FILES) {
  const root = load(ROOT_FILE);
  current = ROOT_FILE.slice(REPO.length + 1);

  // ── Security schemes ────────────────────────────────────────────────────
  const schemes = root.components?.securitySchemes ?? {};
  for (const [name, scheme] of Object.entries(schemes)) {
    if (!scheme.description || scheme.description.trim() === '') {
      fail(`securitySchemes.${name}`, 'has no description — the claims a credential must carry are protocol');
    }
  }

  // ── Operations ────────────────────────────────────────────────────────────
  for (const [path, pathItemRef] of Object.entries(root.paths ?? {})) {
    const { node: pathItem, file } = deref(pathItemRef, ROOT_FILE);
    for (const method of METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      const where = `${method.toUpperCase()} ${path}`;

      if (!Array.isArray(op.security)) {
        fail(where, 'declares no `security` — say [] for a public route');
      }
      const requirements = op.security ?? [];
      for (const requirement of requirements) {
        for (const name of Object.keys(requirement)) {
          if (!(name in schemes)) fail(where, `names security scheme "${name}", which components.securitySchemes does not define`);
        }
      }
      const isPublic = requirements.length === 0;

      checkLimits(where, op['x-semiont-limits']);

      const responses = op.responses ?? {};
      if (!responses['500']) fail(where, 'declares no 500');
      if (op.requestBody && !responses['400']) fail(where, 'takes a request body and declares no 400');
      if (!isPublic && !responses['401']) fail(where, 'is protected and declares no 401');

      for (const [status, responseRef] of Object.entries(responses)) {
        const { node: response, file: responseFile } = deref(responseRef, file);
        const label = `${where} ${status}`;

        for (const [header, headerRef] of Object.entries(response.headers ?? {})) {
          if (!deref(headerRef, responseFile).node.schema) fail(label, `header ${header} has no schema`);
        }
        if (status === '401') {
          const headers = Object.keys(response.headers ?? {}).map((h) => h.toLowerCase());
          if (!headers.includes('www-authenticate')) fail(label, 'carries no WWW-Authenticate header');
        }

        const code = Number(status);
        const bodiless = code === 204 || (code >= 300 && code < 400);
        const content = response.content;
        if (!content || Object.keys(content).length === 0) {
          if (!bodiless) fail(label, 'declares no body');
          continue;
        }
        for (const [mediaType, media] of Object.entries(content)) {
          if (!media.schema) {
            fail(label, `${mediaType} has no schema`);
            continue;
          }
          if (mediaType === 'text/event-stream') checkStream(`${label} ${mediaType}`, media.schema, responseFile);
          if (code >= 400) {
            if (mediaType !== 'application/json') fail(label, `an error body is ${mediaType}, not application/json`);
            if (!isErrorBody(media.schema, responseFile)) fail(label, 'an error body is not ErrorResponse, or a refinement of it');
          }
        }
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`The spec leaves ${failures.length} protocol fact(s) to the code:\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('specs/src states the whole protocol of the gateway and the Archivist: every operation, response, header, stream and limit');
