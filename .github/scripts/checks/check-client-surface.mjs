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
 * test runs the table's cases (packages/typescript/sdk/src/__tests__/client-surface.test.ts,
 * packages/rust/sdk/tests/surface.rs, packages/python/sdk/tests/test_surface.py,
 * packages/go/sdk/surface_test.go).
 *
 * TypeScript's signatures are the interfaces of
 * packages/typescript/sdk/src/namespaces/types.ts; Rust's are the `pub fn`s of each
 * `impl <Name>Namespace` in packages/rust/sdk/src/namespaces; Python's are the
 * methods of each `class <Name>Namespace` in
 * packages/python/sdk/src/semiont/namespaces whose names begin with no
 * underscore; Go's are the exported methods of each `type <Name>Namespace
 * struct` of the root package, packages/go/sdk, each declared with its
 * methods in `<namespace>.go`, a method being the table's name with its
 * first letter a capital (`Kb`, `HealthCheck`).
 *
 * Kotlin's are the `public` members of each `public class <Name>Namespace`
 * of packages/kotlin/sdk/src/main/kotlin/semiont/namespaces, each in
 * `<Name>Namespace.kt`. `explicitApi()` puts `public` on every public
 * declaration, so a member is a declaration that says it is. Java's spelling
 * of a member is no member of its own: `<m>Future`, which returns a
 * `CompletableFuture`, is Java's call of a `suspend` member `<m>`, and every
 * `suspend` member has one; `asPublisher` is Java's reading of a type that is
 * a `Flow`, and every such type has one. A twin without its member, or a
 * member without its twin, fails, in every section that reads Kotlin.
 *
 * WHICH SDKS. Each section below holds the SDKs it has a reader for, and
 * those alone: its roster is its readers' keys. An `absent`, `made`,
 * `named` or `notYetReached` that names an SDK outside a section's roster
 * fails there.
 *
 * NOT YET REACHED. An SDK that is to have something and does not yet says
 * so in `notYetReached`, with what is to be built for it: on a member, or on
 * the whole of a namespace, of what a worker is handed, of a state unit, of
 * the bus over the wire, of the storage or of a module. It is held as
 * `absent` is, and is stale once the SDK has what it names. A whole that is
 * not yet reached needs no `made` or `where` for that SDK.
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
 * `ClaimsObservable` in packages/typescript/sdk/src/claims.ts, a held job of a verb
 * being `Held<'<verb>', <what its verb's members take>>`. Rust's are the
 * `pub fn`s of `impl<V> Held<V>`, of `impl Held<Mark>` and `impl Held<Yield>`
 * for a job of each verb, of `impl HeldJob` for a job of either, and of
 * `impl Claims`, in packages/rust/sdk/src/claims.rs. Python's are the public
 * methods, properties and attributes of `HeldMarkJob` and `HeldYieldJob`,
 * with those of the class each is made from, and of `Claims`, in
 * packages/python/sdk/src/semiont/claims.py. Go's are the exported methods
 * and fields of `type HeldMarkJob struct` and `type HeldYieldJob struct`,
 * with those of the struct each embeds, of `type Claims struct`, and the
 * exported methods of `type HeldJob interface` for a job of either verb, in
 * the files of packages/go/sdk; what a member takes is its parameters less
 * its context, a type of the spec's named as the spec names it. A
 * declaration this cannot read is a failure, never a member passed over.
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
 * - a member the table says an SDK's unit lacks (`absent`) that it has;
 * - a unit no public way makes from outside its SDK;
 * - a maker the row names for an SDK (`madeBy`) that the SDK lacks, or has
 *   but not publicly.
 *
 * With no maker named, a unit is made by its type's own constructor, which
 * is public: a TypeScript class's, unless it is private or protected; Rust's
 * `pub fn new` in the type's own `impl`; a Python class's; a Kotlin class's
 * primary or secondary constructor, or the one a class with none declared
 * has. Go has no constructors, so every Go unit names its maker. Public is
 * reachable from outside the SDK: what packages/typescript/sdk/src/index.ts
 * exports, following its `export *` and `export { … } from` through the
 * SDK's files; an item a module that packages/rust/sdk/src/lib.rs reaches
 * through `pub mod` declares `pub` or re-exports with `pub use`; a name in
 * the `__all__` of a Python module whose path has no part that begins with
 * an underscore; what Kotlin declares `public`; and what Go exports from a
 * package that is not internal.
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
 * interface of packages/typescript/sdk/src, a unit being one that extends `StateUnit`.
 * Rust's is a `pub struct` of packages/rust/sdk/src, its members the `pub
 * fn`s of its inherent `impl`s that take it (`self`), a unit being one with
 * `impl StateUnit for` it. Python's is a class of
 * packages/python/sdk/src/semiont, its members its public methods,
 * properties and attributes, a unit being one that names `StateUnit` as a
 * base. Go's is a `type <name> struct` of packages/go/sdk and the packages
 * below it, its test double (a package whose name ends in `test`, as Go's own
 * `httptest` does) and its conformance drivers left out; its members are its
 * exported fields and methods, with those of each struct it embeds, each as
 * the table spells it (its first letter small), and a unit is one declared
 * as one (`_ StateUnit = (*<name>)(nil)`). Go spells `dispose` `Close`, and
 * it is no member either. A `StateUnit` that no row makes is looked for in
 * the same places.
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
 * bus is the class of packages/typescript/core/src, Rust's the `pub fn`s that take it of
 * its inherent `impl`s in packages/rust/sdk/src, Python's the public methods,
 * properties and attributes of its class in packages/python/sdk/src/semiont,
 * Go's the exported methods of its struct in the root package,
 * packages/go/sdk, with the package's exported functions that take it: a Go
 * method takes no type parameters, so a member generic in its channel is a
 * function of the package (`Emit(ctx, w, bus.MarkSubmit, payload)`).
 *
 * THE STORAGE. The table's `storage` entry is where a client keeps text
 * under a key, the interface an application implements: what each SDK makes
 * it as (`made`), and its members by name. Each SDK is held to it as to the
 * bus, both ways:
 *
 * - a storage an SDK does not declare;
 * - a member the table lists that an SDK's storage lacks;
 * - a public member an SDK's storage has that the table does not list;
 * - a member the table says an SDK's storage lacks (`absent`) that it has.
 *
 * TypeScript's storage is an interface of packages/typescript/sdk/src,
 * Python's a class of packages/python/sdk/src/semiont (a `Protocol`) and
 * Kotlin's an interface of packages/kotlin/sdk/src/main/kotlin/semiont, each
 * read as a unit's is; Go's is the exported methods of its interface in the
 * root package, packages/go/sdk, and Rust's the functions of its trait in
 * packages/rust/sdk/src. What implements a storage is not read.
 *
 * Which files a directory holds, and whether a schema exists, is what git says
 * the repository holds (`repository-files.mjs`).
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryFiles } from './repository-files.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const REPOSITORY = repositoryFiles(ROOT);
const TABLE = 'specs/src/client/surface.json';
const REGISTRY = 'specs/src/bus/registry.json';
const TS_INTERFACES = 'packages/typescript/sdk/src/namespaces/types.ts';
const RUST_NAMESPACES = 'packages/rust/sdk/src/namespaces';
const PYTHON_NAMESPACES = 'packages/python/sdk/src/semiont/namespaces';
const TS_CLAIMS = 'packages/typescript/sdk/src/claims.ts';
const RUST_CLAIMS = 'packages/rust/sdk/src/claims.rs';
const PYTHON_CLAIMS = 'packages/python/sdk/src/semiont/claims.py';
const TS_SDK = 'packages/typescript/sdk/src';
const TS_CORE = 'packages/typescript/core/src';
const RUST_SDK = 'packages/rust/sdk/src';
const PYTHON_SDK = 'packages/python/sdk/src/semiont';
const GO_SDK = 'packages/go/sdk';
const GO_CLAIMS = 'packages/go/sdk/claims.go';
const KOTLIN_SDK = 'packages/kotlin/sdk/src/main/kotlin/semiont';
const KOTLIN_NAMESPACES = `${KOTLIN_SDK}/namespaces`;
const SCHEMAS = 'specs/src/components/schemas';
/** Each SDK as a message names it. */
const LANGUAGES = { typescript: 'TypeScript', rust: 'Rust', python: 'Python', go: 'Go', kotlin: 'Kotlin' };

const failures = [];
const fail = (message) => failures.push(message);
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
/** The names of the files directly in `directory` whose names end in `extension`, in order. */
const filesIn = (directory, extension) =>
  REPOSITORY.filter((path) => dirname(path) === directory && path.endsWith(extension)).map((path) => basename(path));

const table = JSON.parse(read(TABLE));
const registry = JSON.parse(read(REGISTRY));
const channels = new Set(registry.channels.map((entry) => entry.channel));
const requests = new Set(registry.operations.map((operation) => operation.request));

// ── The table itself ────────────────────────────────────────────────────

/** namespace → method → row */
const rows = new Map();
/** namespace → its row */
const namespaceRows = new Map();
for (const namespace of table.namespaces) {
  if (rows.has(namespace.namespace)) fail(`${TABLE} lists the namespace ${namespace.namespace} twice`);
  namespaceRows.set(namespace.namespace, namespace);
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

/** The text between the parenthesis at `open` and the one that closes it. */
const parenthesised = (source, open) => source.slice(open + 1, closing(source, open) - 1);

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

/**
 * Rust's trait under `directory`, given its name: the functions it declares,
 * each as the table spells it, a trait's functions being public. A default
 * function's body is none of it; an associated type or constant is a
 * failure: this reads none.
 */
function rustTrait(made, directory) {
  const header = new RegExp(`^pub trait ${made}\\b[^{;]*\\{`, 'm');
  const found = sources(directory, '.rs').map((file) => ({ file, source: withoutComments(read(file), '"') })).filter(({ source }) => header.test(source));
  if (found.length === 0) return undefined;
  if (found.length > 1) fail(`${found.map(({ file }) => file).join(', ')}: \`pub trait ${made}\` is declared ${found.length} times, and this reads the one`);
  const [{ file, source }] = found;
  const opened = header.exec(source);
  const members = new Set();
  for (const item of outsideBrackets(braced(source, opened.index + opened[0].length - 1)).matchAll(/\b(fn|type|const)\s+(\w+)/g)) {
    if (item[1] === 'fn') members.add(camel(item[2]));
    else fail(`${file}: \`trait ${made}\` declares the ${item[1]} ${item[2]}, which this lint does not read`);
  }
  return { where: `trait ${made} in ${file}`, members };
}

/** namespace → method → { shape, returns } */
function rustSurface() {
  const surface = new Map();
  const files = filesIn(RUST_NAMESPACES, '.rs');
  for (const file of files) {
    // A `'` in Rust opens a lifetime far more often than a character.
    const source = withoutComments(read(`${RUST_NAMESPACES}/${file}`), '"');
    for (const match of source.matchAll(/^impl (\w+)Namespace\s*\{/gm)) {
      // A namespace whose name Rust keeps for itself is in a file named with
      // a trailing underscore; the type's name says which namespace it is.
      const namespace = match[1][0].toLowerCase() + match[1].slice(1);
      const expected = files.includes(`${namespace}_.rs`) ? `${namespace}_.rs` : `${namespace}.rs`;
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
  const files = filesIn(PYTHON_NAMESPACES, '.py');
  for (const file of files) {
    const source = withoutPythonComments(read(`${PYTHON_NAMESPACES}/${file}`));
    for (const match of source.matchAll(/^class (\w+)Namespace\b[^\n]*:\n/gm)) {
      // A namespace whose name Python keeps for itself is in a file named
      // with a trailing underscore; the class's name says which namespace it is.
      const namespace = match[1][0].toLowerCase() + match[1].slice(1);
      const expected = files.includes(`${namespace}_.py`) ? `${namespace}_.py` : `${namespace}.py`;
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

// ── Go ──────────────────────────────────────────────────────────────────

/**
 * Go `source` with its comments gone and its strings and runes emptied, so
 * every bracket left is the code's own. A raw string (between backquotes)
 * has no escapes.
 */
function goCode(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const two = source.slice(i, i + 2);
    if (two === '//') {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      out += ' ';
    } else if (c === '`') {
      const end = source.indexOf('`', i + 1);
      i = end === -1 ? source.length : end + 1;
      out += '``';
    } else if (c === '"' || c === "'") {
      i++;
      while (i < source.length && source[i] !== c && source[i] !== '\n') i += source[i] === '\\' ? 2 : 1;
      i++;
      out += `${c}${c}`;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The index just past the bracket that closes the one at `open`. In Go, `<` is no bracket: it opens `<-chan`. */
function goClosing(source, open) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const stack = [];
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i + 1;
    }
  }
  throw new Error('a bracket that is never closed');
}

/** A Go list cut at each comma inside no bracket. */
function goSplit(list) {
  const parts = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      parts.push(list.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(list.slice(start));
  return parts.map(squeezed).filter((part) => part !== '');
}

/**
 * A Go function's parameters and results, its parameter list opening at
 * `open`: each the text between its brackets, the results as declared (a
 * single type, a parenthesised list, or nothing). The body is the first brace
 * outside every bracket that opens no `struct` or `interface` type.
 */
function goSignature(code, open) {
  const afterParameters = goClosing(code, open);
  let depth = 0;
  for (let i = afterParameters; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === '{' && depth === 0) {
      if (/\b(?:struct|interface)\s*$/.test(code.slice(afterParameters, i))) {
        i = goClosing(code, i) - 1;
        continue;
      }
      return { parameters: code.slice(open + 1, afterParameters - 1), results: squeezed(code.slice(afterParameters, i)) };
    }
  }
  throw new Error('a function with no body');
}

/** The types a Go parameter or result list declares, its names left out: `(n int, ok bool, err error)` and `(int, bool, error)` are both `int, bool, error`. */
function goTypes(list) {
  const parts = goSplit(list);
  // A list is named throughout or not at all; a part that is a name and a type says which.
  const named = parts.some((part) => /^[A-Za-z_]\w*\s+(?!$)/.test(part) && !/^(?:chan|func|map|struct|interface)\b/.test(part));
  if (!named) return parts;
  // `a, b int`: a name without a type has the next one's.
  const types = [];
  let waiting = 0;
  for (const part of parts) {
    const typed = /^[A-Za-z_]\w*\s+(.+)$/.exec(part);
    if (!typed) {
      waiting++;
      continue;
    }
    for (let k = 0; k <= waiting; k++) types.push(squeezed(typed[1]));
    waiting = 0;
  }
  return types;
}

/** A Go method's shape, from the types it returns. */
function goShape(results) {
  const types = results.startsWith('(') ? goTypes(results.slice(1, -1)) : results === '' ? [] : [results];
  if (types.length === 0) return 'signal';
  if (types.length === 3 && types[0] === 'int' && types[1] === 'bool' && types[2] === 'error') return 'count';
  if (types[types.length - 1] === 'error' && types.length <= 2) return 'promise';
  if (types.length !== 1) return undefined;
  const [returns] = types;
  if (returns.startsWith('iter.Seq2[')) return 'events';
  if (returns.startsWith('*Cached[')) return 'cache';
  if (returns.startsWith('*Running[')) return 'stream';
  if (returns.startsWith('*Delegation[')) return 'delegation';
  if (returns === '*Upload') return 'upload';
  if (returns === '*Claims') return 'claims';
  return undefined;
}

/** A Go name as the table spells it: its first letter small. */
const tableName = (goName) => goName[0].toLowerCase() + goName.slice(1);

/** The root package's files, its tests left out: every `.go` file directly in packages/go/sdk. */
function goFiles() {
  return filesIn(GO_SDK, '.go')
    .filter((name) => !name.endsWith('_test.go'))
    .map((name) => ({ file: `${GO_SDK}/${name}`, code: goCode(read(`${GO_SDK}/${name}`)) }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

/** namespace → method → { shape, returns } */
function goSurface() {
  const surface = new Map();
  const files = goFiles();
  const placed = (file, name) => {
    const namespace = tableName(name);
    if (file !== `${GO_SDK}/${namespace}.go`) fail(`${file} declares ${name}Namespace or a method of it, which belongs in ${GO_SDK}/${namespace}.go`);
    if (!surface.has(namespace)) surface.set(namespace, new Map());
    return surface.get(namespace);
  };
  for (const { file, code } of files) {
    for (const match of code.matchAll(/^type (\w+)Namespace\b/gm)) {
      if (!/^type \w+Namespace struct\s*\{/.test(code.slice(match.index))) fail(`${file}: \`type ${match[1]}Namespace\` is no struct: a namespace is \`type <Name>Namespace struct\``);
      placed(file, match[1]);
    }
  }
  for (const { file, code } of files) {
    for (const match of code.matchAll(/^func \(\s*(?:\w+\s+)?\*?(\w+)Namespace\s*\)\s*(\w+)\s*\(/gm)) {
      const methods = placed(file, match[1]);
      if (!/^[A-Z]/.test(match[2])) continue;
      const { results } = goSignature(code, match.index + match[0].length - 1);
      methods.set(tableName(match[2]), { shape: goShape(results), returns: results === '' ? 'nothing' : results });
    }
  }
  return surface;
}

/**
 * Go's bus, given the name it is made as: the exported methods of its struct,
 * and the package's exported functions that take it (a Go method takes no
 * type parameters, so a member generic in its channel is one of these).
 */
function goWire(made) {
  const files = goFiles();
  const declared = files.filter(({ code }) => new RegExp(`^type ${made} struct\\b`, 'm').test(code));
  if (declared.length === 0) return undefined;
  if (declared.length > 1) fail(`${declared.map(({ file }) => file).join(', ')}: \`type ${made} struct\` is declared ${declared.length} times, and this reads the one`);
  const members = new Set();
  for (const { code } of files) {
    for (const method of code.matchAll(new RegExp(`^func \\(\\s*(?:\\w+\\s+)?\\*?${made}\\s*\\)\\s*([A-Z]\\w*)\\s*\\(`, 'gm'))) members.add(tableName(method[1]));
    for (const fn of code.matchAll(/^func ([A-Z]\w*)\s*(\[|\()/gm)) {
      const open = fn[2] === '[' ? goClosing(code, fn.index + fn[0].length - 1) : fn.index + fn[0].length - 1;
      if (code[open] !== '(') throw new Error(`func ${fn[1]}: a parameter list was expected after its type parameters`);
      const { parameters } = goSignature(code, open);
      if (goSplit(parameters).some((parameter) => new RegExp(`(?:^|\\s)\\*${made}$`).test(parameter))) members.add(tableName(fn[1]));
    }
  }
  return { where: `${made} in ${declared[0].file}`, members };
}

/**
 * Go's interface of the root package, given its name: its exported methods,
 * each as the table spells it. A line of it that is no method, an interface
 * it embeds among them, is a failure: this reads none.
 */
function goInterface(made) {
  const found = goFiles().flatMap(({ file, code }) => [...code.matchAll(new RegExp(`^type ${made} interface\\s*\\{`, 'gm'))].map((header) => ({ file, code, header })));
  if (found.length === 0) return undefined;
  if (found.length > 1) fail(`${found.map(({ file }) => file).join(', ')}: \`type ${made} interface\` is declared ${found.length} times, and this reads the one`);
  const [{ file, code, header }] = found;
  const open = header.index + header[0].length - 1;
  const members = new Set();
  for (const line of outsideBrackets(code.slice(open + 1, goClosing(code, open) - 1)).split(/[\n;]/).map(squeezed).filter((text) => text !== '')) {
    const method = /^([A-Za-z_]\w*)\s*\(/.exec(line);
    if (!method) {
      fail(`${file}: \`type ${made} interface\` has a line that is no method: ${line}`);
      continue;
    }
    if (/^[A-Z]/.test(method[1])) members.add(tableName(method[1]));
  }
  return { where: `interface ${made} in ${file}`, members };
}

/** `text` with what is inside each bracket left out, the outermost brackets kept: `Get(key string) (string, bool)` is `Get() ()`. */
function outsideBrackets(text) {
  let out = '';
  let depth = 0;
  for (const c of text) {
    if ('([{'.includes(c)) {
      if (depth === 0) out += c;
      depth++;
    } else if (')]}'.includes(c)) {
      depth--;
      if (depth === 0) out += c;
    } else if (depth === 0) out += c;
  }
  return out;
}

// ── Kotlin ──────────────────────────────────────────────────────────────

/**
 * Kotlin `source` with its comments gone and its strings and characters
 * emptied, a template's expressions with them: every bracket left is the
 * code's own. A block comment nests, and a raw string (`"""…"""`) has no
 * escapes.
 */
function kotlinCode(source) {
  let out = '';
  let i = 0;
  // What is open, innermost last: a string ('"' or '"""'), or a brace of a template's expression.
  const open = [];
  while (i < source.length) {
    const top = open[open.length - 1];
    if (top === '"' || top === '"""') {
      if (source.startsWith('${', i)) {
        open.push('{');
        i += 2;
      } else if (top === '"' && source[i] === '\\') {
        i += 2;
      } else if (top === '"""' && source.startsWith('"""', i)) {
        // A raw string ends at the last three of a run of quotes.
        while (source[i + 3] === '"') i++;
        open.pop();
        i += 3;
        if (open.length === 0) out += '""';
      } else if (top === '"' && source[i] === '"') {
        open.pop();
        i++;
        if (open.length === 0) out += '""';
      } else {
        i++;
      }
      continue;
    }
    if (source.startsWith('//', i)) {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (source.startsWith('/*', i)) {
      let depth = 0;
      do {
        if (source.startsWith('/*', i)) (depth++, (i += 2));
        else if (source.startsWith('*/', i)) (depth--, (i += 2));
        else i++;
      } while (depth > 0 && i < source.length);
      if (open.length === 0) out += ' ';
      continue;
    }
    if (source.startsWith('"""', i)) {
      open.push('"""');
      i += 3;
      continue;
    }
    if (source[i] === '"') {
      open.push('"');
      i++;
      continue;
    }
    if (source[i] === "'") {
      // A character: one, or an escape of one or more.
      i += source[i + 1] === '\\' ? 3 : 2;
      while (i < source.length && source[i] !== "'") i++;
      i++;
      if (open.length === 0) out += "''";
      continue;
    }
    if (top === '{') {
      if (source[i] === '{') open.push('{');
      else if (source[i] === '}') open.pop();
      i++;
      continue;
    }
    out += source[i++];
  }
  return out;
}

/** The index of the first of `stops` in `text` from `from`, outside every bracket; the text's length when there is none. `->` is no bracket. */
function kotlinUntil(text, from, stops) {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '-' && text[i + 1] === '>') {
      i++;
      continue;
    }
    if (depth === 0 && stops.includes(c)) return i;
    if ('(<[{'.includes(c)) depth++;
    else if (')>]}'.includes(c)) depth--;
  }
  return text.length;
}

const KOTLIN_MODIFIERS = '(?:(?:suspend|override|inline|operator|infix|data|sealed|abstract|open|final|enum|value|annotation|const|lateinit|external|tailrec|inner|companion)\\s+)*';
const KOTLIN_DECLARATION = new RegExp(`\\bpublic\\s+(${KOTLIN_MODIFIERS})(fun\\s+interface|fun|val|var|class|interface|object|constructor|typealias)\\b`, 'g');

/**
 * The `public` declarations at the top of a Kotlin body (a file's, or a
 * class's between its braces), in order. Each is its keyword, its modifiers,
 * and, for a `fun`, `val` or `var`, the name it declares, what it takes, and
 * the type it states it returns or holds (`undefined` when it states none).
 * `explicitApi()` puts `public` on every public declaration, so a declaration
 * that is public is one this finds.
 */
function kotlinDeclarations(body, where, cannot) {
  const depths = [];
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    depths.push(depth);
    if (body[i] === '-' && body[i + 1] === '>') {
      depths.push(depth);
      i++;
    } else if ('({['.includes(body[i])) depth++;
    else if (')}]'.includes(body[i])) depth--;
  }
  const declarations = [];
  for (const match of body.matchAll(KOTLIN_DECLARATION)) {
    if (depths[match.index] !== 0) continue;
    const modifiers = match[1].trim().split(/\s+/).filter(Boolean);
    const keyword = squeezed(match[2]);
    const rest = body.slice(match.index + match[0].length);
    const declaration = { keyword, modifiers, isSuspend: modifiers.includes('suspend'), isOverride: modifiers.includes('override') };
    if (keyword === 'fun') {
      let at = rest.search(/\S/);
      if (rest[at] === '<') at = closing(rest, at);
      const open = kotlinUntil(rest, at, '(');
      const head = squeezed(rest.slice(at, open));
      // An extension's receiver is no part of its name.
      const name = /`?(\w+)`?$/.exec(head)?.[1];
      if (!name || open === rest.length) {
        cannot(`${where} has a \`public fun\` this lint cannot read: ${squeezed(rest.slice(0, 80))}`);
        continue;
      }
      const after = closing(rest, open);
      const tail = rest.slice(after).replace(/^[ \t]*/, '');
      const returns = tail.startsWith(':') ? squeezed(tail.slice(1, kotlinUntil(tail, 1, '{=\n')).split(/\bwhere\b/)[0]) : undefined;
      declarations.push({ ...declaration, name, takes: parameters(parenthesised(rest, open)), returns });
    } else if (keyword === 'val' || keyword === 'var') {
      const stated = /^\s*`?(\w+)`?\s*(:)?/.exec(rest);
      if (!stated) {
        cannot(`${where} has a \`public ${keyword}\` this lint cannot read: ${squeezed(rest.slice(0, 80))}`);
        continue;
      }
      const from = stated.index + stated[0].length;
      const returns = stated[2] ? squeezed(rest.slice(from, kotlinUntil(rest, from, '={\n')).split(/\bby\b/)[0]) : undefined;
      declarations.push({ ...declaration, name: stated[1], takes: [], returns });
    } else {
      const named = /^\s*`?(\w+)`?/.exec(rest);
      const after = match.index + match[0].length + (named ? named.index + named[0].length : 0);
      declarations.push({ ...declaration, keyword: keyword.replace(/^fun\s+/, ''), name: named?.[1], after });
    }
  }
  return declarations;
}

/** The `.kt` files under `directory` with their code, its tests and its test doubles (`testing`) left out. */
const kotlinSources = (directory) => sources(directory, '.kt').map((file) => ({ file, code: kotlinCode(read(file)) }));

/**
 * The classes, interfaces and objects declared at the top of Kotlin files:
 * each one's name, its file, its modifiers, the types it is made from (its
 * supertypes, each by its name alone), its primary constructor's visibility
 * (`null` when it declares none) and parameters, and its body.
 */
function kotlinTypes(files) {
  const types = [];
  for (const { file, code } of files) {
    for (const declared of kotlinDeclarations(code, file, () => {})) {
      if (!['class', 'interface', 'object'].includes(declared.keyword) || !declared.name) continue;
      let i = declared.after;
      const skip = () => {
        while (/\s/.test(code[i] ?? '')) i++;
      };
      skip();
      if (code[i] === '<') i = closing(code, i);
      skip();
      const constructor = /^(?:(private|internal|protected|public)\s+)?(?:@\w+\s+)*constructor\b/.exec(code.slice(i));
      if (constructor) i += constructor[0].length;
      skip();
      let parameterList = '';
      // A constructor that states no visibility is public, as Kotlin's default is.
      let primary = constructor ? (constructor[1] ?? 'public') : null;
      if (code[i] === '(') {
        parameterList = parenthesised(code, i);
        i = closing(code, i);
        if (primary === null) primary = 'public';
      }
      skip();
      let supertypes = [];
      if (code[i] === ':') {
        const end = kotlinUntil(code, i + 1, '{\n');
        supertypes = splitOutside(code.slice(i + 1, end).split(/\bwhere\b/)[0], ',').map((type) => /^(\w+)/.exec(type)?.[1]).filter(Boolean);
        i = end;
      }
      skip();
      const body = code[i] === '{' ? braced(code, i) : '';
      types.push({ name: declared.name, keyword: declared.keyword, modifiers: declared.modifiers, file, supertypes, primary, parameterList, body });
    }
  }
  return types;
}

/**
 * `members` without Java's spelling of a `suspend` one (D2 of the Java
 * facade): `<m>Future`, returning a `CompletableFuture`, is Java's call of a
 * `suspend` member `<m>`, and every `suspend` member has one. A twin without
 * its member, or a member without its twin, fails.
 */
function withoutJavaTwins(members, where) {
  const twinned = new Set();
  for (const [name, member] of [...members]) {
    const twin = /^(\w+)Future$/.exec(name);
    if (!twin || !member.returns?.startsWith('CompletableFuture<')) continue;
    const of = members.get(twin[1]);
    if (!of) fail(`${where} has ${name}, Java's call of a suspend ${twin[1]}, and no ${twin[1]}`);
    else if (!of.isSuspend) fail(`${where} has ${name}, Java's call of a suspend ${twin[1]}, and its ${twin[1]} does not suspend`);
    else twinned.add(twin[1]);
    members.delete(name);
  }
  for (const [name, member] of members) {
    if (member.isSuspend && !twinned.has(name)) fail(`${where} has the suspend ${name} and no ${name}Future: Java cannot call a suspend function, so each has a twin that returns a CompletableFuture`);
  }
  return members;
}

/**
 * The members of one Kotlin type the SDK declares, as the table spells them:
 * the public declarations of its body and the public properties of its
 * primary constructor, with those of each type it is made from that the SDK
 * declares too. A declaration that overrides one of a type the SDK does not
 * declare is that type's (`close` of `AutoCloseable`, `collect` of `Flow`),
 * and no member. How it is made (`constructor`) is no member either.
 *
 * Java's spelling of a member is no member of its own: its `<m>Future`
 * (`withoutJavaTwins`), and `asPublisher`, Java's reading of a type that is a
 * `Flow`, which every such type has.
 */
function kotlinMembers(type, types, cannot) {
  const members = new Map();
  const flows = [];
  const visit = (declared, seen) => {
    if (seen.includes(declared.name)) return;
    for (const supertype of declared.supertypes) {
      const made = types.find((other) => other.name === supertype);
      if (made) visit(made, [...seen, declared.name]);
      else if (supertype === 'Flow' || supertype === 'StateFlow' || supertype === 'SharedFlow') flows.push(declared.name);
    }
    for (const parameter of splitOutside(declared.parameterList, ',')) {
      const property = /^(?:@\w+(?:\([^)]*\))?\s+)*public\s+(?:override\s+)?(?:val|var)\s+`?(\w+)`?\s*:\s*(.+)$/s.exec(squeezed(parameter));
      if (property) members.set(property[1], { name: property[1], keyword: 'val', isSuspend: false, takes: [], returns: squeezed(splitOutside(property[2], '=')[0]) });
    }
    for (const member of kotlinDeclarations(declared.body, `${declared.file}: ${declared.keyword} ${declared.name}`, cannot)) {
      if (member.keyword === 'constructor' || member.isOverride) continue;
      if (!['fun', 'val', 'var'].includes(member.keyword)) {
        cannot(`${declared.keyword} ${declared.name} declares a public ${member.keyword} ${member.name ?? ''} inside it, which is no member this lint reads`);
        continue;
      }
      members.set(member.name, member);
    }
  };
  visit(type, []);
  const where = `${type.file}: ${type.keyword} ${type.name}`;
  withoutJavaTwins(members, where);
  const isFlow = flows.length > 0;
  if (members.has('asPublisher')) {
    if (!isFlow) fail(`${where} has asPublisher, Java's reading of a Flow, and is no Flow`);
    members.delete('asPublisher');
  } else if (isFlow) {
    fail(`${where} is a Flow and has no asPublisher: Java cannot collect a Flow, so it reads one as a java.util.concurrent.Flow.Publisher`);
  }
  return members;
}

function kotlinShape({ isSuspend, returns }) {
  if (isSuspend) return returns === 'Long?' ? 'count' : 'promise';
  if (returns === undefined || returns === 'Unit') return 'signal';
  if (returns.startsWith('Cached<')) return 'cache';
  if (returns.startsWith('Running<')) return 'stream';
  if (returns.startsWith('Delegation<')) return 'delegation';
  if (returns === 'Upload') return 'upload';
  if (returns === 'Claims') return 'claims';
  if (returns.startsWith('Typed<')) return 'events';
  return undefined;
}

/** namespace → method → { shape, returns }. An SDK with no namespaces has none. */
function kotlinSurface() {
  const surface = new Map();
  const files = kotlinSources(KOTLIN_NAMESPACES);
  const types = kotlinTypes(files);
  const cannot = (what) => fail(`${KOTLIN_NAMESPACES}: ${what}`);
  for (const type of types) {
    const named = /^(\w+)Namespace$/.exec(type.name);
    if (!named) continue;
    const namespace = named[1][0].toLowerCase() + named[1].slice(1);
    if (type.file !== `${KOTLIN_NAMESPACES}/${type.name}.kt`) fail(`${type.file} declares ${type.name}, which belongs in ${KOTLIN_NAMESPACES}/${type.name}.kt`);
    const methods = new Map();
    surface.set(namespace, methods);
    for (const [name, member] of kotlinMembers(type, types, cannot)) {
      methods.set(name, { shape: kotlinShape(member), returns: member.returns ?? 'nothing it states' });
    }
  }
  return surface;
}

function kotlinWorker() {
  const types = kotlinTypes(kotlinSources(KOTLIN_SDK));
  const { said, cannot } = unreadable(KOTLIN_SDK);
  /** A type's members, each with what it takes; none when the SDK declares no such type. */
  const declares = (name) => {
    const type = types.find((declared) => declared.name === name);
    return new Map([...(type ? kotlinMembers(type, types, cannot) : [])].map(([member, { takes }]) => [member, { takes }]));
  };
  const jobs = Object.fromEntries(
    VERBS.map((verb) => {
      const name = `Held${verb[0].toUpperCase()}${verb.slice(1)}Job`;
      return [verb, { of: `class ${name}`, members: declares(name) }];
    }),
  );
  const worker = { where: KOTLIN_SDK, claims: { of: 'class Claims', members: declares('Claims') }, jobs, either: { of: 'interface HeldJob', members: declares('HeldJob') }, spelled: (name) => name };
  return said.any ? undefined : worker;
}

/** What Kotlin makes a unit as, read as every reader of a unit reads it. */
function kotlinUnit(made, directory) {
  const types = kotlinTypes(kotlinSources(directory));
  const found = types.filter((type) => type.name === made);
  if (found.length === 0) return undefined;
  if (found.length > 1) fail(`${found.map(({ file }) => file).join(', ')}: \`${made}\` is declared ${found.length} times, and this reads the one`);
  const [type] = found;
  const members = new Set(kotlinMembers(type, types, (what) => fail(`${type.file}: ${what}`)).keys());
  return { where: `${type.keyword} ${made} in ${type.file}`, isUnit: type.supertypes.includes('StateUnit'), members };
}

/** Every unit Kotlin declares, by name, each with the file it is declared in. */
function kotlinUnits() {
  return kotlinTypes(kotlinSources(KOTLIN_SDK))
    .filter((type) => type.supertypes.includes('StateUnit'))
    .map((type) => ({ name: type.name, file: type.file }));
}

/**
 * The public names of Kotlin packages, each given by its directory: every
 * `public` declaration at the top of its files, Java's spelling of one left
 * out (`withoutJavaTwins`).
 */
function kotlinExports(directories) {
  return directories.flatMap((directory) => {
    const declared = filesIn(directory, '.kt').flatMap((name) => {
      const file = `${directory}/${name}`;
      return kotlinDeclarations(kotlinCode(read(file)), file, (what) => fail(what)).filter((d) => d.keyword !== 'constructor' && d.name);
    });
    return [...withoutJavaTwins(new Map(declared.map((d) => [d.name, d])), directory).keys()];
  });
}

// ── Each SDK against the table ──────────────────────────────────────────

/** Whether a row's `notYetReached` names `sdk`. */
const yetToReach = (row, sdk) => row?.notYetReached?.[sdk] !== undefined;

/** Hold a row's `notYetReached` to the roster of a section, and to its `absent`. */
function heldWaiting(name, row, roster, section) {
  for (const [sdk, why] of Object.entries(row.notYetReached ?? {})) {
    if (!roster.includes(sdk)) fail(`${name}: \`notYetReached\` names "${sdk}", which is no SDK whose ${section} this lint reads`);
    if (typeof why !== 'string' || why === '') fail(`${name}: \`notYetReached\` does not say what is to be built for ${sdk}`);
    if (row.absent?.[sdk] !== undefined) fail(`${name} says ${sdk} lacks it (\`absent\`) and is still to have it (\`notYetReached\`): it is one or the other`);
  }
}

function held(sdk, where, surface) {
  for (const [namespace, methods] of rows) {
    const has = surface.get(namespace);
    if (yetToReach(namespaceRows.get(namespace), sdk)) {
      if (has) fail(`${TABLE} says ${sdk} has yet to reach the ${namespace} namespace (\`notYetReached\`), and ${sdk} has it: take ${sdk} out of the namespace's \`notYetReached\`, or say which methods it still lacks on each method instead`);
      continue;
    }
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
      if (yetToReach(row, sdk)) {
        if (found) fail(`${TABLE} says ${sdk} has yet to have ${name} (\`notYetReached\`), and ${sdk} has it: take ${sdk} out of the row's \`notYetReached\``);
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

/** Each SDK whose namespaces this reads: where they are, and their reader. */
const NAMESPACES = {
  typescript: { where: TS_INTERFACES, surface: typescriptSurface },
  rust: { where: RUST_NAMESPACES, surface: rustSurface },
  python: { where: PYTHON_NAMESPACES, surface: pythonSurface },
  go: { where: GO_SDK, surface: goSurface },
  kotlin: { where: KOTLIN_NAMESPACES, surface: kotlinSurface },
};
const NAMESPACE_SDKS = Object.keys(NAMESPACES);

for (const row of [...rows.values()].flatMap((methods) => [...methods.values()])) {
  for (const sdk of Object.keys(row.absent ?? {})) {
    if (!NAMESPACE_SDKS.includes(sdk)) fail(`${TABLE}: \`absent\` names "${sdk}", which is no SDK whose namespaces this lint reads`);
  }
}
for (const [namespace, methods] of rows) {
  heldWaiting(`${TABLE}: the ${namespace} namespace`, namespaceRows.get(namespace), NAMESPACE_SDKS, 'namespaces');
  for (const [method, row] of methods) heldWaiting(`${TABLE}: ${namespace}.${method}`, row, NAMESPACE_SDKS, 'namespaces');
}

for (const [sdk, { where, surface }] of Object.entries(NAMESPACES)) held(sdk, where, surface());

// ── What a worker is handed ─────────────────────────────────────────────

/** The verbs a job is of: the spec's `JobType`. */
const VERBS = JSON.parse(read(`${SCHEMAS}/JobType.json`)).enum;

/** What this lint can read the members of, each as the table names it. */
const HANDED = ['claims', 'heldJob'];

/** Each SDK whose worker's surface this reads, and its reader. */
const WORKERS = { typescript: typescriptWorker, rust: rustWorker, python: pythonWorker, go: goWorker, kotlin: kotlinWorker };
const WORKER_SDKS = Object.keys(WORKERS);

/** handed → member → row */
const handed = new Map();
/** handed → its row */
const handedRows = new Map();
for (const thing of table.worker ?? []) {
  const what = `${TABLE}: worker.${thing.handed}`;
  if (handed.has(thing.handed)) fail(`${what} is listed twice`);
  handedRows.set(thing.handed, thing);
  heldWaiting(what, thing, WORKER_SDKS, "worker's surface");
  const members = new Map();
  handed.set(thing.handed, members);
  if (!HANDED.includes(thing.handed)) fail(`${what} is nothing this lint reads the members of: it reads ${HANDED.join(' and ')}`);
  if (typeof thing.docs !== 'string' || thing.docs === '') fail(`${what} does not say what it is (\`docs\`)`);
  if (!Array.isArray(thing.members) || thing.members.length === 0) fail(`${what} lists no members`);
  for (const row of thing.members ?? []) {
    const name = `${what}.${row.member}`;
    if (members.has(row.member)) fail(`${name} is listed twice`);
    members.set(row.member, row);
    const strays = Object.keys(row).filter((key) => !['member', 'absent', 'named', 'takes', 'notYetReached'].includes(key));
    if (strays.length > 0) fail(`${name} states ${strays.join(', ')}, which a member's row does not: what a member does is docs/protocol/WORKER-CONTRACT.md's and the worker conformance suite's to hold`);
    for (const [sdk, why] of Object.entries(row.absent ?? {})) {
      if (!WORKER_SDKS.includes(sdk)) fail(`${name}: \`absent\` names "${sdk}", which is no SDK whose worker's surface this lint reads`);
      if (typeof why !== 'string' || why === '') fail(`${name}: \`absent\` does not say why ${sdk} lacks it`);
      if (row.named?.[sdk] !== undefined) fail(`${name} says ${sdk} lacks it (\`absent\`) and has it under another name (\`named\`): it is one or the other`);
    }
    for (const [sdk, other] of Object.entries(row.named ?? {})) {
      if (!WORKER_SDKS.includes(sdk)) fail(`${name}: \`named\` names "${sdk}", which is no SDK whose worker's surface this lint reads`);
      if (typeof other?.name !== 'string' || other.name === '' || other.name === row.member) fail(`${name}: \`named\` gives ${sdk} no name of its own for it`);
      if (typeof other?.why !== 'string' || other.why === '') fail(`${name}: \`named\` does not say why ${sdk} names it otherwise`);
    }
    heldWaiting(name, row, WORKER_SDKS, "worker's surface");
    if (WORKER_SDKS.every((sdk) => row.absent?.[sdk] !== undefined)) fail(`${name} is absent from every SDK: it is no member`);
    if (row.takes !== undefined) {
      if (thing.handed !== 'heldJob') fail(`${name} states \`takes\`, which only a held job's member does: a held job is its verb's`);
      const stated = Object.keys(row.takes);
      if (stated.length !== VERBS.length || !VERBS.every((verb) => stated.includes(verb))) fail(`${name}: \`takes\` states ${stated.join(', ')}, and a job's verbs are ${VERBS.join(', ')}`);
      for (const schema of Object.values(row.takes)) {
        if (!REPOSITORY.includes(`${SCHEMAS}/${schema}.json`)) fail(`${name} takes ${schema}, which is no schema of ${SCHEMAS}`);
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
 * either verb, that type's. Each with where it was read, for a message, and
 * how a name its SDK spells is spelled as the table spells it (`spelled`), for
 * a row's `named`, which gives the name as the SDK spells it. One that meets a
 * declaration it cannot read says so and answers nothing: no SDK is held to a
 * reading that guessed.
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
  return {
    where: TS_CLAIMS,
    claims: { of: 'class ClaimsObservable', members: claims },
    jobs: Object.fromEntries(VERBS.map((verb) => [verb, { of: `Held<'${verb}', …>`, members: jobs[verb] }])),
    either: undefined,
    spelled: (name) => name,
  };
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
  const worker = { where: RUST_CLAIMS, claims: { of: 'Claims', members: implemented(' Claims') }, jobs, either: { of: 'HeldJob', members: implemented(' HeldJob') }, spelled: camel };
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
  const worker = { where: PYTHON_CLAIMS, claims: { of: 'class Claims', members: declares('Claims') }, jobs, either: undefined, spelled: camel };
  return said.any ? undefined : worker;
}

function goWorker() {
  const files = goFiles();
  const { said, cannot } = unreadable(GO_CLAIMS);

  /** The one file that declares `type <name> <kind>`, and the declaration's body. */
  const declaration = (name, kind) => {
    const found = files.flatMap(({ file, code }) => [...code.matchAll(new RegExp(`^type ${name} ${kind}\\s*\\{`, 'gm'))].map((header) => ({ file, code, header })));
    if (found.length !== 1) {
      cannot(`\`type ${name} ${kind}\` is declared ${found.length} times, and this reads the one`);
      return undefined;
    }
    const [{ code, header }] = found;
    const open = header.index + header[0].length - 1;
    return code.slice(open + 1, goClosing(code, open) - 1);
  };

  /** What a member takes: its parameters' types, its context left out and a type of the spec named as the spec names it. */
  const takes = (list) => goTypes(list).filter((type) => type !== 'context.Context').map((type) => ({ name: '', type: type.replace(/^api\./, '') }));

  /** The exported members of a struct: its exported fields and methods, with those of each struct it embeds, each as the table spells it. */
  const struct = (name) => {
    const members = new Map();
    const body = declaration(name, 'struct');
    if (body === undefined) return members;
    for (const line of body.split('\n').map(squeezed).filter((text) => text !== '')) {
      const embedded = /^\*?([A-Za-z_]\w*)$/.exec(line);
      if (embedded) {
        for (const [member, declared] of struct(embedded[1])) members.set(member, declared);
        continue;
      }
      const field = /^([A-Z]\w*)\s+\S/.exec(line);
      if (field) members.set(tableName(field[1]), { takes: [] });
    }
    for (const { code } of files) {
      for (const method of code.matchAll(new RegExp(`^func \\(\\s*(?:\\w+\\s+)?\\*?${name}\\s*\\)\\s*([A-Z]\\w*)\\s*\\(`, 'gm'))) {
        const { parameters } = goSignature(code, method.index + method[0].length - 1);
        members.set(tableName(method[1]), { takes: takes(parameters) });
      }
    }
    return members;
  };

  /** The exported methods of an interface, each as the table spells it. */
  const methods = (name) => {
    const members = new Map();
    const body = declaration(name, 'interface');
    if (body === undefined) return members;
    for (const line of body.split('\n').map(squeezed).filter((text) => text !== '')) {
      const method = /^([A-Za-z_]\w*)\s*\(/.exec(line);
      if (!method) {
        cannot(`\`type ${name} interface\` has a line that declares no method: ${line}`);
        continue;
      }
      if (!/^[A-Z]/.test(method[1])) continue;
      const open = line.indexOf('(');
      members.set(tableName(method[1]), { takes: takes(line.slice(open + 1, goClosing(line, open) - 1)) });
    }
    return members;
  };

  const jobs = Object.fromEntries(
    VERBS.map((verb) => {
      const name = `Held${verb[0].toUpperCase()}${verb.slice(1)}Job`;
      return [verb, { of: `type ${name}`, members: struct(name) }];
    }),
  );
  const worker = {
    where: GO_SDK,
    claims: { of: 'type Claims', members: struct('Claims') },
    jobs,
    either: { of: 'type HeldJob', members: methods('HeldJob') },
    spelled: tableName,
  };
  return said.any ? undefined : worker;
}

/** Hold what `sdk` declares for one thing a worker is handed to the table's rows for it. `verb` is given for a held job of one verb. */
function heldTo(sdk, where, what, declared, members, verb, spelled) {
  const its = `${sdk}'s ${what} (${declared.of} in ${where})`;
  const row = `the \`${what}\` rows of \`worker\` in ${TABLE}`;
  const has = declared.members;
  if (yetToReach(handedRows.get(what), sdk)) {
    if (has.size > 0) fail(`${its} has ${[...has.keys()].join(', ')}, and ${TABLE} says ${sdk} has yet to reach worker.${what} (\`notYetReached\`): take ${sdk} out of its \`notYetReached\`, or say which members it still lacks on each member instead`);
    return;
  }
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
    if (yetToReach(stated, sdk)) {
      if (has.has(member)) fail(`${its} has ${member}, and ${row} say ${sdk} has yet to have it (\`notYetReached\`): take ${sdk} out of the row's \`notYetReached\``);
      continue;
    }
    if (named !== undefined) {
      if (!has.has(spelled(named.name))) fail(`${its} has no ${named.name}, the name ${row} say ${sdk} has ${member} under: add it to the SDK, or correct the row's \`named\``);
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
  const listed = new Set([...members].flatMap(([member, stated]) => [member, ...(stated.named?.[sdk] ? [spelled(stated.named[sdk].name)] : [])]));
  for (const member of has.keys()) {
    if (!listed.has(member)) fail(`${its} has ${member}, which ${row} do not list: add a row for it there before any SDK has it, with an \`absent\` for each SDK that is not to`);
  }
}

for (const [sdk, readWorker] of Object.entries(WORKERS)) {
  const worker = readWorker();
  if (!worker) continue;
  // A name the table gives an SDK (`named`) is as that SDK spells it; its reader says how that is spelled as the table spells a name.
  const { spelled } = worker;
  if (handed.has('claims')) heldTo(sdk, worker.where, 'claims', worker.claims, handed.get('claims'), undefined, spelled);
  if (handed.has('heldJob')) {
    for (const verb of VERBS) heldTo(sdk, worker.where, 'heldJob', worker.jobs[verb], handed.get('heldJob'), verb, spelled);
    if (worker.either) heldTo(sdk, worker.where, 'heldJob', worker.either, handed.get('heldJob'), undefined, spelled);
  }
}

// ── The state units ─────────────────────────────────────────────────────

/**
 * Each SDK whose state units this reads: its reader of one unit, where its
 * units are declared, its reader of every unit it declares, what it names a
 * unit's `dispose`, which every unit has, being a StateUnit, and is no
 * member, and its reader of how a unit is made from outside it (`makeable`).
 */
const UNITS = {
  typescript: { read: typescriptUnit, sources: TS_SDK, declared: typescriptUnits, dispose: 'dispose', makeable: typescriptMakeable },
  rust: { read: rustUnit, sources: RUST_SDK, declared: rustUnits, dispose: 'dispose', makeable: rustMakeable },
  python: { read: pythonUnit, sources: PYTHON_SDK, declared: pythonUnits, dispose: 'dispose', makeable: pythonMakeable },
  go: { read: goUnit, sources: GO_SDK, declared: goUnits, dispose: 'close', makeable: goMakeable },
  kotlin: { read: kotlinUnit, sources: KOTLIN_SDK, declared: kotlinUnits, dispose: 'close', makeable: kotlinMakeable },
};
const UNIT_SDKS = Object.keys(UNITS);

/** unit → its row, with member → row */
const units = new Map();
if (!Array.isArray(table.stateUnits) || table.stateUnits.length === 0) fail(`${TABLE}: \`stateUnits\` lists no state unit`);
for (const unit of table.stateUnits ?? []) {
  const what = `${TABLE}: stateUnits.${unit.unit}`;
  if (units.has(unit.unit)) fail(`${what} is listed twice`);
  const members = new Map();
  units.set(unit.unit, { ...unit, members });
  const strays = Object.keys(unit).filter((key) => !['unit', 'docs', 'made', 'madeBy', 'members', 'absent', 'notYetReached'].includes(key));
  if (strays.length > 0) fail(`${what} states ${strays.join(', ')}, which a unit's row does not: what a unit does is its SDKs' tests' to hold`);
  if (typeof unit.docs !== 'string' || unit.docs === '') fail(`${what} does not say what it is (\`docs\`)`);
  heldWaiting(what, unit, UNIT_SDKS, 'state units');
  for (const sdk of UNIT_SDKS) {
    if (yetToReach(unit, sdk) && unit.made?.[sdk] === undefined) continue;
    if (typeof unit.made?.[sdk] !== 'string' || !/^\w+$/.test(unit.made[sdk])) fail(`${what} does not say what ${sdk} makes it as (\`made\`)`);
  }
  for (const sdk of Object.keys(unit.made ?? {})) {
    if (!UNIT_SDKS.includes(sdk)) fail(`${what}: \`made\` names "${sdk}", which is no SDK whose state units this lint reads`);
  }
  for (const [sdk, maker] of Object.entries(unit.madeBy ?? {})) {
    if (!UNIT_SDKS.includes(sdk)) fail(`${what}: \`madeBy\` names "${sdk}", which is no SDK whose state units this lint reads`);
    if (typeof maker !== 'string' || !/^\w+$/.test(maker)) fail(`${what}: \`madeBy\` does not name what makes it in ${sdk}`);
    if (unit.absent?.[sdk] !== undefined) fail(`${what}: \`madeBy\` names ${sdk}, which has no ${unit.unit} unit at all`);
  }
  for (const [sdk, why] of Object.entries(unit.absent ?? {})) {
    if (!UNIT_SDKS.includes(sdk)) fail(`${what}: \`absent\` names "${sdk}", which is no SDK whose state units this lint reads`);
    if (typeof why !== 'string' || why === '') fail(`${what}: \`absent\` does not say why ${sdk} lacks it`);
  }
  if (UNIT_SDKS.every((sdk) => unit.absent?.[sdk] !== undefined)) fail(`${what} is absent from every SDK: it is no unit`);
  if (!Array.isArray(unit.members)) fail(`${what} does not list its members: a unit with none lists none`);
  for (const row of unit.members ?? []) {
    const name = `${what}.${row.member}`;
    if (members.has(row.member)) fail(`${name} is listed twice`);
    members.set(row.member, row);
    const others = Object.keys(row).filter((key) => !['member', 'absent', 'notYetReached'].includes(key));
    if (others.length > 0) fail(`${name} states ${others.join(', ')}, and a unit's member is its name, with an \`absent\` for each SDK that has none`);
    heldWaiting(name, row, UNIT_SDKS, 'state units');
    if (row.member === 'dispose') fail(`${name}: \`dispose\` is every unit's, being a StateUnit, and is listed for none`);
    for (const [sdk, why] of Object.entries(row.absent ?? {})) {
      if (!UNIT_SDKS.includes(sdk)) fail(`${name}: \`absent\` names "${sdk}", which is no SDK whose state units this lint reads`);
      if (typeof why !== 'string' || why === '') fail(`${name}: \`absent\` does not say why ${sdk} lacks it`);
      if (unit.absent?.[sdk] !== undefined) fail(`${name}: \`absent\` names ${sdk}, which has no ${unit.unit} unit at all`);
    }
    if (UNIT_SDKS.every((sdk) => row.absent?.[sdk] !== undefined)) fail(`${name} is absent from every SDK: it is no member`);
  }
}

/** The files under `directory` whose names end in `extension`, its tests and its test doubles (`testing`) left out. */
function sources(directory, extension) {
  return REPOSITORY.filter((path) => {
    if (!path.startsWith(`${directory}/`)) return false;
    const [name, ...folders] = path.slice(directory.length + 1).split('/').reverse();
    if (folders.includes('__tests__') || folders.includes('testing')) return false;
    return name.endsWith(extension) && name !== `testing${extension}` && !name.endsWith(`.test${extension}`);
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
  // Whether `new` makes it from outside: a class, unless its constructor is private or protected.
  let constructible = kind === 'class';
  if (kind === 'interface') {
    for (const member of splitOutside(body, ';')) {
      const text = squeezed(member);
      const named = /^(?:readonly\s+)?(\w+?)\$?\??\s*[(:]/.exec(text);
      if (!named) {
        fail(`${file}: \`interface ${made}\` has a member that is neither a property nor a method: ${text}`);
        continue;
      }
      members.add(named[1]);
    }
  } else {
    for (const declaration of classDeclarations(body)) {
      if (/^(?:private|protected)\s+constructor\b/.test(declaration)) constructible = false;
      // How it is made is no member, nor what is its own.
      if (/^(?:constructor|static)\b/.test(declaration) || isPrivate(declaration)) continue;
      const named = declaredName(declaration);
      if (!named || /^(?:set|declare|abstract)\b/.test(declaration)) {
        fail(`${file}: \`class ${made}\` has a declaration that is neither a property nor a method of its own: ${declaration}`);
        continue;
      }
      members.add(named);
    }
  }
  const stated = splitOutside(header[1] ?? '', ',').map(squeezed);
  return { where: `${kind} ${made} in ${file}`, isUnit: stated.includes('StateUnit'), members, constructible };
}

function rustUnit(made, directory) {
  const files = sources(directory, '.rs').map((file) => ({ file, source: withoutComments(read(file), '"') }));
  const struct = new RegExp(`^pub struct ${made}\\b`, 'm');
  const declared = files.filter(({ source }) => struct.test(source));
  if (declared.length === 0) return undefined;
  if (declared.length > 1) fail(`${declared.map(({ file }) => file).join(', ')}: \`pub struct ${made}\` is declared ${declared.length} times, and this reads the one`);
  const [{ file, source }] = declared;
  const members = new Set();
  /** The `pub fn`s of its own `impl`s that take no unit: how it is made, each as Rust spells it. */
  const makers = new Set();
  // An `impl`'s header, with its generics and any `where` clause, up to the brace that opens its body.
  const header = (of) => new RegExp(`^impl(?:<[^>{]*>)? ${of}(?:<[^>{]*>)?(?:\\s+where\\b[^{]*)?\\s*\\{`, 'gm');
  for (const impl of source.matchAll(header(made))) {
    const body = braced(source, impl.index + impl[0].length - 1);
    for (const fn of body.matchAll(/\bpub (?:async )?fn (\w+)/g)) {
      // A member takes the unit; a function that takes none is how it is made (`new`, `persisted`).
      const taken = parenthesised(body, body.indexOf('(', fn.index + fn[0].length));
      if (/^\s*(?:&\s*(?:'\w+\s+)?)?(?:mut\s+)?self\b/.test(taken)) members.add(camel(fn[1]));
      else makers.add(fn[1]);
    }
  }
  const isUnit = header(`StateUnit for ${made}`).test(source);
  return { where: `${made} in ${file}`, isUnit, members, makers };
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
    if (!name.startsWith('_')) members.add(camel(name));
  }
  const bases = splitOutside(header[1] ?? '', ',').map(squeezed);
  return { where: `class ${made} in ${file}`, isUnit: bases.includes('StateUnit'), members };
}

/**
 * The Go SDK's files a unit can be declared in, each with its code: every
 * `.go` file under packages/go/sdk, its tests (`_test.go`), its test double (a
 * package whose name ends in `test`) and its conformance drivers left out.
 */
function goSources() {
  return REPOSITORY.filter((path) => {
    if (!path.startsWith(`${GO_SDK}/`) || !path.endsWith('.go') || path.endsWith('_test.go')) return false;
    const folders = path.slice(GO_SDK.length + 1).split('/').slice(0, -1);
    return !folders.some((folder) => folder === 'conformance' || folder.endsWith('test'));
  }).map((file) => ({ file, code: goCode(read(file)) }));
}

/** A Go unit's declaration that it is one, standing alone or in a `var` block, its type captured. */
const goUnitAssertion = /^\s*(?:var\s+)?_\s+(?:semiont\.)?StateUnit\s*=\s*\(\*(\w+)(?:\[[^\]\n]*\])?\)\(nil\)/gm;

/** A Go struct's header, with its type parameters if it has any. */
const goStructHeader = (name) => new RegExp(`^type ${name}(?:\\[[^\\]\\n]*\\])?\\s+struct\\s*\\{`, 'gm');

/**
 * The members of `type <name> struct`, declared once among files: its
 * exported fields and methods, and those of each struct it embeds, each as
 * the table spells it.
 */
function goStructMembers(name, files) {
  const members = new Set();
  const found = files.flatMap(({ file, code }) => [...code.matchAll(goStructHeader(name))].map((header) => ({ file, code, header })));
  if (found.length !== 1) {
    fail(`${GO_SDK}: \`type ${name} struct\` is declared ${found.length} times, and this reads the one`);
    return members;
  }
  const [{ file, code, header }] = found;
  const open = header.index + header[0].length - 1;
  for (const line of code.slice(open + 1, goClosing(code, open) - 1).split('\n').map(squeezed).filter((text) => text !== '')) {
    const embedded = /^\*?([A-Za-z_]\w*)(?:\[[^\]]*\])?$/.exec(line);
    if (embedded) {
      for (const member of goStructMembers(embedded[1], files)) members.add(member);
      continue;
    }
    const field = /^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+\S/.exec(line);
    if (!field) {
      fail(`${file}: \`type ${name} struct\` has a line that is neither a field nor a struct it embeds: ${line}`);
      continue;
    }
    for (const named of field[1].split(',').map((text) => text.trim())) {
      if (/^[A-Z]/.test(named)) members.add(tableName(named));
    }
  }
  const method = new RegExp(`^func \\(\\s*(?:\\w+\\s+)?\\*?${name}(?:\\[[^\\]\\n]*\\])?\\s*\\)\\s*([A-Z]\\w*)\\s*[[(]`, 'gm');
  for (const { code: other } of files) {
    for (const declared of other.matchAll(method)) {
      members.add(tableName(declared[1]));
    }
  }
  return members;
}

function goUnit(made) {
  const files = goSources();
  const found = files.filter(({ code }) => goStructHeader(made).test(code));
  if (found.length === 0) return undefined;
  const isUnit = files.some(({ code }) => [...code.matchAll(goUnitAssertion)].some((said) => said[1] === made));
  return { where: `type ${made} in ${found.map(({ file }) => file).join(', ')}`, isUnit, members: goStructMembers(made, files) };
}

/** Every unit Go declares, by name, each with the file it is declared in. */
function goUnits() {
  return goSources().flatMap(({ file, code }) => [...code.matchAll(goUnitAssertion)].map((said) => ({ name: said[1], file })));
}

/** Whether a list of bases or interfaces names `StateUnit`. */
const extendsStateUnit = (list) => splitOutside(list ?? '', ',').map(squeezed).includes('StateUnit');

/** Every unit TypeScript declares, by name, each with the file it is declared in. */
function typescriptUnits() {
  return sources(TS_SDK, '.ts').flatMap((file) => {
    const source = typescriptCode(read(file));
    return [...source.matchAll(interfaceHeader('(\\w+)')), ...source.matchAll(classHeader('(\\w+)'))]
      .filter((header) => extendsStateUnit(header[2]))
      .map((header) => ({ name: header[1], file }));
  });
}

/** Every unit Rust declares, by name, each with the file it is declared in. */
function rustUnits() {
  return sources(RUST_SDK, '.rs').flatMap((file) =>
    [...withoutComments(read(file), '"').matchAll(/^impl(?:<[^>{]*>)? StateUnit for (\w+)/gm)].map((impl) => ({ name: impl[1], file })),
  );
}

/** Every unit Python declares, by name, each with the file it is declared in. */
function pythonUnits() {
  return sources(PYTHON_SDK, '.py').flatMap((file) =>
    [...withoutPythonComments(read(file)).matchAll(/^class (\w+)(?:\[[^\]]*\])?\(([^)]*)\):/gm)]
      .filter((header) => extendsStateUnit(header[2]))
      .map((header) => ({ name: header[1], file })),
  );
}

// ── How a unit is made ──────────────────────────────────────────────────

/**
 * Each SDK's reader of how it makes a unit from outside it, given the name it
 * makes the unit as, what its reader of a unit read of it, and the maker the
 * row's `madeBy` names for it (`undefined` when it names none): what is wrong,
 * or `undefined` when nothing is. With no maker named, the type's own
 * constructor makes it, and is public; a named maker is a function the SDK
 * has, and has publicly. Public is reachable from outside the SDK: what
 * TypeScript's packages/typescript/sdk/src/index.ts exports, an item of a
 * module Rust's crate root reaches, a name a Python module lists in its
 * `__all__`, in a module whose path has no private part, what Kotlin declares
 * `public`, and what Go exports from a package that is not internal.
 */

const TS_ENTRY = `${TS_SDK}/index.ts`;

/** The file of the SDK a relative import of `file` names; `undefined` for another package's. */
function typescriptModule(file, specifier) {
  if (!specifier.startsWith('.')) return undefined;
  const base = join(dirname(file), specifier);
  const found = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((candidate) => REPOSITORY.includes(candidate));
  if (!found) fail(`${file}: \`${specifier}\` names no file of the SDK this lint can find`);
  return found;
}

/** The names TypeScript's entry exports: its own, and each `export *` and `export { … }` of the SDK's files it reaches, followed. */
function typescriptEntryNames() {
  const names = new Set();
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = withoutComments(read(file), `'"\``);
    for (const star of source.matchAll(/^export (?:type )?\*(?: as (\w+))? from (['"])([^'"]+)\2/gm)) {
      if (star[1]) names.add(star[1]);
      else {
        const target = typescriptModule(file, star[3]);
        if (target) visit(target);
      }
    }
    for (const list of source.matchAll(/^export (?:type )?\{([^}]*)\}/gm)) {
      for (const item of list[1].split(',').map(squeezed).filter((text) => text !== '')) names.add(/(\w+)$/.exec(item)[1]);
    }
    for (const declared of source.matchAll(/^export (?:declare )?(?:async )?(?:abstract )?(?:function\*?|const|let|class|interface|type|enum) (\w+)/gm)) names.add(declared[1]);
  };
  visit(TS_ENTRY);
  return names;
}
const TS_ENTRY_NAMES = typescriptEntryNames();

function typescriptMakeable(made, declared, maker) {
  if (maker !== undefined) {
    if (TS_ENTRY_NAMES.has(maker)) return undefined;
    const has = sources(TS_SDK, '.ts').some((file) => new RegExp(`\\b(?:function\\*?|const|let)\\s+${maker}\\b`).test(typescriptCode(read(file))));
    return has ? `which ${TS_ENTRY} does not export` : 'which TypeScript does not declare';
  }
  if (!declared.constructible) return `${declared.where} has no constructor that is public: make it public, or name in the row's \`madeBy\` the function that makes it`;
  if (!TS_ENTRY_NAMES.has(made)) return `${TS_ENTRY} does not export ${made}: export it there`;
  return undefined;
}

/**
 * The names Rust's crate makes public: each item declared `pub` at the top of
 * a module its root, packages/rust/sdk/src/lib.rs, reaches through `pub mod`,
 * and each name such a module re-exports with `pub use`.
 */
function rustCrateNames() {
  const names = new Set();
  const visit = (file) => {
    const source = withoutComments(read(file), '"');
    for (const item of source.matchAll(/^pub (?:async )?(?:fn|struct|enum|trait|const|type|static) (\w+)/gm)) names.add(item[1]);
    for (const used of source.matchAll(/^pub use ([^;]+);/gm)) {
      // Each leaf of the tree, by the name it is used under: `a::{B, c::D as E}` is B and E.
      for (const leaf of used[1].replace(/[{}]/g, ',').split(',').map(squeezed)) {
        const name = /(\w+)$/.exec(leaf)?.[1];
        if (name && name !== 'self') names.add(name);
        if (leaf.endsWith('*')) fail(`${file} re-exports \`${leaf}\` whole, which this lint does not read`);
      }
    }
    const directory = /(?:^|\/)(?:lib|mod)\.rs$/.test(file) ? dirname(file) : file.slice(0, -'.rs'.length);
    for (const child of source.matchAll(/^pub mod (\w+);/gm)) {
      const target = [`${directory}/${child[1]}.rs`, `${directory}/${child[1]}/mod.rs`].find((candidate) => REPOSITORY.includes(candidate));
      if (target) visit(target);
      else fail(`${file}: \`pub mod ${child[1]}\` names no file this lint can find`);
    }
  };
  visit(`${RUST_SDK}/lib.rs`);
  return names;
}
const RUST_CRATE_NAMES = rustCrateNames();

function rustMakeable(made, declared, maker) {
  const reached = RUST_CRATE_NAMES.has(made);
  if (maker === undefined) {
    if (!declared.makers.has('new')) return `${declared.where} has no \`pub fn new\` in its own \`impl\`: give it one, or name in the row's \`madeBy\` the function that makes it`;
    return reached ? undefined : `${made} is not reached from ${RUST_SDK}/lib.rs: make it public there`;
  }
  if (declared.makers.has(maker)) return reached ? undefined : `which is ${made}'s, and ${made} is not reached from ${RUST_SDK}/lib.rs`;
  if (RUST_CRATE_NAMES.has(maker)) return undefined;
  const has = sources(RUST_SDK, '.rs').some((file) => new RegExp(`\\bfn ${maker}\\b`).test(withoutComments(read(file), '"')));
  return has ? `which is not reached from ${RUST_SDK}/lib.rs` : 'which Rust does not declare';
}

/** Why `file`, a module of Python's, and a name in it are not public; `undefined` when they are. */
function pythonPrivate(file, name) {
  const parts = file.slice(PYTHON_SDK.length + 1).split('/');
  const module = parts.pop();
  if ([...parts, module === '__init__.py' ? '' : module].some((part) => part.startsWith('_'))) return `${file} is a private module`;
  if (name.startsWith('_')) return `${name} is private`;
  if (!pythonExports([file]).includes(name)) return `the \`__all__\` of ${file} does not list ${name}`;
  return undefined;
}

function pythonMakeable(made, declared, maker) {
  const declaring = (pattern) => sources(PYTHON_SDK, '.py').filter((file) => pattern.test(withoutPythonComments(read(file))));
  if (maker === undefined) {
    const [file] = declaring(new RegExp(`^class ${made}\\b`, 'm'));
    const wrong = pythonPrivate(file, made);
    return wrong === undefined ? undefined : `${wrong}: make it public, or name in the row's \`madeBy\` the function that makes it`;
  }
  const files = declaring(new RegExp(`^(?:async )?def ${maker}\\b`, 'm'));
  if (files.length === 0) return 'which Python does not declare';
  const wrong = files.map((file) => pythonPrivate(file, maker));
  return wrong.includes(undefined) ? undefined : `which is not public: ${wrong.join('; ')}`;
}

function kotlinMakeable(made, declared, maker) {
  const files = kotlinSources(KOTLIN_SDK);
  if (maker !== undefined) {
    if (files.some(({ file, code }) => kotlinDeclarations(code, file, () => {}).some((top) => top.keyword === 'fun' && top.name === maker))) return undefined;
    const has = files.some(({ code }) => new RegExp(`\\bfun\\s+(?:<[^>]*>\\s*)?(?:[\\w.<>]+\\.)?${maker}\\s*\\(`).test(code));
    return has ? 'which is not public' : 'which Kotlin does not declare';
  }
  const type = kotlinTypes(files).find((found) => found.name === made);
  const remedy = `make it public, or name in the row's \`madeBy\` the function that makes it`;
  if (type.keyword !== 'class') return `${declared.where} is an ${type.keyword}, which no constructor makes: name in the row's \`madeBy\` the function that makes it`;
  if (type.modifiers.includes('abstract') || type.modifiers.includes('sealed')) return `${declared.where} is ${type.modifiers.includes('abstract') ? 'abstract' : 'sealed'}: name in the row's \`madeBy\` the function that makes it`;
  const secondary = kotlinDeclarations(type.body, type.file, () => {}).some((inside) => inside.keyword === 'constructor');
  if (type.primary === 'public' || secondary) return undefined;
  // With no constructor declared, the class has one of its own, which is public.
  if (type.primary === null && !/\bconstructor\s*\(/.test(type.body)) return undefined;
  return `${declared.where} has no constructor that is public: ${remedy}`;
}

function goMakeable(made, declared, maker) {
  if (maker === undefined) return `Go has no constructors, so ${declared.where} is made by a function of its package: name it in the row's \`madeBy\``;
  if (!/^[A-Z]/.test(maker)) return 'which Go does not export: its name begins with a small letter';
  const files = goSources().filter(({ code }) => new RegExp(`^func ${maker}\\s*[[(]`, 'm').test(code));
  if (files.length === 0) return 'which Go does not declare';
  if (files.every(({ file }) => file.split('/').includes('internal'))) return `which is in an internal package (${files.map(({ file }) => file).join(', ')})`;
  return undefined;
}

for (const [sdk, { declared }] of Object.entries(UNITS)) {
  const listed = new Set([...units.values()].map((unit) => unit.made?.[sdk]));
  for (const { name, file } of declared()) {
    if (!listed.has(name)) fail(`${file}: ${sdk}'s ${name} is a StateUnit that no row of \`stateUnits\` in ${TABLE} makes: add a row for it there before any SDK has it, with an \`absent\` for each SDK that is not to`);
  }
}

for (const [name, unit] of units) {
  const row = `the \`${name}\` row of \`stateUnits\` in ${TABLE}`;
  for (const [sdk, { read: readUnit, sources: where, dispose, makeable }] of Object.entries(UNITS)) {
    const made = unit.made?.[sdk];
    if (typeof made !== 'string') continue;
    const declared = readUnit(made, where);
    declared?.members.delete(dispose);
    if (unit.absent?.[sdk] !== undefined) {
      if (declared) fail(`${sdk} has ${declared.where}, and ${row} says ${sdk} has no ${name} unit: the row's \`absent\` is stale, so take ${sdk} out of it`);
      continue;
    }
    if (yetToReach(unit, sdk)) {
      if (declared) fail(`${sdk} has ${declared.where}, and ${row} says ${sdk} has yet to reach the ${name} unit (\`notYetReached\`): take ${sdk} out of it`);
      continue;
    }
    if (!declared) {
      fail(`${sdk} declares no ${made}, which ${row} says it makes the ${name} unit as: add it to the SDK, or say in the row's \`absent\` why ${sdk} has none`);
      continue;
    }
    const its = `${sdk}'s ${name} unit (${declared.where})`;
    if (!declared.isUnit) fail(`${its} is not a StateUnit: say so where it is declared, so it ends by \`dispose\` as every unit does`);
    heldToMembers(sdk, its, row, unit.members, declared.members);
    const maker = unit.madeBy?.[sdk];
    const wrong = makeable(made, declared, maker);
    if (wrong === undefined) continue;
    if (maker === undefined) fail(`${its} has no public way to be made: ${wrong}`);
    else fail(`${row} says ${sdk} makes the ${name} unit by ${maker}, ${wrong}: name in the row's \`madeBy\` a function of ${sdk}'s public surface that makes it, or take ${sdk} out of it if the unit's own constructor is public`);
  }
}


/**
 * Hold the members `sdk` declares (`declared`, of what `its` names) to those
 * `row` lists (`listed`, member → its row) both ways: a member the row lists
 * that the SDK lacks, and one the SDK has that the row does not list. A
 * member's `absent`, or its `notYetReached`, that names the SDK is stale once
 * the SDK has it.
 */
function heldToMembers(sdk, its, row, listed, declared) {
  for (const [member, stated] of listed) {
    if (stated.absent?.[sdk] !== undefined) {
      if (declared.has(member)) fail(`${its} has ${member}, and ${row} says ${sdk}'s has none: the member's \`absent\` is stale, so take ${sdk} out of it`);
      continue;
    }
    if (yetToReach(stated, sdk)) {
      if (declared.has(member)) fail(`${its} has ${member}, and ${row} says ${sdk}'s has yet to have it (\`notYetReached\`): take ${sdk} out of the member's \`notYetReached\``);
      continue;
    }
    if (!declared.has(member)) fail(`${its} has no ${member}, which ${row} lists: add it to the SDK, under that name, or say in the member's \`absent\` why ${sdk}'s has none`);
  }
  for (const member of declared) {
    if (!listed.has(member)) fail(`${its} has ${member}, which ${row} does not list: rename it to the row's name for it, or add a row for it there before any SDK has it`);
  }
}

/**
 * Read a section that states one thing every SDK has (`wire`, `storage`),
 * named `row` in a message: what it is (`docs`), what each SDK of `roster`
 * makes it as (`made`), and its members, each a name with an `absent` for
 * each SDK that has none. `noun` is what a message calls the thing. Gives
 * member → its row.
 */
function sectionMembers(section, row, roster, noun) {
  const members = new Map();
  const strays = Object.keys(section).filter((key) => !['docs', 'made', 'members', 'notYetReached'].includes(key));
  if (strays.length > 0) fail(`${row} states ${strays.join(', ')}, which it does not: what the ${noun} does is its SDKs' tests' to hold`);
  if (typeof section.docs !== 'string' || section.docs === '') fail(`${row} does not say what it is (\`docs\`)`);
  heldWaiting(row, section, roster, noun);
  for (const sdk of roster) {
    if (yetToReach(section, sdk) && section.made?.[sdk] === undefined) continue;
    if (typeof section.made?.[sdk] !== 'string' || !/^\w+$/.test(section.made[sdk])) fail(`${row} does not say what ${sdk} makes the ${noun} as (\`made\`)`);
  }
  for (const sdk of Object.keys(section.made ?? {})) {
    if (!roster.includes(sdk)) fail(`${row}: \`made\` names "${sdk}", which is no SDK whose ${noun} this lint reads`);
  }
  if (!Array.isArray(section.members) || section.members.length === 0) fail(`${row} lists no member`);
  for (const stated of section.members ?? []) {
    const name = `${row}, member ${stated.member}`;
    if (members.has(stated.member)) fail(`${name} is listed twice`);
    members.set(stated.member, stated);
    const others = Object.keys(stated).filter((key) => !['member', 'absent', 'notYetReached'].includes(key));
    if (others.length > 0) fail(`${name} states ${others.join(', ')}, and a member of the ${noun} is its name, with an \`absent\` for each SDK that has none`);
    heldWaiting(name, stated, roster, noun);
    for (const [sdk, why] of Object.entries(stated.absent ?? {})) {
      if (!roster.includes(sdk)) fail(`${name}: \`absent\` names "${sdk}", which is no SDK whose ${noun} this lint reads`);
      if (typeof why !== 'string' || why === '') fail(`${name}: \`absent\` does not say why ${sdk} lacks it`);
    }
    if (roster.every((sdk) => stated.absent?.[sdk] !== undefined)) fail(`${name} is absent from every SDK: it is no member`);
  }
  return members;
}

// ── The bus over the wire ───────────────────────────────────────────────

/**
 * Each SDK whose bus this reads: its reader, given the name the SDK makes the
 * bus as; where the bus is declared (TypeScript's is @semiont/core's); and
 * where the SDK's client hands it out as `wire`, with what says it does.
 */
const WIRES = {
  typescript: {
    read: typescriptUnit,
    sources: TS_CORE,
    handedOut: { file: `${TS_SDK}/client.ts`, says: (made) => new RegExp(`^\\s+readonly wire: ${made};$`, 'm') },
  },
  rust: {
    read: rustUnit,
    sources: RUST_SDK,
    handedOut: { file: `${RUST_SDK}/client.rs`, says: (made) => new RegExp(`^\\s+pub fn wire\\(&self\\) -> &${made} \\{$`, 'm') },
  },
  python: {
    read: pythonUnit,
    sources: PYTHON_SDK,
    handedOut: { file: `${PYTHON_SDK}/client.py`, says: (made) => new RegExp(`^\\s+self\\.wire: Final = ${made}\\(transport\\)$`, 'm') },
  },
  go: {
    read: goWire,
    sources: GO_SDK,
    handedOut: { file: `${GO_SDK}/client.go`, says: (made) => new RegExp(`^\\s+Wire\\s+\\*${made}\\s*(?://.*)?$`, 'm') },
  },
  kotlin: {
    read: kotlinUnit,
    sources: KOTLIN_SDK,
    handedOut: { file: `${KOTLIN_SDK}/SemiontClient.kt`, says: (made) => new RegExp(`^\\s+public val wire: ${made}$`, 'm') },
  },
};
const WIRE_SDKS = Object.keys(WIRES);

/** member → row */
const wireMembers = new Map();
const wire = table.wire;
const wireRow = `\`wire\` in ${TABLE}`;
if (typeof wire !== 'object' || wire === null || Array.isArray(wire)) fail(`${TABLE}: \`wire\` does not state the bus over a client's transport`);
else {
  for (const [member, row] of sectionMembers(wire, wireRow, WIRE_SDKS, 'bus')) {
    wireMembers.set(member, row);
    if (member === 'transport') fail(`${wireRow}, member ${member}: a bus hands out no transport; a client's transport is the client's \`transport\`, and only there`);
  }
  for (const [sdk, { read: readBus, sources: where, handedOut }] of Object.entries(WIRES)) {
    if (yetToReach(wire, sdk)) {
      if (REPOSITORY.includes(handedOut.file) && handedOut.says('\\w+').test(read(handedOut.file))) {
        fail(`${handedOut.file}: ${sdk}'s client hands out a bus as \`wire\`, and ${wireRow} says ${sdk} has yet to reach it (\`notYetReached\`): take ${sdk} out of it, and say what it makes the bus as (\`made\`)`);
      }
      continue;
    }
    const made = wire.made?.[sdk];
    if (typeof made !== 'string') continue;
    const declared = readBus(made, where);
    if (!declared) {
      fail(`${sdk} declares no ${made} in ${where}, which ${wireRow} says it makes the bus over a client's transport as`);
      continue;
    }
    if (!REPOSITORY.includes(handedOut.file) || !handedOut.says(made).test(read(handedOut.file))) {
      fail(`${handedOut.file}: ${sdk}'s client does not hand out its ${made} as \`wire\`, which ${wireRow} says every client does`);
    }
    heldToMembers(sdk, `${sdk}'s bus (${declared.where})`, wireRow, wireMembers, declared.members);
  }
}

// ── The storage ─────────────────────────────────────────────────────────

/**
 * Each SDK whose storage this reads: its reader, given the name the SDK makes
 * the storage as, and where the storage is declared. TypeScript's is an
 * interface, read as a unit's is; Python's a class (a `Protocol`), read as a
 * unit's is; Kotlin's an interface, read as a unit's is; Go's an interface
 * of the root package, and Rust's a trait.
 */
const STORAGES = {
  typescript: { read: typescriptUnit, sources: TS_SDK },
  rust: { read: rustTrait, sources: RUST_SDK },
  python: { read: pythonUnit, sources: PYTHON_SDK },
  go: { read: goInterface, sources: GO_SDK },
  kotlin: { read: kotlinUnit, sources: KOTLIN_SDK },
};
const STORAGE_SDKS = Object.keys(STORAGES);

/** member → row */
const storageMembers = new Map();
const storage = table.storage;
const storageRow = `\`storage\` in ${TABLE}`;
if (typeof storage !== 'object' || storage === null || Array.isArray(storage)) fail(`${TABLE}: \`storage\` does not state where a client keeps text under a key`);
else {
  for (const [member, row] of sectionMembers(storage, storageRow, STORAGE_SDKS, 'storage')) storageMembers.set(member, row);
  for (const [sdk, { read: readStorage, sources: where }] of Object.entries(STORAGES)) {
    const made = storage.made?.[sdk];
    if (typeof made !== 'string') continue;
    const declared = readStorage(made, where);
    if (yetToReach(storage, sdk)) {
      if (declared) fail(`${sdk} has ${declared.where}, and ${storageRow} says ${sdk} has yet to reach it (\`notYetReached\`): take ${sdk} out of it`);
      continue;
    }
    if (!declared) {
      fail(`${sdk} declares no ${made} in ${where}, which ${storageRow} says it makes the storage as`);
      continue;
    }
    heldToMembers(sdk, `${sdk}'s storage (${declared.where})`, storageRow, storageMembers, declared.members);
  }
}

// ── The modules ─────────────────────────────────────────────────────────

/**
 * What a client's SDK has beside its namespaces: the free functions, types
 * and values of its modules. Each row of the table's `modules` section is a
 * module, where each SDK keeps it (`where`: its files, or for Go a package's
 * directory), and its members. A member is held by its name as its `kind`
 * says each language spells it:
 *
 *   - `function`: TypeScript and Kotlin as the table spells it, Rust and
 *     Python in snake_case, Go with its first letter a capital;
 *   - `reader`: as a function, but TypeScript's is `get` and the name with
 *     its first letter a capital;
 *   - `type`: as the table spells it, in every SDK;
 *   - `constant`: TypeScript, Rust, Python and Kotlin in capitals with
 *     underscores, Go as a function.
 *
 * Go's and Kotlin's `where` is a package's directory; the other SDKs' are
 * files.
 *
 * `named` gives an SDK's own name for a member, where the rule does not.
 * `absent` says why an SDK has none, and is stale once it has one.
 * `notYetReached`, on a member or on the whole module, names an SDK that is
 * to have it and does not yet, and is stale once it has it. A module whose
 * `whole` lists an SDK is that SDK's files and nothing else: every public
 * member of them is listed.
 */
const MODULE_SDKS = ['typescript', 'rust', 'python', 'go', 'kotlin'];
/** The SDKs whose module is a package, given by its directory. */
const BY_DIRECTORY = ['go', 'kotlin'];
const MODULE_KINDS = ['function', 'reader', 'type', 'constant'];
const capitalized = (name) => name[0].toUpperCase() + name.slice(1);
const snakeCase = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** A member's name as `sdk` spells a member of `kind`. */
function spelledAs(sdk, kind, name) {
  if (kind === 'type') return name;
  if (kind === 'constant') return sdk === 'go' ? capitalized(name) : snakeCase(name).toUpperCase();
  if (sdk === 'go') return capitalized(name);
  if (sdk === 'rust' || sdk === 'python') return snakeCase(name);
  if (sdk === 'kotlin') return name;
  return kind === 'reader' ? `get${capitalized(name)}` : name;
}

/** The public names of TypeScript files: what each exports by declaration. */
function typescriptExports(files) {
  return files.flatMap((file) =>
    [...withoutComments(read(file), `'"\``).matchAll(/^export (?:declare )?(?:async )?(?:abstract )?(?:function\*?|const|let|class|interface|type|enum) (\w+)/gm)].map((m) => m[1]),
  );
}

/** The public names of Rust files: each item declared `pub` at the top of a file. */
function rustExports(files) {
  return files.flatMap((file) =>
    [...withoutComments(read(file), '"').matchAll(/^pub (?:async )?(?:fn|struct|enum|trait|const|type|static) (\w+)/gm)].map((m) => m[1]),
  );
}

/** The public names of Python modules: each one's `__all__`. */
function pythonExports(files) {
  return files.flatMap((file) => {
    const all = withoutPythonComments(read(file)).match(/^__all__\s*=\s*\[([^\]]*)\]/m);
    if (!all) {
      fail(`${file} states no __all__: its public names are not said`);
      return [];
    }
    return [...all[1].matchAll(/["'](\w+)["']/g)].map((m) => m[1]);
  });
}

/**
 * The exported names of Go packages, each given by its directory: every name
 * its files declare at their top level with a capital, but methods, and but a
 * constant of a type the package exports. Such a constant is one of its type's
 * values, as a variant of a Rust enum is, and is held with the type.
 */
function goExports(directories) {
  return directories.flatMap((directory) => {
    const codes = filesIn(directory, '.go')
      .filter((name) => !name.endsWith('_test.go'))
      .map((name) => goCode(read(`${directory}/${name}`)));
    const blocks = (code, keyword) => [...code.matchAll(new RegExp(`^${keyword} \\(\\n([\\s\\S]*?)^\\)`, 'gm'))].map((block) => block[1]);
    const types = new Set(
      codes.flatMap((code) => [
        ...[...code.matchAll(/^type (\p{Lu}\w*)/gmu)].map((m) => m[1]),
        ...blocks(code, 'type').flatMap((block) => [...block.matchAll(/^\t(\p{Lu}\w*)/gmu)].map((m) => m[1])),
      ]),
    );
    return codes.flatMap((code) => {
      const declared = [...code.matchAll(/^(?:func|type|var) (\p{Lu}\w*)/gmu)].map((m) => m[1]);
      const grouped = ['var', 'type'].flatMap((keyword) => blocks(code, keyword).flatMap((block) => [...block.matchAll(/^\t(\p{Lu}\w*)/gmu)].map((m) => m[1])));
      const constants = [...code.matchAll(/^const (\p{Lu}\w*)(?:[ \t]+(\w+))?/gmu)].filter((m) => !types.has(m[2])).map((m) => m[1]);
      // In a block of constants, one stated with no type and no value repeats the type of the one before it.
      const groupedConstants = blocks(code, 'const').flatMap((block) => {
        let type;
        return [...block.matchAll(/^\t(\w+)(?:[ \t]+(\w+))?([ \t]*=)?/gm)].flatMap(([, name, stated, valued]) => {
          if (stated !== undefined || valued !== undefined) type = stated;
          return /^\p{Lu}/u.test(name) && !types.has(type) ? [name] : [];
        });
      });
      return [...declared, ...grouped, ...constants, ...groupedConstants];
    });
  });
}

const EXPORTS = { typescript: typescriptExports, rust: rustExports, python: pythonExports, go: goExports, kotlin: kotlinExports };

/** module → row */
const modules = new Map();
const moduleRows = table.modules;
if (!Array.isArray(moduleRows) || moduleRows.length === 0) fail(`${TABLE} states no \`modules\`: what a client's SDK has beside its namespaces`);
for (const module of moduleRows ?? []) {
  const row = `the \`${module.module}\` row of \`modules\` in ${TABLE}`;
  if (modules.has(module.module)) fail(`${row} is listed twice`);
  modules.set(module.module, module);
  const strays = Object.keys(module).filter((key) => !['module', 'docs', 'where', 'whole', 'members', 'notYetReached'].includes(key));
  if (strays.length > 0) fail(`${row} states ${strays.join(', ')}, which a module does not`);
  if (typeof module.docs !== 'string' || module.docs === '') fail(`${row} does not say what the module is (\`docs\`)`);
  for (const [said, entries] of [['where', module.where], ['notYetReached', module.notYetReached ?? {}]]) {
    for (const sdk of Object.keys(entries ?? {})) {
      if (!MODULE_SDKS.includes(sdk)) fail(`${row}: \`${said}\` names "${sdk}", which is no SDK whose modules this lint reads`);
    }
  }
  for (const sdk of module.whole ?? []) {
    if (!MODULE_SDKS.includes(sdk)) fail(`${row}: \`whole\` names "${sdk}", which is no SDK whose modules this lint reads`);
  }
  if (!Array.isArray(module.members) || module.members.length === 0) fail(`${row} lists no member`);
  const members = new Map();
  for (const member of module.members ?? []) {
    const name = `${row}, member ${member.member}`;
    if (members.has(member.member)) fail(`${name} is listed twice`);
    members.set(member.member, member);
    if (!MODULE_KINDS.includes(member.kind)) fail(`${name} has the kind "${member.kind}", which is none of ${MODULE_KINDS.join(', ')}`);
    const others = Object.keys(member).filter((key) => !['member', 'kind', 'named', 'absent', 'notYetReached'].includes(key));
    if (others.length > 0) fail(`${name} states ${others.join(', ')}, which a member does not`);
    for (const [said, entries] of [['named', member.named ?? {}], ['absent', member.absent ?? {}], ['notYetReached', member.notYetReached ?? {}]]) {
      for (const [sdk, value] of Object.entries(entries)) {
        if (!MODULE_SDKS.includes(sdk)) fail(`${name}: \`${said}\` names "${sdk}", which is no SDK whose modules this lint reads`);
        if (typeof value !== 'string' || value === '') fail(`${name}: \`${said}\` says nothing for ${sdk}`);
      }
    }
    if (MODULE_SDKS.every((sdk) => member.absent?.[sdk] !== undefined)) fail(`${name} is absent from every SDK: it is no member`);
  }

  for (const sdk of MODULE_SDKS) {
    const where = module.where?.[sdk];
    const waiting = module.notYetReached?.[sdk];
    if (waiting !== undefined && where === undefined) continue;
    if (!Array.isArray(where) || where.length === 0) {
      fail(`${row} does not say where ${sdk} keeps the module (\`where\`)`);
      continue;
    }
    const missing = where.filter((path) => (BY_DIRECTORY.includes(sdk) ? !REPOSITORY.some((file) => dirname(file) === path) : !REPOSITORY.includes(path)));
    if (waiting !== undefined) {
      if (missing.length === 0) {
        const present = new Set(EXPORTS[sdk](where));
        const reached = [...members.values()].filter((member) => present.has(member.named?.[sdk] ?? spelledAs(sdk, member.kind, member.member)));
        if (reached.length > 0) fail(`${row} says ${sdk} has yet to reach the module (\`notYetReached\`), and ${where.join(', ')} has ${reached.map((member) => member.member).join(', ')}: say which members it still lacks on each member instead`);
      }
      continue;
    }
    if (missing.length > 0) {
      fail(`${row} says ${sdk} keeps the module in ${missing.join(', ')}, which does not exist`);
      continue;
    }
    const its = `${sdk}'s ${module.module} (${where.join(', ')})`;
    const present = new Set(EXPORTS[sdk](where));
    const expected = new Set();
    for (const [member, stated] of members) {
      const spelled = stated.named?.[sdk] ?? spelledAs(sdk, stated.kind, member);
      if (stated.absent?.[sdk] !== undefined) {
        if (present.has(spelled)) fail(`${its} has ${spelled}, and ${row} says ${sdk} has no ${member}: the member's \`absent\` is stale, so take ${sdk} out of it`);
        continue;
      }
      if (stated.notYetReached?.[sdk] !== undefined) {
        if (present.has(spelled)) fail(`${its} has ${spelled}, and ${row} says ${sdk} has yet to have ${member}: take ${sdk} out of the member's \`notYetReached\``);
        continue;
      }
      expected.add(spelled);
      if (!present.has(spelled)) fail(`${its} has no ${spelled}, which ${row} lists as ${member}: add it to the SDK, or say in the member's \`absent\` why ${sdk} has none`);
    }
    if ((module.whole ?? []).includes(sdk)) {
      for (const name of present) {
        if (!expected.has(name)) fail(`${its} has ${name}, which ${row} does not list: add a member for it there before any SDK has it, with an \`absent\` for each SDK that is not to`);
      }
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
/** A roster as a message names it: "TypeScript, Rust and Python". */
const heldBy = (roster) => {
  const names = roster.map((sdk) => LANGUAGES[sdk]);
  return `held by ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`}`;
};
/** Every `notYetReached` the table states, each an SDK still to have what its row names. */
const stillToReach = (value) =>
  Array.isArray(value)
    ? value.reduce((total, item) => total + stillToReach(item), 0)
    : value !== null && typeof value === 'object'
      ? Object.entries(value).reduce((total, [key, item]) => total + (key === 'notYetReached' ? Object.keys(item).length : stillToReach(item)), 0)
      : 0;
console.log(
  `✓ lint:client-surface — ${count} methods in ${rows.size} namespaces, ${heldBy(NAMESPACE_SDKS)}; ${membersCount} members of what a worker is handed, ${heldBy(WORKER_SDKS)}; ${unitMembers} members of ${units.size} state units, ${heldBy(UNIT_SDKS)}; ${wireMembers.size} members of the bus over the wire, ${heldBy(WIRE_SDKS)}; ${storageMembers.size} members of the storage, ${heldBy(STORAGE_SDKS)}; and ${[...modules.values()].reduce((total, module) => total + (module.members?.length ?? 0), 0)} members of ${modules.size} modules, ${heldBy(MODULE_SDKS)}; ${stillToReach(table)} rows name an SDK that is still to reach them`,
);
