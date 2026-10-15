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
 *
 * THE STATE UNITS. The table's `stateUnits` section lists each state unit,
 * what each SDK makes it as (`made`), and its members by name. Each SDK is
 * held to it both ways, as it is to `worker`:
 *
 * - a unit an SDK does not declare;
 * - a unit an SDK declares that is not a StateUnit;
 * - a StateUnit an SDK declares there that no row makes;
 * - a member the table lists that an SDK's unit lacks;
 * - a public member an SDK's unit has that the table does not list;
 * - a unit the table says an SDK lacks (`absent`) that the SDK declares;
 * - a member the table says an SDK's unit lacks (`absent`) that it has.
 *
 * A TypeScript unit is an interface that extends StateUnit, or a class that
 * implements it. `dispose` is no member: every unit has it, being a
 * StateUnit. How a unit is made is no member either (Rust's `new`, Python's
 * `__init__`, a TypeScript class's constructor and its static factories), nor
 * what a language's protocols give it. A member is held by its name alone, as for
 * `worker`. What a unit does is not read here: each SDK's tests of its units
 * hold that.
 *
 * Each SDK's unit is read where it is declared in that SDK's source, its
 * tests and its test doubles (`testing`) left out. TypeScript's is an
 * interface of packages/sdk/src, a unit being one that extends `StateUnit`.
 * Rust's is a `pub struct` of packages/sdk-rust/src, its members the `pub
 * fn`s of its inherent `impl`s that take it (`self`), a unit being one with
 * `impl StateUnit for` it. Python's is a class of
 * packages/sdk-python/src/semiont, its members its public methods,
 * properties and attributes, a unit being one that names `StateUnit` as a
 * base. A `StateUnit` that no row makes is looked for in the same places.
 *
 * THE BUS OVER THE WIRE. The table's `wire` entry is the typed bus over a
 * client's transport, which every client hands out as `wire`: what each SDK
 * makes it as (`made`), and its members by name. Each SDK is held to it as
 * to a state unit, both ways:
 *
 * - a bus an SDK does not declare, or a client that does not hand it out;
 * - a member the table lists that an SDK's bus lacks;
 * - a public member an SDK's bus has that the table does not list;
 * - a member the table says an SDK's bus lacks (`absent`) that it has.
 *
 * A bus hands out no transport: a client's transport is the client's
 * `transport`, and only there, so a `transport` row is refused. TypeScript's
 * bus is the class of packages/core/src, Rust's the `pub fn`s that take it of
 * its inherent `impl`s in packages/sdk-rust/src, Python's the public methods,
 * properties and attributes of its class in packages/sdk-python/src/semiont.
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
const TS_SDK = 'packages/sdk/src';
const TS_CORE = 'packages/core/src';
const RUST_SDK = 'packages/sdk-rust/src';
const PYTHON_SDK = 'packages/sdk-python/src/semiont';
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
 * A TypeScript class body's declarations, each as far as its body or the `;`
 * that ends it. Outside a body, a `<` opens type arguments, whose `{` is a
 * type's and opens no body.
 */
function classDeclarations(body) {
  const declarations = [];
  let start = 0;
  for (let i = 0; i < body.length; ) {
    const c = body[i];
    if ((c === '=' || c === '-') && body[i + 1] === '>') i += 2;
    else if (c === '(' || c === '[' || c === '<') i = closing(body, i);
    else if (c === '{') {
      declarations.push(body.slice(start, i));
      i = closing(body, i);
      start = i;
    } else if (c === ';') {
      declarations.push(body.slice(start, i));
      start = ++i;
    } else i++;
  }
  return declarations.map(squeezed).filter((text) => text !== '');
}

/** Whether a class's declaration is its own, out of its users' reach: private, protected, or `#`. */
const isPrivate = (declaration) => /^(?:private|protected)\b|^(?:readonly\s+)?#/.test(declaration);

/** The name a class's declaration of a property or a method declares, `$` and `?` left off; `undefined` when it declares neither. */
const declaredName = (declaration) => /^(?:public\s+)?(?:readonly\s+)?(?:async\s+)?(?:get\s+)?(\w+?)\$?\??\s*[(:=<]/.exec(declaration)?.[1];

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
    for (const declaration of classDeclarations(body)) {
      if (/^constructor\b/.test(declaration)) continue;
      if (isPrivate(declaration)) continue;
      const member = declaredName(declaration);
      if (!member || /^(?:static|set|declare|abstract)\b/.test(declaration)) {
        cannot(`\`class ClaimsObservable\` has a declaration that is neither a property nor a method of its own: ${declaration}`);
        continue;
      }
      claims.set(member, { takes: [] });
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

// ── The state units ─────────────────────────────────────────────────────

/** unit → its row, with member → row */
const units = new Map();
if (!Array.isArray(table.stateUnits) || table.stateUnits.length === 0) fail(`${TABLE}: \`stateUnits\` lists no state unit`);
for (const unit of table.stateUnits ?? []) {
  const what = `${TABLE}: stateUnits.${unit.unit}`;
  if (units.has(unit.unit)) fail(`${what} is listed twice`);
  const members = new Map();
  units.set(unit.unit, { ...unit, members });
  const strays = Object.keys(unit).filter((key) => !['unit', 'docs', 'made', 'members', 'absent'].includes(key));
  if (strays.length > 0) fail(`${what} states ${strays.join(', ')}, which a unit's row does not: what a unit does is its SDKs' tests' to hold`);
  if (typeof unit.docs !== 'string' || unit.docs === '') fail(`${what} does not say what it is (\`docs\`)`);
  for (const sdk of SDKS) {
    if (typeof unit.made?.[sdk] !== 'string' || !/^\w+$/.test(unit.made[sdk])) fail(`${what} does not say what ${sdk} makes it as (\`made\`)`);
  }
  for (const sdk of Object.keys(unit.made ?? {})) {
    if (!SDKS.includes(sdk)) fail(`${what}: \`made\` names "${sdk}", which is no SDK this lint reads`);
  }
  for (const [sdk, why] of Object.entries(unit.absent ?? {})) {
    if (!SDKS.includes(sdk)) fail(`${what}: \`absent\` names "${sdk}", which is no SDK this lint reads`);
    if (typeof why !== 'string' || why === '') fail(`${what}: \`absent\` does not say why ${sdk} lacks it`);
  }
  if (SDKS.every((sdk) => unit.absent?.[sdk] !== undefined)) fail(`${what} is absent from every SDK: it is no unit`);
  if (!Array.isArray(unit.members)) fail(`${what} does not list its members: a unit with none lists none`);
  for (const row of unit.members ?? []) {
    const name = `${what}.${row.member}`;
    if (members.has(row.member)) fail(`${name} is listed twice`);
    members.set(row.member, row);
    const others = Object.keys(row).filter((key) => !['member', 'absent'].includes(key));
    if (others.length > 0) fail(`${name} states ${others.join(', ')}, and a unit's member is its name, with an \`absent\` for each SDK that has none`);
    if (row.member === 'dispose') fail(`${name}: \`dispose\` is every unit's, being a StateUnit, and is listed for none`);
    for (const [sdk, why] of Object.entries(row.absent ?? {})) {
      if (!SDKS.includes(sdk)) fail(`${name}: \`absent\` names "${sdk}", which is no SDK this lint reads`);
      if (typeof why !== 'string' || why === '') fail(`${name}: \`absent\` does not say why ${sdk} lacks it`);
      if (unit.absent?.[sdk] !== undefined) fail(`${name}: \`absent\` names ${sdk}, which has no ${unit.unit} unit at all`);
    }
    if (SDKS.every((sdk) => row.absent?.[sdk] !== undefined)) fail(`${name} is absent from every SDK: it is no member`);
  }
}

/** The files under `directory` whose names end in `extension`, its tests and its test doubles (`testing`) left out. */
function sources(directory, extension) {
  if (!existsSync(join(ROOT, directory))) return [];
  return readdirSync(join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return ['__tests__', 'testing'].includes(entry.name) ? [] : sources(path, extension);
    if (entry.name === `testing${extension}`) return [];
    return entry.name.endsWith(extension) && !entry.name.endsWith(`.test${extension}`) ? [path] : [];
  });
}

/**
 * Each reader answers what its SDK makes a unit as, given the name the table
 * says it makes it under: where it is declared, whether it is a StateUnit,
 * and its members, each as the table spells it. `undefined` when the SDK
 * declares nothing of that name. A declaration it cannot read is a failure.
 */

/** An `export interface`'s header, its `extends` list captured; an `export class`'s, its `implements` list captured. */
const interfaceHeader = (name) => new RegExp(`\\bexport interface ${name}(?:<[^>{]*>)?\\s*(?:extends\\s+([^{]+?))?\\s*\\{`, 'g');
const classHeader = (name) => new RegExp(`\\bexport class ${name}(?:<[^>{]*>)?\\s*(?:extends\\s+[^{]+?\\s+)?(?:implements\\s+([^{]+?))?\\s*\\{`, 'g');

function typescriptUnit(made, directory) {
  const found = sources(directory, '.ts').flatMap((file) => {
    const source = typescriptCode(read(file));
    return [
      ...[...source.matchAll(interfaceHeader(made))].map((header) => ({ file, source, header, kind: 'interface' })),
      ...[...source.matchAll(classHeader(made))].map((header) => ({ file, source, header, kind: 'class' })),
    ];
  });
  if (found.length === 0) return undefined;
  const [{ file, source, header, kind }] = found;
  if (found.length > 1) fail(`${found.map((declared) => declared.file).join(', ')}: \`${made}\` is declared ${found.length} times, and this reads the one`);
  const body = braced(source, header.index + header[0].length - 1);
  const members = new Set();
  if (kind === 'interface') {
    for (const member of splitOutside(body, ';')) {
      const text = squeezed(member);
      const named = /^(?:readonly\s+)?(\w+?)\$?\??\s*[(:]/.exec(text);
      if (!named) {
        fail(`${file}: \`interface ${made}\` has a member that is neither a property nor a method: ${text}`);
        continue;
      }
      if (named[1] !== 'dispose') members.add(named[1]);
    }
  } else {
    for (const declaration of classDeclarations(body)) {
      // How it is made is no member, nor what is its own.
      if (/^(?:constructor|static)\b/.test(declaration) || isPrivate(declaration)) continue;
      const named = declaredName(declaration);
      if (!named || /^(?:set|declare|abstract)\b/.test(declaration)) {
        fail(`${file}: \`class ${made}\` has a declaration that is neither a property nor a method of its own: ${declaration}`);
        continue;
      }
      if (named !== 'dispose') members.add(named);
    }
  }
  const stated = splitOutside(header[1] ?? '', ',').map(squeezed);
  return { where: `${kind} ${made} in ${file}`, isUnit: stated.includes('StateUnit'), members };
}

function rustUnit(made, directory) {
  const files = sources(directory, '.rs').map((file) => ({ file, source: withoutComments(read(file), '"') }));
  const struct = new RegExp(`^pub struct ${made}\\b`, 'm');
  const declared = files.filter(({ source }) => struct.test(source));
  if (declared.length === 0) return undefined;
  if (declared.length > 1) fail(`${declared.map(({ file }) => file).join(', ')}: \`pub struct ${made}\` is declared ${declared.length} times, and this reads the one`);
  const [{ file, source }] = declared;
  const members = new Set();
  // An `impl`'s header, with its generics and any `where` clause, up to the brace that opens its body.
  const header = (of) => new RegExp(`^impl(?:<[^>{]*>)? ${of}(?:<[^>{]*>)?(?:\\s+where\\b[^{]*)?\\s*\\{`, 'gm');
  for (const impl of source.matchAll(header(made))) {
    const body = braced(source, impl.index + impl[0].length - 1);
    for (const fn of body.matchAll(/\bpub (?:async )?fn (\w+)/g)) {
      // A member takes the unit; a function that takes none is how it is made (`new`, `persisted`).
      const taken = parenthesised(body, body.indexOf('(', fn.index + fn[0].length));
      if (/^\s*(?:&\s*(?:'\w+\s+)?)?(?:mut\s+)?self\b/.test(taken)) members.add(camel(fn[1]));
    }
  }
  const isUnit = header(`StateUnit for ${made}`).test(source);
  return { where: `${made} in ${file}`, isUnit, members };
}

function pythonUnit(made, directory) {
  const found = sources(directory, '.py').flatMap((file) => {
    const source = withoutPythonComments(read(file));
    const header = new RegExp(`^class ${made}(?:\\[[^\\]]*\\])?(?:\\(([^)]*)\\))?:\\n`, 'm').exec(source);
    return header ? [{ file, source, header }] : [];
  });
  if (found.length === 0) return undefined;
  if (found.length > 1) fail(`${found.map(({ file }) => file).join(', ')}: \`class ${made}\` is declared ${found.length} times, and this reads the one`);
  const [{ file, source, header }] = found;
  // The class's body: every line after its header, up to the next that begins at the margin.
  const rest = source.slice(header.index + header[0].length);
  const end = rest.search(/^\S/m);
  const body = end === -1 ? rest : rest.slice(0, end);
  const members = new Set();
  const named = [
    ...[...body.matchAll(/^ {4}(?:async )?def (\w+)/gm)].map((def) => def[1]),
    ...[...body.matchAll(/^ {4}(\w+)\s*[:=]/gm)].map((attribute) => attribute[1]),
    ...[...body.matchAll(/\bself\.(\w+)\s*(?::[^=\n]+)?=(?!=)/g)].map((attribute) => attribute[1]),
  ];
  for (const name of named) {
    if (!name.startsWith('_') && name !== 'dispose') members.add(camel(name));
  }
  const bases = splitOutside(header[1] ?? '', ',').map(squeezed);
  return { where: `class ${made} in ${file}`, isUnit: bases.includes('StateUnit'), members };
}

/** Every unit `sdk` declares, by name, each with the file it is declared in. */
function declaredUnits(sdk) {
  const extending = (list) => splitOutside(list ?? '', ',').map(squeezed).includes('StateUnit');
  if (sdk === 'typescript') {
    return sources(TS_SDK, '.ts').flatMap((file) => {
      const source = typescriptCode(read(file));
      return [...source.matchAll(interfaceHeader('(\\w+)')), ...source.matchAll(classHeader('(\\w+)'))]
        .filter((header) => extending(header[2]))
        .map((header) => ({ name: header[1], file }));
    });
  }
  if (sdk === 'rust') {
    return sources(RUST_SDK, '.rs').flatMap((file) =>
      [...withoutComments(read(file), '"').matchAll(/^impl(?:<[^>{]*>)? StateUnit for (\w+)/gm)].map((impl) => ({ name: impl[1], file })),
    );
  }
  return sources(PYTHON_SDK, '.py').flatMap((file) =>
    [...withoutPythonComments(read(file)).matchAll(/^class (\w+)(?:\[[^\]]*\])?\(([^)]*)\):/gm)]
      .filter((header) => extending(header[2]))
      .map((header) => ({ name: header[1], file })),
  );
}

for (const sdk of SDKS) {
  const listed = new Set([...units.values()].map((unit) => unit.made?.[sdk]));
  for (const { name, file } of declaredUnits(sdk)) {
    if (!listed.has(name)) fail(`${file}: ${sdk}'s ${name} is a StateUnit that no row of \`stateUnits\` in ${TABLE} makes: add a row for it there before any SDK has it, with an \`absent\` for each SDK that is not to`);
  }
}

const readers = { typescript: typescriptUnit, rust: rustUnit, python: pythonUnit };
/** Where each SDK's units are declared. */
const UNIT_SOURCES = { typescript: TS_SDK, rust: RUST_SDK, python: PYTHON_SDK };
for (const [name, unit] of units) {
  const row = `the \`${name}\` row of \`stateUnits\` in ${TABLE}`;
  for (const sdk of SDKS) {
    const made = unit.made?.[sdk];
    if (typeof made !== 'string') continue;
    const declared = readers[sdk](made, UNIT_SOURCES[sdk]);
    if (unit.absent?.[sdk] !== undefined) {
      if (declared) fail(`${sdk} has ${declared.where}, and ${row} says ${sdk} has no ${name} unit: the row's \`absent\` is stale, so take ${sdk} out of it`);
      continue;
    }
    if (!declared) {
      fail(`${sdk} declares no ${made}, which ${row} says it makes the ${name} unit as: add it to the SDK, or say in the row's \`absent\` why ${sdk} has none`);
      continue;
    }
    const its = `${sdk}'s ${name} unit (${declared.where})`;
    if (!declared.isUnit) fail(`${its} is not a StateUnit: say so where it is declared, so it ends by \`dispose\` as every unit does`);
    for (const [member, stated] of unit.members) {
      if (stated.absent?.[sdk] !== undefined) {
        if (declared.members.has(member)) fail(`${its} has ${member}, and ${row} says ${sdk}'s has none: the member's \`absent\` is stale, so take ${sdk} out of it`);
        continue;
      }
      if (!declared.members.has(member)) fail(`${its} has no ${member}, which ${row} lists: add it to the SDK, under that name, or say in the member's \`absent\` why ${sdk}'s has none`);
    }
    for (const member of declared.members) {
      if (!unit.members.has(member)) fail(`${its} has ${member}, which ${row} does not list: rename it to the row's name for it, or add a row for it there before any SDK has it`);
    }
  }
}

// ── The bus over the wire ───────────────────────────────────────────────

/** Where each SDK declares its bus: TypeScript's is @semiont/core's. */
const WIRE_SOURCES = { typescript: TS_CORE, rust: RUST_SDK, python: PYTHON_SDK };

/**
 * Where each SDK's client hands its bus out as `wire`, and what says it does,
 * given the name the SDK makes the bus as.
 */
const HANDED_OUT = {
  typescript: { file: `${TS_SDK}/client.ts`, says: (made) => new RegExp(`^\\s+readonly wire: ${made};$`, 'm') },
  rust: { file: `${RUST_SDK}/client.rs`, says: (made) => new RegExp(`^\\s+pub fn wire\\(&self\\) -> &${made} \\{$`, 'm') },
  python: { file: `${PYTHON_SDK}/client.py`, says: (made) => new RegExp(`^\\s+self\\.wire: Final = ${made}\\(transport\\)$`, 'm') },
};

/** member → row */
const wireMembers = new Map();
const wire = table.wire;
const wireRow = `\`wire\` in ${TABLE}`;
if (typeof wire !== 'object' || wire === null || Array.isArray(wire)) fail(`${TABLE}: \`wire\` does not state the bus over a client's transport`);
else {
  const strays = Object.keys(wire).filter((key) => !['docs', 'made', 'members'].includes(key));
  if (strays.length > 0) fail(`${wireRow} states ${strays.join(', ')}, which it does not: what the bus does is its SDKs' tests' to hold`);
  if (typeof wire.docs !== 'string' || wire.docs === '') fail(`${wireRow} does not say what it is (\`docs\`)`);
  for (const sdk of SDKS) {
    if (typeof wire.made?.[sdk] !== 'string' || !/^\w+$/.test(wire.made[sdk])) fail(`${wireRow} does not say what ${sdk} makes the bus as (\`made\`)`);
  }
  for (const sdk of Object.keys(wire.made ?? {})) {
    if (!SDKS.includes(sdk)) fail(`${wireRow}: \`made\` names "${sdk}", which is no SDK this lint reads`);
  }
  if (!Array.isArray(wire.members) || wire.members.length === 0) fail(`${wireRow} lists no member`);
  for (const row of wire.members ?? []) {
    const name = `${wireRow}, member ${row.member}`;
    if (wireMembers.has(row.member)) fail(`${name} is listed twice`);
    wireMembers.set(row.member, row);
    const others = Object.keys(row).filter((key) => !['member', 'absent'].includes(key));
    if (others.length > 0) fail(`${name} states ${others.join(', ')}, and a member of the bus is its name, with an \`absent\` for each SDK that has none`);
    if (row.member === 'transport') fail(`${name}: a bus hands out no transport; a client's transport is the client's \`transport\`, and only there`);
    for (const [sdk, why] of Object.entries(row.absent ?? {})) {
      if (!SDKS.includes(sdk)) fail(`${name}: \`absent\` names "${sdk}", which is no SDK this lint reads`);
      if (typeof why !== 'string' || why === '') fail(`${name}: \`absent\` does not say why ${sdk} lacks it`);
    }
    if (SDKS.every((sdk) => row.absent?.[sdk] !== undefined)) fail(`${name} is absent from every SDK: it is no member`);
  }
  for (const sdk of SDKS) {
    const made = wire.made?.[sdk];
    if (typeof made !== 'string') continue;
    const declared = readers[sdk](made, WIRE_SOURCES[sdk]);
    if (!declared) {
      fail(`${sdk} declares no ${made} in ${WIRE_SOURCES[sdk]}, which ${wireRow} says it makes the bus over a client's transport as`);
      continue;
    }
    const handedOut = HANDED_OUT[sdk];
    if (!handedOut.says(made).test(read(handedOut.file))) fail(`${handedOut.file}: ${sdk}'s client does not hand out its ${made} as \`wire\`, which ${wireRow} says every client does`);
    const its = `${sdk}'s bus (${declared.where})`;
    for (const [member, stated] of wireMembers) {
      if (stated.absent?.[sdk] !== undefined) {
        if (declared.members.has(member)) fail(`${its} has ${member}, and ${wireRow} says ${sdk}'s has none: the member's \`absent\` is stale, so take ${sdk} out of it`);
        continue;
      }
      if (!declared.members.has(member)) fail(`${its} has no ${member}, which ${wireRow} lists: add it to the SDK, under that name, or say in the member's \`absent\` why ${sdk}'s has none`);
    }
    for (const member of declared.members) {
      if (!wireMembers.has(member)) fail(`${its} has ${member}, which ${wireRow} does not list: rename it to the row's name for it, or add a row for it there before any SDK has it`);
    }
  }
}

if (failures.length > 0) {
  console.error(`✗ lint:client-surface — ${failures.length} problem${failures.length === 1 ? '' : 's'}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
const count = [...rows.values()].reduce((total, methods) => total + methods.size, 0);
const membersCount = [...handed.values()].reduce((total, members) => total + members.size, 0);
const unitMembers = [...units.values()].reduce((total, unit) => total + unit.members.size, 0);
console.log(`✓ lint:client-surface — ${count} methods in ${rows.size} namespaces, ${membersCount} members of what a worker is handed, ${unitMembers} members of ${units.size} state units, and ${wireMembers.size} members of the bus over the wire, held by TypeScript, Rust and Python`);
