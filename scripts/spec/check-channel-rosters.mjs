#!/usr/bin/env node
// lint:spec-channel-rosters — the channels each Rust service answers, held to
// the bus registry and to the protocol document that states them.
//
// The registry (specs/src/bus/registry.json) declares every channel and says
// whether it is an operation's request or reply, a command, an event, or
// in-process. It does not say which service answers a channel. That is stated
// three times over: by the service's protocol document, in the tables whose
// rows a channel leads; by the rosters the service opens its stream with; and
// by the dispatch that hands each frame to its handler. The rosters and the
// dispatch are string literals, which compile whatever they name.
//
// It fails when, for a service listed below:
//   - a roster is missing, holds anything but string literals, or holds a
//     number of them other than the length its type states; or a table of the
//     document is missing, or a row of one is led by no channel: the check
//     has lost what it reads;
//   - a channel is in the rosters twice: each of its frames would be given to
//     two pumps;
//   - a roster or the dispatch names a channel the registry does not declare;
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
// The dispatch is read as written in these files: a string literal that is a
// match arm's pattern, alone or among alternatives, or a side of `==`.
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

const failures = [];
const fail = (message) => failures.push(message);

const registry = JSON.parse(readFileSync(resolve(REPO, REGISTRY), 'utf8'));
const declared = new Set(registry.channels.map((channel) => channel.channel));
const inProcess = new Set(registry.inProcess.channels);
const requestOf = new Map(registry.operations.flatMap((op) => [[op.result, op.request], [op.failure, op.request]]));
const answeredByOne = new Set([...registry.operations.map((op) => op.request), ...registry.kind.command]);
if (declared.size === 0 || requestOf.size === 0 || answeredByOne.size === 0) {
  fail(`${REGISTRY} declares no channel, no operation or no command: the check has lost what it reads`);
}

/** The string literals of `text`, each with what stands before and after it. */
function literals(text) {
  return [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => ({
    value: match[1],
    before: text.slice(0, match.index),
    after: text.slice(match.index + match[0].length),
  }));
}

/** A roster as its source declares it: the length its type states, and what its body holds. */
function roster(source, name) {
  const found = new RegExp(`\\bconst ${name}: \\[&str; (\\d+)\\] = \\[([^\\]]*)\\];`).exec(source);
  if (!found) return null;
  const [, length, body] = found;
  return {
    length: Number(length),
    channels: literals(body).map((literal) => literal.value),
    beside: body.replace(/"(?:[^"\\]|\\.)*"/g, '').replace(/[\s,]/g, ''),
  };
}

/** Every channel `source` dispatches on. */
function dispatched(source) {
  return new Set(
    literals(source)
      .filter(({ before, after }) => /^\s*(?:=>|\|(?!\|)|==)/.test(after) || /==\s*$/.test(before))
      .map((literal) => literal.value),
  );
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
    if (stated.beside !== '') fail(`${service.name}'s ${name} holds ${stated.beside}, which is no string literal: the check reads literals`);
    if (stated.channels.length !== stated.length) fail(`${service.name}'s ${name} states ${stated.length} channels and the check reads ${stated.channels.length}`);
    for (const channel of stated.channels) {
      if (named.has(channel)) fail(`${service.name} names ${channel} twice, in ${named.get(channel)} and in ${name}`);
      named.set(channel, name);
    }
  }
  answered.set(service, named);

  for (const [channel, name] of named) {
    if (!declared.has(channel)) fail(`${service.name}'s ${name} names ${channel}, which ${REGISTRY} does not declare`);
    else if (inProcess.has(channel)) fail(`${service.name}'s ${name} names ${channel}, which is in-process: no service is sent it`);
    else if (requestOf.has(channel)) fail(`${service.name}'s ${name} names ${channel}, a reply to ${requestOf.get(channel)}: it is sent to the client that asked, and to no service`);
    if (!protocol.includes(`\`${channel}\``)) fail(`${service.name}'s ${name} names ${channel}, which ${service.protocol} does not`);
  }

  const dispatch = dispatched(source);
  for (const channel of dispatch) {
    if (!declared.has(channel)) fail(`${service.source} dispatches on ${channel}, which ${REGISTRY} does not declare`);
    if (!named.has(channel)) fail(`${service.source} dispatches on ${channel}, which no roster of ${service.name} names: its frames never arrive`);
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

if (failures.length > 0) {
  for (const message of failures) console.error(`✗ ${message}`);
  process.exit(1);
}
const counts = SERVICES.map((service) => `${service.name} ${answered.get(service).size}`).join(', ');
console.log(`✓ the channels each service answers are declared by the bus registry, and its rosters, its dispatch and its protocol document name the same ones (${counts})`);
