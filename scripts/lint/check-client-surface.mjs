#!/usr/bin/env node
/**
 * lint:client-surface — every SDK's client has the surface
 * specs/src/client/surface.json states, and no other.
 *
 * The table lists each namespace's methods with the shape of what each
 * returns. This reads the signatures each SDK declares and fails on:
 *
 * - a method the table lists that an SDK lacks;
 * - a method an SDK has that the table does not list;
 * - a method whose return shape is not its row's: the right name with the
 *   wrong shape is a different method;
 * - a method the table says an SDK lacks (`absent`) that the SDK has: an
 *   exemption that stopped being true.
 *
 * It also holds the table to the bus registry: a row that goes through a
 * channel names one the registry has, and a `request` names an operation.
 *
 * What a method does when it is called is not read here: each SDK's surface
 * test runs the table's cases (packages/sdk/src/__tests__/client-surface.test.ts,
 * packages/sdk-rust/tests/surface.rs, packages/sdk-python/tests/test_surface.py).
 *
 * TypeScript's signatures are the interfaces of
 * packages/sdk/src/namespaces/types.ts; Rust's are the `pub fn`s of each
 * `impl <Name>Namespace` in packages/sdk-rust/src/namespaces; Python's are the
 * methods of each `class <Name>Namespace` in
 * packages/sdk-python/src/semiont/namespaces whose names begin with no
 * underscore.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TABLE = 'specs/src/client/surface.json';
const REGISTRY = 'specs/src/bus/registry.json';
const TS_INTERFACES = 'packages/sdk/src/namespaces/types.ts';
const RUST_NAMESPACES = 'packages/sdk-rust/src/namespaces';
const PYTHON_NAMESPACES = 'packages/sdk-python/src/semiont/namespaces';

const failures = [];
const fail = (message) => failures.push(message);
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

const table = JSON.parse(read(TABLE));
const registry = JSON.parse(read(REGISTRY));
const channels = new Set(registry.channels.map((entry) => entry.channel));
const requests = new Set(registry.operations.map((operation) => operation.request));

// ── The table itself ────────────────────────────────────────────────────

/** namespace → method → row */
const rows = new Map();
for (const namespace of table.namespaces) {
  if (rows.has(namespace.namespace)) fail(`${TABLE} lists the namespace ${namespace.namespace} twice`);
  const methods = new Map();
  rows.set(namespace.namespace, methods);
  for (const row of namespace.methods) {
    const name = `${namespace.namespace}.${row.method}`;
    if (methods.has(row.method)) fail(`${TABLE} lists ${name} twice`);
    methods.set(row.method, row);
    if (!Object.hasOwn(table.shapes, row.shape)) fail(`${name} has the shape "${row.shape}", which the table's shapes do not name`);
    const through = Object.entries(row.via ?? {});
    if (through.length !== 1) {
      fail(`${name} says ${through.length} things under via; a row goes through exactly one`);
      continue;
    }
    const [[kind, named]] = through;
    if (!Object.hasOwn(table.via, kind)) fail(`${name} goes through "${kind}", which the table's via does not name`);
    if (['request', 'emit', 'local', 'observes'].includes(kind) && !channels.has(named)) {
      fail(`${name} goes through ${named}, which is not a channel of ${REGISTRY}`);
    }
    if (kind === 'request' && !requests.has(named)) fail(`${name} requests ${named}, which is not the request of an operation in ${REGISTRY}`);
    if (!Array.isArray(row.cases) || row.cases.length === 0) fail(`${name} has no case: nothing holds what calling it does`);
  }
}

// ── Reading signatures ──────────────────────────────────────────────────

/** `source` with its comments blanked, strings left alone. `quotes` are the characters that open one. */
function withoutComments(source, quotes) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (quote) {
      if (source[i] === '\\') { out += two; i += 2; continue; }
      if (source[i] === quote) quote = null;
      out += source[i++];
    } else if (quotes.includes(source[i])) {
      quote = source[i];
      out += source[i++];
    } else if (two === '//') {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      out += ' ';
    } else {
      out += source[i++];
    }
  }
  return out;
}

/** The text between the brace at `open` and the one that closes it. */
function braced(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error('a brace that is never closed');
}

/** The index just past the bracket that closes the one at `open`. `=>` and `->` are not brackets. */
function closing(source, open) {
  const pairs = { '(': ')', '<': '>', '[': ']', '{': '}' };
  const stack = [];
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if ((c === '=' || c === '-') && source[i + 1] === '>') { i++; continue; }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i + 1;
    }
  }
  throw new Error('a bracket that is never closed');
}

/** `source` cut at each `separator` that is inside no bracket. */
function splitOutside(source, separator) {
  const parts = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if ((c === '=' || c === '-') && source[i + 1] === '>') { i++; continue; }
    if ('(<[{'.includes(c)) depth++;
    else if (')>]}'.includes(c)) depth--;
    else if (c === separator && depth === 0) {
      parts.push(source.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(source.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

const squeezed = (text) => text.replace(/\s+/g, ' ').trim();

// ── TypeScript ──────────────────────────────────────────────────────────

function typescriptShape(returns, isProperty) {
  if (isProperty) return returns.startsWith('Observable<') ? 'events' : undefined;
  if (returns === 'void') return 'signal';
  if (returns === 'Promise<number | undefined>') return 'count';
  if (returns.startsWith('Promise<')) return 'promise';
  if (returns.startsWith('StreamObservable<')) return 'stream';
  if (returns.startsWith('DelegationObservable<')) return 'delegation';
  if (returns === 'ClaimsObservable') return 'claims';
  if (returns === 'UploadObservable') return 'upload';
  if (returns.startsWith('CacheObservable<')) return 'cache';
  return undefined;
}

/** namespace → method → { shape, returns } */
function typescriptSurface() {
  const source = withoutComments(read(TS_INTERFACES), '"\'`');
  const surface = new Map();
  for (const match of source.matchAll(/export interface (\w+)Namespace\s*\{/g)) {
    const namespace = match[1][0].toLowerCase() + match[1].slice(1);
    const methods = new Map();
    surface.set(namespace, methods);
    const body = braced(source, match.index + match[0].length - 1);
    for (const member of splitOutside(body, ';')) {
      const text = squeezed(member);
      const method = /^(\w+)\s*\(/.exec(text);
      if (method) {
        const after = text.slice(closing(text, text.indexOf('(')));
        const returns = squeezed(after.replace(/^\s*:/, ''));
        methods.set(method[1], { shape: typescriptShape(returns, false), returns });
        continue;
      }
      const property = /^(?:readonly\s+)?(\w+)\$\s*:\s*(.+)$/.exec(text);
      if (property) {
        methods.set(property[1], { shape: typescriptShape(squeezed(property[2]), true), returns: squeezed(property[2]) });
        continue;
      }
      fail(`${TS_INTERFACES}: ${match[1]}Namespace has a member this lint cannot read: ${text}`);
    }
  }
  return surface;
}

// ── Rust ────────────────────────────────────────────────────────────────

const camel = (snake) => snake.replace(/_(\w)/g, (_, letter) => letter.toUpperCase());

function rustShape(isAsync, returns) {
  if (returns === undefined) return isAsync ? undefined : 'signal';
  if (returns.startsWith('Cached<')) return 'cache';
  if (returns.startsWith('Running<')) return 'stream';
  if (returns.startsWith('Delegation<')) return 'delegation';
  if (returns === 'Upload') return 'upload';
  if (returns === 'Claims') return 'claims';
  if (returns.startsWith('Typed<')) return 'events';
  if (isAsync && returns === 'Result<Option<u64>, SemiontError>') return 'count';
  if (isAsync && returns.startsWith('Result<')) return 'promise';
  return undefined;
}

/** namespace → method → { shape, returns } */
function rustSurface() {
  const surface = new Map();
  const directory = join(ROOT, RUST_NAMESPACES);
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.rs')).sort()) {
    // A `'` in Rust opens a lifetime far more often than a character.
    const source = withoutComments(readFileSync(join(directory, file), 'utf8'), '"');
    for (const match of source.matchAll(/^impl (\w+)Namespace\s*\{/gm)) {
      // A namespace whose name Rust keeps for itself is in a file named with
      // a trailing underscore; the type's name says which namespace it is.
      const namespace = match[1][0].toLowerCase() + match[1].slice(1);
      const expected = existsSync(join(directory, `${namespace}_.rs`)) ? `${namespace}_.rs` : `${namespace}.rs`;
      if (file !== expected) fail(`${RUST_NAMESPACES}/${file} holds ${match[1]}Namespace, which belongs in ${expected}`);
      if (!surface.has(namespace)) surface.set(namespace, new Map());
      const methods = surface.get(namespace);
      const body = braced(source, match.index + match[0].length - 1);
      for (const fn of body.matchAll(/\bpub (async )?fn (\w+)/g)) {
        const from = fn.index + fn[0].length;
        const parameters = body.indexOf('(', from);
        const afterParameters = closing(body, parameters);
        const signatureEnd = body.indexOf('{', afterParameters);
        const tail = squeezed(body.slice(afterParameters, signatureEnd));
        const returns = tail.startsWith('->') ? squeezed(tail.slice(2).split(/\bwhere\b/)[0]) : undefined;
        methods.set(camel(fn[2]), { shape: rustShape(Boolean(fn[1]), returns), returns: returns ?? '()' });
      }
    }
  }
  return surface;
}

// ── Python ──────────────────────────────────────────────────────────────

/** `source` with its docstrings and comments blanked, the strings of its code left alone. */
function withoutPythonComments(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const three = source.slice(i, i + 3);
    if (three === '"""' || three === "'''") {
      const end = source.indexOf(three, i + 3);
      i = end === -1 ? source.length : end + 3;
      out += '""';
    } else if (source[i] === '"' || source[i] === "'") {
      const quote = source[i];
      out += source[i++];
      while (i < source.length && source[i] !== quote && source[i] !== '\n') {
        if (source[i] === '\\') out += source[i++];
        out += source[i++];
      }
      if (i < source.length) out += source[i++];
    } else if (source[i] === '#') {
      while (i < source.length && source[i] !== '\n') i++;
    } else {
      out += source[i++];
    }
  }
  return out;
}

function pythonShape(isAsync, returns) {
  if (returns === undefined) return undefined;
  if (isAsync) return returns === 'int | None' ? 'count' : 'promise';
  if (returns === 'None') return 'signal';
  if (returns.startsWith('Cached[')) return 'cache';
  if (returns.startsWith('Running[')) return 'stream';
  if (returns.startsWith('Delegation[')) return 'delegation';
  if (returns === 'Upload') return 'upload';
  if (returns === 'Claims') return 'claims';
  if (returns.startsWith('Typed[')) return 'events';
  return undefined;
}

/** namespace → method → { shape, returns }. An SDK with no namespaces has none. */
function pythonSurface() {
  const surface = new Map();
  const directory = join(ROOT, PYTHON_NAMESPACES);
  if (!existsSync(directory)) return surface;
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.py')).sort()) {
    const source = withoutPythonComments(readFileSync(join(directory, file), 'utf8'));
    for (const match of source.matchAll(/^class (\w+)Namespace\b[^\n]*:\n/gm)) {
      // A namespace whose name Python keeps for itself is in a file named
      // with a trailing underscore; the class's name says which namespace it is.
      const namespace = match[1][0].toLowerCase() + match[1].slice(1);
      const expected = existsSync(join(directory, `${namespace}_.py`)) ? `${namespace}_.py` : `${namespace}.py`;
      if (file !== expected) fail(`${PYTHON_NAMESPACES}/${file} holds ${match[1]}Namespace, which belongs in ${expected}`);
      if (!surface.has(namespace)) surface.set(namespace, new Map());
      const methods = surface.get(namespace);
      // The class's body: every line after its header, up to the next that begins at the margin.
      const rest = source.slice(match.index + match[0].length);
      const end = rest.search(/^\S/m);
      const body = end === -1 ? rest : rest.slice(0, end);
      for (const def of body.matchAll(/^ {4}(async )?def (\w+)\(/gm)) {
        if (def[2].startsWith('_')) continue;
        const afterParameters = closing(body, def.index + def[0].length - 1);
        const tail = /^\s*->\s*([^\n]+?):[ \t]*\n/.exec(body.slice(afterParameters));
        const returns = tail ? squeezed(tail[1]) : undefined;
        methods.set(camel(def[2]), { shape: pythonShape(Boolean(def[1]), returns), returns: returns ?? 'nothing it states' });
      }
    }
  }
  return surface;
}

// ── Each SDK against the table ──────────────────────────────────────────

function held(sdk, where, surface) {
  for (const [namespace, methods] of rows) {
    const has = surface.get(namespace);
    if (!has) {
      fail(`${sdk} has no ${namespace} namespace (${where})`);
      continue;
    }
    for (const [method, row] of methods) {
      const name = `${namespace}.${method}`;
      const found = has.get(method);
      const absent = row.absent?.[sdk];
      if (absent !== undefined) {
        if (found) fail(`${TABLE} says ${sdk} has no ${name}, and ${sdk} has it: the row's \`absent\` is stale`);
        continue;
      }
      if (!found) {
        fail(`${sdk} has no ${name}, which ${TABLE} lists`);
        continue;
      }
      if (found.shape === undefined) fail(`${sdk}'s ${name} returns ${found.returns}, which is none of the table's shapes`);
      else if (found.shape !== row.shape) fail(`${sdk}'s ${name} returns ${found.returns}, a ${found.shape}; ${TABLE} says it is a ${row.shape}`);
    }
    for (const method of has.keys()) {
      if (!methods.has(method)) fail(`${sdk} has ${namespace}.${method}, which ${TABLE} does not list`);
    }
  }
  for (const namespace of surface.keys()) {
    if (!rows.has(namespace)) fail(`${sdk} has a ${namespace} namespace, which ${TABLE} does not list`);
  }
}

for (const row of [...rows.values()].flatMap((methods) => [...methods.values()])) {
  for (const sdk of Object.keys(row.absent ?? {})) {
    if (!['typescript', 'rust', 'python'].includes(sdk)) fail(`${TABLE}: \`absent\` names "${sdk}", which is no SDK this lint reads`);
  }
}

held('typescript', TS_INTERFACES, typescriptSurface());
held('rust', RUST_NAMESPACES, rustSurface());
held('python', PYTHON_NAMESPACES, pythonSurface());

if (failures.length > 0) {
  console.error(`✗ lint:client-surface — ${failures.length} problem${failures.length === 1 ? '' : 's'}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
const count = [...rows.values()].reduce((total, methods) => total + methods.size, 0);
console.log(`✓ lint:client-surface — ${count} methods in ${rows.size} namespaces, held by TypeScript, Rust and Python`);
