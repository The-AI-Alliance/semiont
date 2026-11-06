// The protocol-completeness gate.
//
// Each service's protocol lives in the spec: a client, a conformance suite or a
// second implementation reads `protocol/specs/src/` and learns everything the service
// answers. Two documents are held to it — the gateway's API
// (`protocol/specs/src/openapi.json`) and the Archivist's HTTP surface
// (`protocol/specs/src/archivist/openapi.json`) — and the check fails when either leaves
// something to be learned from the code instead:
//
//   - a security scheme an operation names but the spec never defines;
//   - an operation that does not say whether it is public;
//   - a protected operation whose 401 carries no challenge header;
//   - a response with no body schema, or an error whose body is not
//     ErrorResponse (or an `allOf` refinement of it);
//   - an operation with no 500 (every route can fail, and the failure has a
//     body like any other error), or with a request body and no 400;
//   - an operation that takes a JSON body and states no
//     `x-semiont-limits.maxBodyBytes`, or declares no 413 (an unbounded body is
//     memory the caller chooses);
//   - a 429 without a `Retry-After` header: a refused caller is told when to
//     come back, not left to guess;
//   - a stream whose event names, frame or id formats no schema names;
//   - a declared header with no schema;
//   - a wait that does not end inside the wait around it: the Archivist's hold
//     on a read of anchored text inside its callers' `readSeconds`, and the
//     gateway's call of the Archivist (`connectSeconds` and `readSeconds`)
//     inside a client's `httpRequestTimeoutMs` (below);
//   - a limit that is not a positive integer, or a principal's limit that is
//     not a baseline with coefficients by role (below).
//
// It reads the SOURCE files and resolves `$ref`s itself, so it needs no bundle
// and cannot pass on a stale one.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');
const ROOT_FILES = ['protocol/specs/src/openapi.json', 'protocol/specs/src/archivist/openapi.json'].map((f) => resolve(REPO, f));

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

const ERROR_RESPONSE = resolve(REPO, 'protocol/specs/src/components/schemas/ErrorResponse.json');
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];
const failures = [];
/** The document being checked, so each failure names it. */
let current = '';
const fail = (where, message) => failures.push(`${current} ${where}: ${message}`);

// ── Limits ────────────────────────────────────────────────────────────────
// A limit is a positive integer, or — for a limit on a principal — a baseline
// with coefficients by role: `{ "baseline": C, "roles": { "<role>": C | "unlimited" } }`,
// where a coefficient C is a positive integer or an object of them, and every
// coefficient has the baseline's shape. A principal holding none of the roles
// gets the baseline; one holding several, the most generous of theirs.
const positive = (v) => Number.isInteger(v) && v > 0;
const plainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const shapeOf = (c) => (positive(c) ? 'integer' : plainObject(c) && Object.keys(c).length > 0 && Object.values(c).every(positive) ? Object.keys(c).sort().join(',') : undefined);

function checkLimits(where, limits) {
  if (limits === undefined) return;
  for (const [key, value] of Object.entries(limits)) {
    const label = `x-semiont-limits.${key}`;
    if (positive(value)) continue;
    if (!plainObject(value) || !('baseline' in value)) {
      fail(where, `${label} is ${JSON.stringify(value)}, not a positive integer or a baseline with coefficients by role`);
      continue;
    }
    const extra = Object.keys(value).filter((k) => k !== 'baseline' && k !== 'roles');
    if (extra.length > 0) fail(where, `${label} has ${extra.join(', ')} beside its baseline and roles`);
    const shape = shapeOf(value.baseline);
    if (!shape) {
      fail(where, `${label}.baseline is ${JSON.stringify(value.baseline)}, not a positive integer or an object of them`);
      continue;
    }
    for (const [role, coefficient] of Object.entries(value.roles ?? {})) {
      if (coefficient !== 'unlimited' && shapeOf(coefficient) !== shape) {
        fail(where, `${label}.roles.${role} is ${JSON.stringify(coefficient)}, neither "unlimited" nor shaped like the baseline`);
      }
    }
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

// ── Waits that nest ───────────────────────────────────────────────────────
// A wait ends inside the wait around it, so whoever waits inside is answered,
// and answers, before whoever waits outside stops waiting: the longest the
// Archivist holds a read of anchored text (`settleWaitSeconds`) is shorter
// than the `readSeconds` its caller gives an answer to begin; and a call the
// gateway makes of the Archivist for a client, `connectSeconds` and then
// `readSeconds`, is shorter than that client's deadline on its request
// (`httpRequestTimeoutMs`, protocol/specs/src/client/timing.json). Each
// number is read from where it is stated.
{
  const ARCHIVIST = resolve(REPO, 'protocol/specs/src/archivist/openapi.json');
  const TIMING = resolve(REPO, 'protocol/specs/src/client/timing.json');
  const timingFile = TIMING.slice(REPO.length + 1);
  current = ARCHIVIST.slice(REPO.length + 1);
  const archivist = load(ARCHIVIST);
  const { node: anchoredText } = deref(archivist.paths?.['/resources/{id}/anchored-text'], ARCHIVIST);
  const waits = [
    ['GET /resources/{id}/anchored-text x-semiont-limits.settleWaitSeconds', anchoredText?.get?.['x-semiont-limits']?.settleWaitSeconds],
    ['x-semiont-limits.connectSeconds', archivist['x-semiont-limits']?.connectSeconds],
    ['x-semiont-limits.readSeconds', archivist['x-semiont-limits']?.readSeconds],
    [`${timingFile} httpRequestTimeoutMs`, load(TIMING).timing?.find((t) => t.name === 'httpRequestTimeoutMs')?.value],
  ];
  const unstated = waits.filter(([, value]) => !positive(value));
  for (const [name, value] of unstated) fail('waits that nest', `${name} is ${JSON.stringify(value)}, not a positive integer to order`);
  if (unstated.length === 0) {
    const [hold, connect, read, requestMs] = waits.map(([, value]) => value);
    if (hold >= read) {
      fail('waits that nest', `settleWaitSeconds (${hold}) is not shorter than readSeconds (${read}): a caller stops waiting before the Archivist answers a read it holds`);
    }
    if ((connect + read) * 1000 >= requestMs) {
      fail(
        'waits that nest',
        `connectSeconds (${connect}) and readSeconds (${read}) together are not shorter than ${timingFile} httpRequestTimeoutMs (${requestMs}): a client stops waiting before the gateway answers a read the Archivist does not`,
      );
    }
  }
}

for (const ROOT_FILE of ROOT_FILES) {
  const root = load(ROOT_FILE);
  current = ROOT_FILE.slice(REPO.length + 1);
  checkLimits('the document', root['x-semiont-limits']);

  // ── Security schemes ────────────────────────────────────────────────────
  const schemes = root.components?.securitySchemes ?? {};
  for (const [name, scheme] of Object.entries(schemes)) {
    if (!scheme.description || scheme.description.trim() === '') {
      fail(`securitySchemes.${name}`, 'has no description — the claims a credential must carry are protocol');
    }
    checkLimits(`securitySchemes.${name}`, scheme['x-semiont-limits']);
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
      const takesJson = op.requestBody && 'application/json' in (deref(op.requestBody, file).node.content ?? {});
      if (takesJson && op['x-semiont-limits']?.maxBodyBytes === undefined) fail(where, 'takes a JSON body and states no x-semiont-limits.maxBodyBytes');
      if (takesJson && !responses['413']) fail(where, 'takes a JSON body and declares no 413');
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
        if (status === '429') {
          const headers = Object.keys(response.headers ?? {}).map((h) => h.toLowerCase());
          if (!headers.includes('retry-after')) fail(label, 'carries no Retry-After header');
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
console.log('protocol/specs/src states the whole protocol of the gateway and the Archivist: every operation, response, header, stream and limit');
