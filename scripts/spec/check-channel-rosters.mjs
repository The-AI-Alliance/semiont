#!/usr/bin/env node
// lint:spec-channel-rosters — the channels each Rust service names: the ones
// it answers, held to each other and to its protocol document, and every one
// it names, held to the document.
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
// The dispatch is read as written in these files: a match arm's pattern,
// alone or among alternatives, or a side of `==`.
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
 */
const SERVICES = [
  {
    name: 'the Archivist',
    handler: 'apps/archivist/src/bus.rs',
    rosters: ['COMMANDS', 'READS'],
    sources: ['apps/archivist/src', 'apps/archivist/record/src', 'apps/archivist/staging/src'],
    protocol: 'docs/protocol/ARCHIVIST.md',
    tables: ['Command', 'Request'],
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

/** A channel's type in the Rust SDK, as `pascal` of packages/codegen-rust names it: `job:cancel-requested` is `JobCancelRequested`. */
const typeOf = (channel) => channel.split(/[^A-Za-z0-9]+/).filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join('');
const channelOf = new Map(registry.channels.map((channel) => [typeOf(channel.channel), channel.channel]));
if (channelOf.size === 0 || operationOf.size === 0 || answeredByOne.size === 0) {
  fail(`${REGISTRY} declares no channel, no operation or no command: the check has lost what it reads`);
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

const firstCell = (line) => (line.startsWith('|') ? line.split('|')[1].trim() : null);

/** The first cell of each row of every table of `document` whose header's first cell is `heading`. */
function rowsOf(document, heading) {
  const lines = document.split('\n');
  const tables = [];
  for (let at = 0; at + 1 < lines.length; at++) {
    if (firstCell(lines[at]) !== heading || !/^\|[-:| ]+\|$/.test(lines[at + 1].trim())) continue;
    const rows = [];
    for (let row = at + 2; row < lines.length && lines[row].startsWith('|'); row++) {
      rows.push({ cell: firstCell(lines[row]), line: row + 1 });
    }
    tables.push(rows);
  }
  return tables;
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
    const tables = rowsOf(protocol, heading);
    if (tables.length === 0 || tables.some((rows) => rows.length === 0)) {
      fail(`${service.protocol} has no table headed ${heading}, or one with no rows: the check has lost what it reads`);
    }
    for (const { cell, line } of tables.flat()) {
      const channel = /^`([^`]+)`/.exec(cell)?.[1];
      if (channel === undefined) fail(`${service.protocol}:${line}: a row of a ${heading} table is led by no channel`);
      else if (!named.has(channel)) fail(`${service.protocol}:${line} says ${service.name} answers ${channel}, which no roster of it names`);
    }
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
console.log(`✓ each service names every channel by its type, and its protocol document names each; its rosters, its dispatch and the document's tables agree on the ones it answers (${counts})`);
