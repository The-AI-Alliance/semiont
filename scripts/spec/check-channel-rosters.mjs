#!/usr/bin/env node
// lint:spec-channel-rosters — the channels each Rust service names: the ones
// it answers, held to each other and to its protocol document; every one it
// names, held to the document; and the events the Archivist appends for each
// one it answers, held to the document and to the registry.
//
// A service names a channel by the type the Rust SDK generates for it from
// the bus registry (specs/src/bus/registry.json): `job:create` is
// `JobCreate`, and its name on the wire is `JobCreate::NAME`. An operation's
// reply is named through its request: `<<JobCreate as Request>::Result as
// Channel>::NAME` is the channel the registry gives the result of
// `job:create`. A type exists only for a channel the registry declares, so a
// name for one it does not declare does not compile. A string literal would
// compile whatever it named.
//
// The registry says whether a channel is an operation's request or reply, a
// command, an event, or in-process. It does not say which service answers a
// channel, or sends one. The service's protocol document does: the tables
// whose rows a channel leads state the ones it answers, and it names every
// one the service has to do with. The service's source states the ones it
// answers twice more: in the rosters it opens its stream with, and in the
// dispatch that hands each frame to its handler. The compiler holds none of
// these to another.
//
// Nor does the registry say which event a command appends. The document's
// tables of commands do, in their `Appends` column, and the Archivist's
// handlers do again. What the registry says is that a read leaves nothing
// behind and that a write is an act.
//
// It fails when, for a service listed below:
//   - a source, a roster or a table of the document is missing; a roster
//     holds anything but a channel type's `NAME`, or a number of them other
//     than the length its type states; a row of a table is led by no channel;
//     or a source reads a `NAME` in a form the check does not: the check has
//     lost what it reads;
//   - a source names a type that is no channel's, or a reply through a type
//     that is no operation's request;
//   - a source names a channel by a string literal: one that reads as a
//     channel's name, or any at all in the dispatch;
//   - a source names a channel the protocol document does not;
//   - a channel is in the rosters twice: each of its frames would be given to
//     two pumps;
//   - a roster names a channel no service is sent: one that is in-process, or
//     an operation's result or failure;
//   - the dispatch names a channel no roster does, a handler for frames that
//     never arrive; or a roster names one the dispatch does not, frames that
//     arrive and are handled by nothing;
//   - a table of the document is led by a channel no roster names: the
//     document says the service answers it;
//   - an operation's request or a command is in the rosters of two services:
//     each has the one service that answers it.
//
// And when, for the Archivist:
//   - a table of commands has no `Appends` column, or a cell of one names
//     something that is no event of the record and is not `none`;
//   - handling a channel appends an event its row does not name, or its row
//     names one that handling it does not append. A channel no such row
//     leads appends nothing;
//   - handling a read appends an event, or handling a write appends none;
//   - an event is made or appended anywhere but in
//     `archivist.append(event(…))` in the modules read for it, a match on the
//     channel has an arm that is not channel types or `_`, or the dispatch
//     calls a function of those modules that is not found: the check has
//     lost what it reads.
//
// The dispatch is read as written in these files: a match arm's pattern,
// alone or among alternatives, or a side of `==`.
//
// What handling a channel appends is read from the function the dispatch
// begins in, through every function of the modules below that it calls. Of a
// `match channel` it reads the arm that names the channel, or `_` when none
// does; of an `if channel ==`, the block when it is that channel and the
// `else` when it is not. An event whose type is a variable is taken to be any
// event of the record the function names where the channel reads. So what is
// held is which events a channel can append, and not how many or in what
// order.
//
// It reads the source files, so it cannot pass on a stale bundle.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withoutComments } from '../lint/source-text.mjs';

const REPO = resolve(fileURLToPath(import.meta.url), '../../..');
const REGISTRY = 'specs/src/bus/registry.json';

/**
 * Each service: the file that holds its rosters and its dispatch; the sources
 * in which it names the channels of the bus, each a file or a directory of
 * them; and its protocol document, with the tables a channel it answers leads
 * a row of, each table named by the first cell of its header.
 *
 * `appends`, of a service that keeps the record: the function of its handler
 * the dispatch begins in; the modules that function calls into, by the name
 * the handler calls them by; and the tables whose rows say, in the column
 * named, what the channel that leads them appends.
 */
const SERVICES = [
  {
    name: 'the Archivist',
    handler: 'apps/archivist/src/bus.rs',
    rosters: ['COMMANDS', 'READS'],
    sources: ['apps/archivist/src', 'apps/archivist/record/src', 'apps/archivist/staging/src'],
    protocol: 'docs/protocol/ARCHIVIST.md',
    tables: ['Command', 'Request'],
    appends: {
      begins: 'handle',
      modules: { commands: 'apps/archivist/src/commands.rs', browse: 'apps/archivist/src/browse.rs' },
      tables: ['Command'],
      column: 'Appends',
    },
  },
  {
    name: 'the dispatcher',
    handler: 'apps/dispatcher/handlers/src/handlers.rs',
    rosters: ['COMMANDS'],
    sources: ['apps/dispatcher/src', 'apps/dispatcher/handlers/src', 'apps/dispatcher/jetstream/src'],
    protocol: 'docs/protocol/JOBS.md',
    tables: ['Channel'],
  },
];

const failures = new Set();
const fail = (message) => failures.add(message);

const registry = JSON.parse(readFileSync(resolve(REPO, REGISTRY), 'utf8'));
const inProcess = new Set(registry.inProcess.channels);
const operationOf = new Map(registry.operations.map((op) => [op.request, op]));
const requestOf = new Map(registry.operations.flatMap((op) => [[op.result, op.request], [op.failure, op.request]]));
const answeredByOne = new Set([...operationOf.keys(), ...registry.kind.command]);
const flows = new Set(registry.channels.map((channel) => channel.channel.split(':')[0]));
const recorded = new Set(registry.channels.filter((channel) => channel.shape === 'storedEvent').map((channel) => channel.channel));
const reads = new Set(registry.effect.reads);
const writes = new Set(registry.effect.writes);

/** A channel's type in the Rust SDK, as `pascal` of packages/codegen-rust names it: `job:cancel-requested` is `JobCancelRequested`. */
const typeOf = (channel) => channel.split(/[^A-Za-z0-9]+/).filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join('');
const channelOf = new Map(registry.channels.map((channel) => [typeOf(channel.channel), channel.channel]));
if (channelOf.size === 0 || operationOf.size === 0 || answeredByOne.size === 0 || recorded.size === 0 || reads.size === 0 || writes.size === 0) {
  fail(`${REGISTRY} declares no channel, no operation, no command, no event of the record, no read or no write: the check has lost what it reads`);
}

const LITERAL = '"(?:[^"\\\\]|\\\\.)*"';
const REPLY = '<<\\s*(\\w+)\\s+as\\s+Request\\s*>::(Result|Failure)\\s+as\\s+Channel\\s*>::NAME\\b';
const TYPE = '\\b(\\w+)::NAME\\b';
const NAME = '::NAME\\b';

/**
 * The string literals of `text` and the names of channels it reads, each with
 * what stands before and after it: a type's `NAME`, a reply's through its
 * request, or a `NAME` read in neither of those forms.
 */
function terms(text) {
  return [...text.matchAll(new RegExp(`${LITERAL}|${REPLY}|${TYPE}|${NAME}`, 'g'))].map((match) => ({
    text: match[0].replace(/\s+/g, ' '),
    literal: match[0].startsWith('"'),
    reply: match[1] === undefined ? null : { request: match[1], member: match[2].toLowerCase() },
    type: match[3] ?? null,
    before: text.slice(0, match.index),
    after: text.slice(match.index + match[0].length),
  }));
}

/** The channel a term names. One that names none fails, and names none. */
function channelNamedBy(term, path) {
  const type = term.type ?? term.reply?.request;
  if (type === undefined) {
    fail(`${path} reads ${term.text} in a form the check does not: it has lost what it reads`);
    return undefined;
  }
  const channel = channelOf.get(type);
  if (channel === undefined) {
    fail(`${path} names ${type}, which is the type of no channel ${REGISTRY} declares`);
    return undefined;
  }
  if (term.reply === null) return channel;
  const operation = operationOf.get(channel);
  if (operation === undefined) fail(`${path} names a reply to ${channel}, which is the request of no operation`);
  return operation?.[term.reply.member];
}

const dispatches = ({ before, after }) => /^\s*(?:=>|\|(?!\|)|==)/.test(after) || /==\s*$/.test(before);
const readsAsAChannel = (literal) => flows.has(/^"([a-z]+):[a-z-]+"$/.exec(literal)?.[1]);

/** A roster as its source declares it: the length its type states, the types it names, and what else its body holds. */
function roster(source, name) {
  const found = new RegExp(`\\bconst ${name}: \\[&str; (\\d+)\\] = \\[([^\\]]*)\\];`).exec(source);
  if (!found) return null;
  const [, length, body] = found;
  return {
    length: Number(length),
    types: [...body.matchAll(new RegExp(TYPE, 'g'))].map((match) => match[1]),
    beside: body.replace(new RegExp(TYPE, 'g'), '').split(',').map((entry) => entry.trim()).filter(Boolean),
  };
}

/** Every Rust file of `paths`, each a file or a directory of them, with its comments blanked. */
function rustFiles(paths) {
  const files = [];
  const read = (path) => {
    if (!existsSync(resolve(REPO, path))) fail(`${path} is missing`);
    else if (statSync(resolve(REPO, path)).isDirectory()) for (const name of readdirSync(resolve(REPO, path)).sort()) read(join(path, name));
    else if (path.endsWith('.rs')) files.push({ path, text: withoutComments(readFileSync(resolve(REPO, path), 'utf8')) });
  };
  for (const path of paths) read(path);
  return files;
}

const cellsOf = (line) => (line.startsWith('|') ? line.split('|').slice(1, -1).map((cell) => cell.trim()) : []);

/** Every table of `document` whose header's first cell is `heading`: its header's cells, and each row's. */
function tablesOf(document, heading) {
  const lines = document.split('\n');
  const tables = [];
  for (let at = 0; at + 1 < lines.length; at++) {
    if (cellsOf(lines[at])[0] !== heading || !/^\|[-:| ]+\|$/.test(lines[at + 1].trim())) continue;
    const rows = [];
    for (let row = at + 2; row < lines.length && lines[row].startsWith('|'); row++) {
      rows.push({ cells: cellsOf(lines[row]), line: row + 1 });
    }
    tables.push({ header: cellsOf(lines[at]), line: at + 1, rows });
  }
  return tables;
}

/** The channel that leads a row: the first name its first cell quotes. */
const ledBy = (row) => /^`([^`]+)`/.exec(row.cells[0])?.[1];

/** `code` with the inside of each string literal blanked: what is left of a bracket, a comma or an arrow is code. */
const withoutStrings = (code) => code.replace(new RegExp(LITERAL, 'g'), (literal) => `"${literal.slice(1, -1).replace(/[^\n]/g, ' ')}"`);

/** Where the bracket that opens at `open` closes. */
function closing(code, open) {
  let depth = 0;
  for (let at = open; at < code.length; at++) {
    if ('([{'.includes(code[at])) depth++;
    else if (')]}'.includes(code[at]) && --depth === 0) return at;
  }
  return -1;
}

/** The first `sought` of `code` from `from` that no bracket opened since encloses; `to` when there is none before it. */
function outside(code, sought, from, to) {
  for (let at = from, depth = 0; at < to; at++) {
    if (depth === 0 && code.startsWith(sought, at)) return at;
    if ('([{'.includes(code[at])) depth++;
    else if (')]}'.includes(code[at])) depth--;
  }
  return to;
}

/** The functions a file declares at its top level, each by its name: the block that is its body. */
function functionsOf(code) {
  const functions = new Map();
  for (const declared of code.matchAll(/^(?:pub(?:\([^)]*\))? )?(?:const )?(?:async )?fn (\w+)/gm)) {
    const body = code.indexOf('{', closing(code, code.indexOf('(', declared.index)));
    functions.set(declared[1], code.slice(body, closing(code, body) + 1));
  }
  return functions;
}

/**
 * The arms of the match whose block opens at `open`: where each lies, and the
 * channels its pattern names, none for `_`. Null when an arm's pattern is
 * neither.
 */
function armsOf(code, open) {
  const end = closing(code, open);
  const arms = [];
  for (let at = open + 1; code.slice(at, end).trim() !== ''; ) {
    const arrow = outside(code, '=>', at, end);
    const pattern = code.slice(at, arrow).trim();
    const types = pattern === '_' ? [] : pattern.split('|').map((alternative) => /^(\w+)::NAME$/.exec(alternative.trim())?.[1]);
    if (arrow === end || types.includes(undefined)) return null;
    const body = arrow + 2 + /^\s*/.exec(code.slice(arrow + 2))[0].length;
    const to = code[body] === '{' ? closing(code, body) + 1 : outside(code, ',', body, end);
    arms.push({ from: at, to, wild: pattern === '_', channels: types.map((type) => channelOf.get(type)) });
    at = to + /^\s*,?/.exec(code.slice(to, end))[0].length;
  }
  return arms;
}

/** A function's body as handling `channel` reads it: every arm and block that is another channel's, blanked. */
function readFor(channel, body, path) {
  let code = body;
  const blank = (from, to) => { code = code.slice(0, from) + code.slice(from, to).replace(/[^\n]/g, ' ') + code.slice(to); };
  for (let match; (match = /\bmatch channel \{/.exec(code)) !== null; ) {
    const arms = armsOf(code, match.index + match[0].length - 1);
    if (arms === null) { fail(`${path} has a match on the channel with an arm that is neither channel types nor \`_\`: the check has lost what it reads`); break; }
    const named = arms.flatMap((arm) => arm.channels);
    for (const arm of arms) if (arm.wild ? named.includes(channel) : !arm.channels.includes(channel)) blank(arm.from, arm.to);
    blank(match.index, match.index + match[0].length - 1);
  }
  for (let test; (test = /\bif channel == (\w+)::NAME\b/.exec(code)) !== null; ) {
    const block = outside(code, '{', test.index, code.length);
    const close = closing(code, block);
    const otherwise = /^\s*else\s*(?=\{)/.exec(code.slice(close + 1));
    if (channelOf.get(test[1]) !== channel) blank(test.index, close + 1);
    else if (otherwise !== null) blank(close + 1, closing(code, close + 1 + otherwise[0].length) + 1);
    blank(test.index, test.index + 2);
  }
  return code;
}

const APPEND = 'archivist\\s*\\.append\\(\\s*event\\(\\s*(?:(\\w+)::NAME\\b|[a-z_]\\w*\\s*,)';
const EVENT_MADE = '(?<!fn )\\bevent\\(';
const APPENDED = '\\barchivist\\s*\\.append\\(';
const count = (code, pattern) => [...code.matchAll(new RegExp(pattern, 'g'))].length;

/** The events handling `channel` appends, from the function the dispatch begins in through every function it calls. */
function appendedFor(channel, modules, begins) {
  const events = new Set();
  const visited = new Set();
  const visit = (module, name, from) => {
    const functions = modules.get(module)?.functions;
    if (functions === undefined || visited.has(`${module}::${name}`)) return;
    visited.add(`${module}::${name}`);
    if (!functions.has(name)) {
      if (module !== from) fail(`${modules.get(from).path} calls ${module}::${name}, which ${modules.get(module).path} does not declare where the check reads: it has lost what it reads`);
      return;
    }
    const code = readFor(channel, functions.get(name), modules.get(module).path);
    const named = [...code.matchAll(new RegExp(TYPE, 'g'))].map((type) => channelOf.get(type[1])).filter((event) => recorded.has(event));
    for (const [, type] of code.matchAll(new RegExp(APPEND, 'g'))) {
      for (const event of type === undefined ? named : [channelOf.get(type)]) events.add(event);
    }
    for (const [, callee, called] of code.matchAll(/(?<![\w.:])(?:(\w+)::)?([a-z_]\w*)\s*\(/g)) visit(callee ?? module, called, module);
  };
  visit(begins.module, begins.name, begins.module);
  return events;
}

const answered = new Map();
for (const service of SERVICES) {
  if (!existsSync(resolve(REPO, service.protocol))) { fail(`${service.protocol} is missing`); continue; }
  const protocol = readFileSync(resolve(REPO, service.protocol), 'utf8');
  const files = rustFiles(service.sources);
  const handler = files.find((file) => file.path === service.handler);
  if (handler === undefined) { fail(`${service.handler} is not among the sources of ${service.name}: the check has lost what it reads`); continue; }

  for (const { path, text } of files) {
    for (const term of terms(text)) {
      if (term.literal) {
        if (readsAsAChannel(term.text) || (path === service.handler && dispatches(term))) {
          fail(`${path} names a channel by the literal ${term.text}: a channel is named by its type, which exists only for one the registry declares`);
        }
        continue;
      }
      const channel = channelNamedBy(term, path);
      if (channel !== undefined && !protocol.includes(`\`${channel}\``)) fail(`${path} names ${channel}, which ${service.protocol} does not`);
    }
  }

  const named = new Map();
  for (const name of service.rosters) {
    const stated = roster(handler.text, name);
    if (stated === null) { fail(`${service.handler} has no roster ${name}: the check has lost what it reads`); continue; }
    if (stated.beside.length > 0) fail(`${service.name}'s ${name} holds ${stated.beside.join(', ')}: a roster holds a channel type's NAME and nothing else`);
    if (stated.types.length !== stated.length) fail(`${service.name}'s ${name} states ${stated.length} channels and the check reads ${stated.types.length}`);
    for (const type of stated.types) {
      const channel = channelOf.get(type);
      if (channel === undefined) continue;
      if (named.has(channel)) fail(`${service.name} names ${channel} twice, in ${named.get(channel)} and in ${name}`);
      else named.set(channel, name);
    }
  }
  answered.set(service, named);

  for (const [channel, name] of named) {
    if (inProcess.has(channel)) fail(`${service.name}'s ${name} names ${channel}, which is in-process: no service is sent it`);
    if (requestOf.has(channel)) fail(`${service.name}'s ${name} names ${channel}, a reply to ${requestOf.get(channel)}: it is sent to the client that asked, and to no service`);
  }

  const dispatch = new Set();
  for (const term of terms(handler.text).filter((term) => !term.literal && dispatches(term))) {
    const channel = channelNamedBy(term, service.handler);
    if (channel === undefined) continue;
    if (!named.has(channel)) fail(`${service.handler} dispatches on ${channel}, which no roster of ${service.name} names: its frames never arrive`);
    dispatch.add(channel);
  }
  for (const [channel, name] of named) {
    if (!dispatch.has(channel)) fail(`${service.name}'s ${name} names ${channel}, which ${service.handler} does not dispatch on: its frames are handled by nothing`);
  }

  for (const heading of service.tables) {
    const tables = tablesOf(protocol, heading);
    if (tables.length === 0 || tables.some((table) => table.rows.length === 0)) {
      fail(`${service.protocol} has no table headed ${heading}, or one with no rows: the check has lost what it reads`);
    }
    for (const row of tables.flatMap((table) => table.rows)) {
      const channel = ledBy(row);
      if (channel === undefined) fail(`${service.protocol}:${row.line}: a row of a ${heading} table is led by no channel`);
      else if (!named.has(channel)) fail(`${service.protocol}:${row.line} says ${service.name} answers ${channel}, which no roster of it names`);
    }
  }

  if (service.appends === undefined) continue;
  const { begins, column } = service.appends;
  const modules = new Map([[null, { path: service.handler, functions: functionsOf(withoutStrings(handler.text)) }]]);
  for (const [module, path] of Object.entries(service.appends.modules)) {
    const file = files.find((source) => source.path === path);
    if (file === undefined) fail(`${path} is not among the sources of ${service.name}: the check has lost what it reads`);
    else modules.set(module, { path, functions: functionsOf(withoutStrings(file.text)) });
  }
  if (!modules.get(null).functions.has(begins)) fail(`${service.handler} declares no ${begins}: the check has lost what it reads`);
  for (const { path, text } of files) {
    const read = [...modules.values()].some((module) => module.path === path);
    const code = withoutStrings(text);
    const [made, appended, both] = [EVENT_MADE, APPENDED, APPEND].map((pattern) => count(code, pattern));
    if (!read && made + appended > 0) fail(`${path} makes or appends an event, and what ${service.name} appends is read from ${[...modules.values()].map((module) => module.path).join(', ')}`);
    if (read && (made !== both || appended !== both)) fail(`${path} makes an event that it does not append as archivist.append(event(…)), or appends one it does not make there: the check has lost what it reads`);
  }

  const stated = new Map();
  for (const table of service.appends.tables.flatMap((heading) => tablesOf(protocol, heading))) {
    const at = table.header.indexOf(column);
    if (at === -1) { fail(`${service.protocol}:${table.line}: a ${table.header[0]} table has no ${column} column: it does not say what each of its channels appends`); continue; }
    for (const row of table.rows) {
      const events = [...row.cells[at].matchAll(/`([^`]+)`/g)].map((quoted) => quoted[1]);
      for (const event of events) if (!recorded.has(event)) fail(`${service.protocol}:${row.line} says ${ledBy(row)} appends ${event}, which is no event of the record`);
      if (events.length === 0 && row.cells[at] !== 'none') fail(`${service.protocol}:${row.line}: the ${column} of ${ledBy(row)} names no event and is not \`none\``);
      stated.set(ledBy(row), { events, line: row.line });
    }
  }
  for (const channel of named.keys()) {
    const appended = appendedFor(channel, modules, { module: null, name: begins });
    const says = stated.get(channel);
    for (const event of appended) {
      if (says === undefined) fail(`${service.name} appends ${event} when it handles ${channel}, and no row of ${service.protocol} with ${column} is led by ${channel}`);
      else if (!says.events.includes(event)) fail(`${service.name} appends ${event} when it handles ${channel}, which ${service.protocol}:${says.line} does not say`);
    }
    for (const event of says?.events ?? []) {
      if (!appended.has(event)) fail(`${service.protocol}:${says.line} says ${channel} appends ${event}, which ${service.name} does not when it handles ${channel}`);
    }
    if (reads.has(channel) && appended.size > 0) fail(`${channel} is a read, which leaves nothing behind, and ${service.name} appends ${[...appended].join(', ')} when it handles it`);
    if (writes.has(channel) && appended.size === 0) fail(`${channel} is a write, and ${service.name} appends nothing when it handles it`);
  }
}

for (const channel of answeredByOne) {
  const answerers = SERVICES.filter((service) => answered.get(service)?.has(channel)).map((service) => service.name);
  if (answerers.length > 1) fail(`${channel} is answered by ${answerers.join(' and ')}: an operation's request and a command each have one service that answers them`);
}

if (failures.size > 0) {
  for (const message of failures) console.error(`✗ ${message}`);
  process.exit(1);
}
const counts = SERVICES.map((service) => `${service.name} ${answered.get(service).size}`).join(', ');
console.log(`✓ each service names every channel by its type, and its protocol document names each; its rosters, its dispatch and the document's tables agree on the ones it answers, and on what the Archivist appends for each (${counts})`);
