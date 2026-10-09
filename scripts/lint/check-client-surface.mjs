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
 *
 * WHAT A WORKER IS HANDED. The table's `worker` section lists the members of
 * the claims `job.claim` returns and of a job the worker holds, and each SDK
 * is held to it the same two ways, with a message that says what to do:
 *
 * - a member the table lists that an SDK lacks;
 * - a public member an SDK has that the table does not list;
 * - a member the table says an SDK lacks (`absent`) that the SDK has;
 * - a member the table says an SDK has under a name of its ecosystem's
 *   (`named`), when the SDK lacks that name or has the table's as well;
 * - a member a held job has as its verb's (`takes`) that is not had by the
 *   held job of each verb, or does not take the schema its verb names.
 *
 * A member is held by its name alone, as its language spells it. Its form is
 * its language's and is not compared: what a held job states is a property
 * in TypeScript and Python and a method in Rust, and a property that gives a
 * stream of values is named `<member>$` in TypeScript. What a language's own
 * protocols give a type is no member: how a type is made (a constructor,
 * `__init__`, a `new` that is not `pub`), Python's names that begin with an
 * underscore, Rust's trait implementations, and what a TypeScript class
 * inherits from a class the SDK does not declare. What a member does is not
 * read here either: docs/protocol/WORKER-CONTRACT.md states it, and the
 * worker conformance suite holds each SDK to it.
 *
 * TypeScript's members are those of `interface Held` and of the class
 * `ClaimsObservable` in packages/sdk/src/claims.ts, a held job of a verb
 * being `Held<'<verb>', <what its verb's members take>>`. Rust's are the
 * `pub fn`s of `impl<V> Held<V>`, of `impl Held<Mark>` and `impl Held<Yield>`
 * for a job of each verb, of `impl HeldJob` for a job of either, and of
 * `impl Claims`, in packages/sdk-rust/src/claims.rs. Python's are the public
 * methods, properties and attributes of `HeldMarkJob` and `HeldYieldJob`,
 * with those of the class each is made from, and of `Claims`, in
 * packages/sdk-python/src/semiont/claims.py. A declaration this cannot read
 * is a failure, never a member passed over.
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
const TS_CLAIMS = 'packages/sdk/src/claims.ts';
const RUST_CLAIMS = 'packages/sdk-rust/src/claims.rs';
const PYTHON_CLAIMS = 'packages/sdk-python/src/semiont/claims.py';
const SCHEMAS = 'specs/src/components/schemas';
const SDKS = ['typescript', 'rust', 'python'];

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
    if (!SDKS.includes(sdk)) fail(`${TABLE}: \`absent\` names "${sdk}", which is no SDK this lint reads`);
  }
}

held('typescript', TS_INTERFACES, typescriptSurface());
held('rust', RUST_NAMESPACES, rustSurface());
held('python', PYTHON_NAMESPACES, pythonSurface());

// ── What a worker is handed ─────────────────────────────────────────────

/** The verbs a job is of: the spec's `JobType`. */
const VERBS = JSON.parse(read(`${SCHEMAS}/JobType.json`)).enum;

/** What this lint can read the members of, each as the table names it. */
const HANDED = ['claims', 'heldJob'];

/** handed → member → row */
const handed = new Map();
for (const thing of table.worker ?? []) {
  const what = `${TABLE}: worker.${thing.handed}`;
  if (handed.has(thing.handed)) fail(`${what} is listed twice`);
  const members = new Map();
  handed.set(thing.handed, members);
  if (!HANDED.includes(thing.handed)) fail(`${what} is nothing this lint reads the members of: it reads ${HANDED.join(' and ')}`);
  if (typeof thing.docs !== 'string' || thing.docs === '') fail(`${what} does not say what it is (\`docs\`)`);
  if (!Array.isArray(thing.members) || thing.members.length === 0) fail(`${what} lists no members`);
  for (const row of thing.members ?? []) {
    const name = `${what}.${row.member}`;
    if (members.has(row.member)) fail(`${name} is listed twice`);
    members.set(row.member, row);
    const strays = Object.keys(row).filter((key) => !['member', 'absent', 'named', 'takes'].includes(key));
    if (strays.length > 0) fail(`${name} states ${strays.join(', ')}, which a member's row does not: what a member does is docs/protocol/WORKER-CONTRACT.md's and the worker conformance suite's to hold`);
    for (const [sdk, why] of Object.entries(row.absent ?? {})) {
      if (!SDKS.includes(sdk)) fail(`${name}: \`absent\` names "${sdk}", which is no SDK this lint reads`);
      if (typeof why !== 'string' || why === '') fail(`${name}: \`absent\` does not say why ${sdk} lacks it`);
      if (row.named?.[sdk] !== undefined) fail(`${name} says ${sdk} lacks it (\`absent\`) and has it under another name (\`named\`): it is one or the other`);
    }
    for (const [sdk, other] of Object.entries(row.named ?? {})) {
      if (!SDKS.includes(sdk)) fail(`${name}: \`named\` names "${sdk}", which is no SDK this lint reads`);
      if (typeof other?.name !== 'string' || other.name === '' || other.name === row.member) fail(`${name}: \`named\` gives ${sdk} no name of its own for it`);
      if (typeof other?.why !== 'string' || other.why === '') fail(`${name}: \`named\` does not say why ${sdk} names it otherwise`);
    }
    if (SDKS.every((sdk) => row.absent?.[sdk] !== undefined)) fail(`${name} is absent from every SDK: it is no member`);
    if (row.takes !== undefined) {
      if (thing.handed !== 'heldJob') fail(`${name} states \`takes\`, which only a held job's member does: a held job is its verb's`);
      const stated = Object.keys(row.takes);
      if (stated.length !== VERBS.length || !VERBS.every((verb) => stated.includes(verb))) fail(`${name}: \`takes\` states ${stated.join(', ')}, and a job's verbs are ${VERBS.join(', ')}`);
      for (const schema of Object.values(row.takes)) {
        if (!existsSync(join(ROOT, SCHEMAS, `${schema}.json`))) fail(`${name} takes ${schema}, which is no schema of ${SCHEMAS}`);
      }
    }
  }
}
for (const what of HANDED) {
  if (!handed.has(what)) fail(`${TABLE}: \`worker\` does not list ${what}, whose members this lint reads`);
}

/**
 * TypeScript `source` with its comments gone and its strings emptied, a
 * template's expressions with them: every bracket left is the code's own.
 */
function typescriptCode(source) {
  let out = '';
  let i = 0;
  // What is open, innermost last: a quote, a template's text, or the braces of a template's expression.
  const open = [];
  while (i < source.length) {
    const top = open[open.length - 1];
    const c = source[i];
    const two = source.slice(i, i + 2);
    if (top === "'" || top === '"') {
      if (c === '\\') i += 2;
      else {
        if (c === top) open.pop();
        i++;
      }
    } else if (top === '`') {
      if (c === '\\') i += 2;
      else if (two === '${') {
        open.push(1);
        i += 2;
      } else {
        if (c === '`') open.pop();
        i++;
      }
    } else if (two === '//') {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      if (open.length === 0) out += ' ';
    } else if (c === "'" || c === '"' || c === '`') {
      if (open.length === 0) out += `${c}${c}`;
      open.push(c);
      i++;
    } else if (typeof top === 'number') {
      // Inside a template's expression: code, none of it kept.
      if (c === '{') open[open.length - 1]++;
      else if (c === '}' && --open[open.length - 1] === 0) open.pop();
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** A parameter list's parameters: each one's name and the type it states, `self` and `this` left out. */
function parameters(list) {
  return splitOutside(list, ',').flatMap((parameter) => {
    const stated = /^(?:mut\s+)?(\w+)\??\s*:\s*(.+)$/s.exec(parameter);
    if (!stated) return [];
    // A default is no part of the type.
    const [type] = splitOutside(stated[2], '=');
    return [{ name: stated[1], type: squeezed(type) }];
  });
}

/** The text between the parenthesis at `open` and the one that closes it. */
const parenthesised = (source, open) => source.slice(open + 1, closing(source, open) - 1);

/**
 * Each reader answers what its SDK declares for a worker: the members of its
 * claims; the members of a held job of each verb, each with the parameters
 * it takes; and, where the language has a type of its own for a job of
 * either verb, that type's. Each with where it was read, for a message. One
 * that meets a declaration it cannot read says so and answers nothing: no
 * SDK is held to a reading that guessed.
 */

/** What says a reader could not read `file`, and whether it has been said. */
function unreadable(file) {
  const said = { any: false };
  const cannot = (what) => {
    said.any = true;
    fail(`${file}: ${what}: this lint cannot read what a worker is handed there, and holds that SDK to none of it`);
  };
  return { said, cannot };
}

function typescriptWorker() {
  const source = typescriptCode(read(TS_CLAIMS));
  const { said, cannot } = unreadable(TS_CLAIMS);

  // A held job: one interface, generic in what differs by verb.
  const jobs = Object.fromEntries(VERBS.map((verb) => [verb, new Map()]));
  const header = /\binterface Held<([^>{]*)>\s*\{/.exec(source);
  if (!header) {
    cannot('no `interface Held<…>` declares a held job');
  } else {
    const generics = splitOutside(header[1], ',').map((parameter) => parameter.split(/\s/)[0]);
    const verbs = new Map();
    // The verb is a string, so the aliases are read with their strings kept.
    for (const alias of withoutComments(read(TS_CLAIMS), '"\'`').matchAll(/\bexport type (\w+) = Held<'(\w+)',\s*([^>]*)>;/g)) {
      verbs.set(alias[2], Object.fromEntries([`'${alias[2]}'`, ...splitOutside(alias[3], ',')].map((argument, at) => [generics[at], argument])));
    }
    const body = braced(source, header.index + header[0].length - 1);
    for (const verb of VERBS) {
      const bound = verbs.get(verb);
      if (!bound) {
        cannot(`no \`export type … = Held<'${verb}', …>\` declares a held ${verb} job`);
        continue;
      }
      for (const member of splitOutside(body, ';')) {
        const text = squeezed(member);
        const method = /^(\w+)\s*\(/.exec(text);
        const property = /^(?:readonly\s+)?(\w+?)\$?\??\s*:/.exec(text);
        if (method) {
          const takes = parameters(parenthesised(text, text.indexOf('('))).map(({ name, type }) => ({ name, type: bound[type] ?? type }));
          jobs[verb].set(method[1], { takes });
        } else if (property) {
          jobs[verb].set(property[1], { takes: [] });
        } else {
          cannot(`\`interface Held\` has a member that is neither a property nor a method: ${text}`);
        }
      }
    }
    if (verbs.size !== VERBS.length) cannot(`held jobs are declared for ${[...verbs.keys()].join(', ')}, and a job's verbs are ${VERBS.join(', ')}`);
  }

  // The claims: one class, whose own declarations are read. What it inherits is not.
  const claims = new Map();
  const declared = /\bexport class ClaimsObservable\b[^{]*\{/.exec(source);
  if (!declared) {
    cannot('no `export class ClaimsObservable` declares the claims');
  } else {
    const body = braced(source, declared.index + declared[0].length - 1);
    // Each declaration, as far as its body or the `;` that ends it.
    const declarations = [];
    let start = 0;
    for (let i = 0; i < body.length; ) {
      const c = body[i];
      if (c === '(' || c === '[') i = closing(body, i);
      else if (c === '{') {
        declarations.push(body.slice(start, i));
        i = closing(body, i);
        start = i;
      } else if (c === ';') {
        declarations.push(body.slice(start, i));
        start = ++i;
      } else i++;
    }
    for (const declaration of declarations.map(squeezed).filter((text) => text !== '')) {
      if (/^constructor\b/.test(declaration)) continue;
      if (/^(?:private|protected)\b|^#/.test(declaration)) continue;
      const member = /^(?:public\s+)?(?:readonly\s+)?(?:async\s+)?(?:get\s+)?(\w+?)\$?\??\s*[(:=]/.exec(declaration);
      if (!member || /^(?:static|set|declare|abstract)\b/.test(declaration)) {
        cannot(`\`class ClaimsObservable\` has a declaration that is neither a property nor a method of its own: ${declaration}`);
        continue;
      }
      claims.set(member[1], { takes: [] });
    }
  }
  if (said.any) return undefined;
  return { where: TS_CLAIMS, claims: { of: 'class ClaimsObservable', members: claims }, jobs: Object.fromEntries(VERBS.map((verb) => [verb, { of: `Held<'${verb}', …>`, members: jobs[verb] }])), either: undefined };
}

function rustWorker() {
  // A `'` in Rust opens a lifetime far more often than a character.
  const source = withoutComments(read(RUST_CLAIMS), '"');
  const { said, cannot } = unreadable(RUST_CLAIMS);

  /** The `pub fn`s of the one inherent `impl` whose header is `header`, each with the parameters it takes. */
  const implemented = (header) => {
    const found = [...source.matchAll(new RegExp(`^impl${header.replace(/[<>]/g, '\\$&')}\\s*\\{`, 'gm'))];
    const members = new Map();
    if (found.length !== 1) {
      cannot(`\`impl${header}\` is declared ${found.length} times, and this reads the one`);
      return members;
    }
    const body = braced(source, found[0].index + found[0][0].length - 1);
    for (const fn of body.matchAll(/\bpub (?:async )?fn (\w+)/g)) {
      const open = body.indexOf('(', fn.index + fn[0].length);
      members.set(camel(fn[1]), { takes: parameters(parenthesised(body, open)) });
    }
    return members;
  };

  const common = implemented('<V> Held<V>');
  const jobs = Object.fromEntries(
    VERBS.map((verb) => {
      const marker = verb[0].toUpperCase() + verb.slice(1);
      return [verb, { of: `Held<${marker}>`, members: new Map([...common, ...implemented(` Held<${marker}>`)]) }];
    }),
  );
  const worker = { where: RUST_CLAIMS, claims: { of: 'Claims', members: implemented(' Claims') }, jobs, either: { of: 'HeldJob', members: implemented(' HeldJob') } };
  return said.any ? undefined : worker;
}

function pythonWorker() {
  const source = withoutPythonComments(read(PYTHON_CLAIMS));
  const { said, cannot } = unreadable(PYTHON_CLAIMS);

  /** The public members a class declares, with those of the class it is made from: methods and properties, attributes of the class, and attributes its methods set. */
  const declares = (name) => {
    const members = new Map();
    const header = new RegExp(`^class ${name}(?:\\((\\w+)\\))?:\\n`, 'm').exec(source);
    if (!header) {
      cannot(`no \`class ${name}\` is declared`);
      return members;
    }
    if (header[1] !== undefined) for (const [member, declared] of declares(header[1])) members.set(member, declared);
    // The class's body: every line after its header, up to the next that begins at the margin.
    const rest = source.slice(header.index + header[0].length);
    const end = rest.search(/^\S/m);
    const body = end === -1 ? rest : rest.slice(0, end);
    for (const def of body.matchAll(/^ {4}(?:async )?def (\w+)[^(\n]*\(/gm)) {
      if (def[1].startsWith('_')) continue;
      members.set(camel(def[1]), { takes: parameters(parenthesised(body, def.index + def[0].length - 1)) });
    }
    for (const attribute of body.matchAll(/^ {4}(\w+)\s*[:=]/gm)) {
      if (!attribute[1].startsWith('_')) members.set(camel(attribute[1]), { takes: [] });
    }
    for (const attribute of body.matchAll(/\bself\.(\w+)\s*(?::[^=\n]+)?=(?!=)/g)) {
      if (!attribute[1].startsWith('_')) members.set(camel(attribute[1]), { takes: [] });
    }
    return members;
  };

  const jobs = Object.fromEntries(
    VERBS.map((verb) => {
      const name = `Held${verb[0].toUpperCase()}${verb.slice(1)}Job`;
      return [verb, { of: `class ${name}`, members: declares(name) }];
    }),
  );
  const worker = { where: PYTHON_CLAIMS, claims: { of: 'class Claims', members: declares('Claims') }, jobs, either: undefined };
  return said.any ? undefined : worker;
}

/** Hold what `sdk` declares for one thing a worker is handed to the table's rows for it. `verb` is given for a held job of one verb. */
function heldTo(sdk, where, what, declared, members, verb) {
  const its = `${sdk}'s ${what} (${declared.of} in ${where})`;
  const row = `the \`${what}\` rows of \`worker\` in ${TABLE}`;
  const has = declared.members;
  for (const [member, stated] of members) {
    // A member a held job has as its verb's is no member of a job held as either verb's.
    if (verb === undefined && stated.takes !== undefined) {
      if (has.has(member)) fail(`${its} has ${member}, which ${row} say is its verb's (\`takes\`): have it on the held job of each verb, or take \`takes\` from the row`);
      continue;
    }
    const absent = stated.absent?.[sdk];
    const named = stated.named?.[sdk];
    if (absent !== undefined) {
      if (has.has(member)) fail(`${its} has ${member}, and ${row} say ${sdk} has none: the row's \`absent\` is stale, so take ${sdk} out of it`);
      continue;
    }
    if (named !== undefined) {
      if (!has.has(named.name)) fail(`${its} has no ${named.name}, the name ${row} say ${sdk} has ${member} under: add it to the SDK, or correct the row's \`named\``);
      if (has.has(member)) fail(`${its} has ${member}, and ${row} say ${sdk} has it as ${named.name}: the row's \`named\` is stale, so take ${sdk} out of it`);
      continue;
    }
    const found = has.get(member);
    if (!found) {
      fail(`${its} has no ${member}, which ${row} list: add it to the SDK, or say in the row's \`absent\` why ${sdk} does not have it`);
      continue;
    }
    if (verb !== undefined && stated.takes !== undefined) {
      const taken = found.takes.map((parameter) => parameter.type).join(', ');
      if (taken !== stated.takes[verb]) fail(`${its} has a ${member} that takes ${taken === '' ? 'nothing' : taken}, and ${row} say a held ${verb} job's takes ${stated.takes[verb]}`);
    }
  }
  const listed = new Set([...members].flatMap(([member, stated]) => [member, ...(stated.named?.[sdk] ? [stated.named[sdk].name] : [])]));
  for (const member of has.keys()) {
    if (!listed.has(member)) fail(`${its} has ${member}, which ${row} do not list: add a row for it there before any SDK has it, with an \`absent\` for each SDK that is not to`);
  }
}

for (const [sdk, worker] of [['typescript', typescriptWorker()], ['rust', rustWorker()], ['python', pythonWorker()]]) {
  if (!worker) continue;
  if (handed.has('claims')) heldTo(sdk, worker.where, 'claims', worker.claims, handed.get('claims'), undefined);
  if (handed.has('heldJob')) {
    for (const verb of VERBS) heldTo(sdk, worker.where, 'heldJob', worker.jobs[verb], handed.get('heldJob'), verb);
    if (worker.either) heldTo(sdk, worker.where, 'heldJob', worker.either, handed.get('heldJob'), undefined);
  }
}

if (failures.length > 0) {
  console.error(`✗ lint:client-surface — ${failures.length} problem${failures.length === 1 ? '' : 's'}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
const count = [...rows.values()].reduce((total, methods) => total + methods.size, 0);
const membersCount = [...handed.values()].reduce((total, members) => total + members.size, 0);
console.log(`✓ lint:client-surface — ${count} methods in ${rows.size} namespaces, and ${membersCount} members of what a worker is handed, held by TypeScript, Rust and Python`);
