#!/usr/bin/env node
// lint:spec-channel-rosters — the channels each Rust service answers, held to
// each other and to the protocol document that states them.
//
// A service names a channel by the type the Rust SDK generates for it from
// the bus registry (specs/src/bus/registry.json): `job:create` is
// `JobCreate`, and its name on the wire is `JobCreate::NAME`. A type exists
// only for a channel the registry declares, so a roster or a match arm for
// one it does not declare does not compile. A string literal would compile
// whatever it named.
//
// The registry says whether a channel is an operation's request or reply, a
// command, an event, or in-process. It does not say which service answers a
// channel. That is stated three times over: by the service's protocol
// document, in the tables whose rows a channel leads; by the rosters the
// service opens its stream with; and by the dispatch that hands each frame to
// its handler. The compiler holds none of the three to another.
//
// It fails when, for a service listed below:
//   - a roster is missing, holds anything but a channel type's `NAME`, or
//     holds a number of them other than the length its type states; or a
//     table of the document is missing, or a row of one is led by no channel:
//     the check has lost what it reads;
//   - a roster or the dispatch names a type that is no channel's;
//   - the dispatch names a channel by a string literal;
//   - a channel is in the rosters twice: each of its frames would be given to
//     two pumps;
//   - a roster names a channel no service is sent: one that is in-process, or
//     an operation's result or failure;
//   - the dispatch names a channel no roster does, a handler for frames that
//     never arrive; or a roster names one the dispatch does not, frames that
//     arrive and are handled by nothing;
//   - a roster names a channel the protocol document does not;
//   - a table of the document is led by a channel no roster names: the
//     document says the service answers it;
//   - an operation's request or a command is in the rosters of two services:
//     each has the one service that answers it.
//
// The dispatch is read as written in these files: a match arm's pattern,
// alone or among alternatives, or a side of `==`.
//
// It reads the source files, so it cannot pass on a stale bundle.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withoutComments } from '../lint/source-text.mjs';

const REPO = resolve(fileURLToPath(import.meta.url), '../../..');
const REGISTRY = 'specs/src/bus/registry.json';

/**
 * Each service: the file that holds its rosters and its dispatch, and its
 * protocol document with the tables a channel it answers leads a row of, each
 * table named by the first cell of its header.
 */
const SERVICES = [
  {
    name: 'the Archivist',
    source: 'apps/archivist/src/bus.rs',
    rosters: ['COMMANDS', 'READS'],
    protocol: 'docs/protocol/ARCHIVIST.md',
    tables: ['Command', 'Request'],
  },
  {
    name: 'the dispatcher',
    source: 'apps/dispatcher/handlers/src/handlers.rs',
    rosters: ['COMMANDS'],
    protocol: 'docs/protocol/JOBS.md',
    tables: ['Channel'],
  },
];

const failures = new Set();
const fail = (message) => failures.add(message);

const registry = JSON.parse(readFileSync(resolve(REPO, REGISTRY), 'utf8'));
const inProcess = new Set(registry.inProcess.channels);
const requestOf = new Map(registry.operations.flatMap((op) => [[op.result, op.request], [op.failure, op.request]]));
const answeredByOne = new Set([...registry.operations.map((op) => op.request), ...registry.kind.command]);

/** A channel's type in the Rust SDK, as `pascal` of packages/codegen-rust names it: `job:cancel-requested` is `JobCancelRequested`. */
const typeOf = (channel) => channel.split(/[^A-Za-z0-9]+/).filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join('');
const channelOf = new Map(registry.channels.map((channel) => [typeOf(channel.channel), channel.channel]));
if (channelOf.size === 0 || requestOf.size === 0 || answeredByOne.size === 0) {
  fail(`${REGISTRY} declares no channel, no operation or no command: the check has lost what it reads`);
}

const LITERAL = '"(?:[^"\\\\]|\\\\.)*"';
const NAME_OF_A_TYPE = '\\b[A-Za-z0-9_]+::NAME\\b';

/** The string literals of `text` and the types whose `NAME` it reads, each with what stands before and after it. */
function terms(text) {
  return [...text.matchAll(new RegExp(`${LITERAL}|${NAME_OF_A_TYPE}`, 'g'))].map((match) => ({
    literal: match[0].startsWith('"') ? match[0] : null,
    type: match[0].startsWith('"') ? null : match[0].slice(0, -'::NAME'.length),
    before: text.slice(0, match.index),
    after: text.slice(match.index + match[0].length),
  }));
}

/** A roster as its source declares it: the length its type states, the types it names, and what else its body holds. */
function roster(source, name) {
  const found = new RegExp(`\\bconst ${name}: \\[&str; (\\d+)\\] = \\[([^\\]]*)\\];`).exec(source);
  if (!found) return null;
  const [, length, body] = found;
  return {
    length: Number(length),
    types: terms(body).flatMap((term) => (term.type === null ? [] : [term.type])),
    beside: body.replace(new RegExp(NAME_OF_A_TYPE, 'g'), '').split(',').map((entry) => entry.trim()).filter(Boolean),
  };
}

/** Every term `source` dispatches on. */
function dispatched(source) {
  return terms(source).filter(({ before, after }) => /^\s*(?:=>|\|(?!\|)|==)/.test(after) || /==\s*$/.test(before));
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
  if (!existsSync(resolve(REPO, service.source))) { fail(`${service.source} is missing`); continue; }
  if (!existsSync(resolve(REPO, service.protocol))) { fail(`${service.protocol} is missing`); continue; }
  const source = withoutComments(readFileSync(resolve(REPO, service.source), 'utf8'));
  const protocol = readFileSync(resolve(REPO, service.protocol), 'utf8');

  const named = new Map();
  for (const name of service.rosters) {
    const stated = roster(source, name);
    if (stated === null) { fail(`${service.source} has no roster ${name}: the check has lost what it reads`); continue; }
    if (stated.beside.length > 0) fail(`${service.name}'s ${name} holds ${stated.beside.join(', ')}: a roster holds a channel type's NAME and nothing else`);
    if (stated.types.length !== stated.length) fail(`${service.name}'s ${name} states ${stated.length} channels and the check reads ${stated.types.length}`);
    for (const type of stated.types) {
      const channel = channelOf.get(type);
      if (channel === undefined) fail(`${service.name}'s ${name} names ${type}, which is the type of no channel ${REGISTRY} declares`);
      else if (named.has(channel)) fail(`${service.name} names ${channel} twice, in ${named.get(channel)} and in ${name}`);
      else named.set(channel, name);
    }
  }
  answered.set(service, named);

  for (const [channel, name] of named) {
    if (inProcess.has(channel)) fail(`${service.name}'s ${name} names ${channel}, which is in-process: no service is sent it`);
    if (requestOf.has(channel)) fail(`${service.name}'s ${name} names ${channel}, a reply to ${requestOf.get(channel)}: it is sent to the client that asked, and to no service`);
    if (!protocol.includes(`\`${channel}\``)) fail(`${service.name}'s ${name} names ${channel}, which ${service.protocol} does not`);
  }

  const dispatch = new Set();
  for (const { literal, type } of dispatched(source)) {
    if (literal !== null) { fail(`${service.source} dispatches on the literal ${literal}: a channel is named by its type, which exists only for one the registry declares`); continue; }
    const channel = channelOf.get(type);
    if (channel === undefined) { fail(`${service.source} dispatches on ${type}, which is the type of no channel ${REGISTRY} declares`); continue; }
    if (!named.has(channel) && !dispatch.has(channel)) fail(`${service.source} dispatches on ${channel}, which no roster of ${service.name} names: its frames never arrive`);
    dispatch.add(channel);
  }
  for (const [channel, name] of named) {
    if (!dispatch.has(channel)) fail(`${service.name}'s ${name} names ${channel}, which ${service.source} does not dispatch on: its frames are handled by nothing`);
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
console.log(`✓ each service names the channels it answers by their types, and its rosters, its dispatch and its protocol document name the same ones (${counts})`);
