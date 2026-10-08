#!/usr/bin/env node
/**
 * lint:event-tags — what a component's documentation says it emits and
 * subscribes to, held to the bus registry.
 *
 * A component documents its events in tags: `@emits <channel> - <what it is>.
 * Payload: <payload>`, and `@subscribes` likewise. The channel and the payload
 * restate the registry (specs/src/bus/registry.json) and the schema it names
 * for the channel, and nothing compiles a comment.
 *
 * It fails when a tag
 *   - names a channel the registry does not declare;
 *   - states a payload in a form this check does not read. It reads
 *     `undefined`, the name of a schema, and an object's members in braces;
 *   - says `undefined` of a channel that carries something, or states a
 *     payload for one that carries nothing;
 *   - names a schema that is not the channel's;
 *   - writes in braces a member the channel's payload does not have, leaves
 *     out one it requires, or marks optional one it requires.
 *
 * A payload's members are its schema's, those of the schema's `allOf` among
 * them, and the ones the registry's `tsRefinement` adds as `… & { … }`:
 * `browse:click` carries `anchorRect?` beside its schema.
 *
 * What is held is the names of a payload's members, not their types, and
 * what a tag says, not what its component does. A tag that states no payload
 * is held to its channel alone.
 *
 * Scanned: the TypeScript of packages/react-ui and apps/browser, comments
 * included, since a tag is one. Not scanned: tests.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryFiles } from './repository-files.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REGISTRY = 'specs/src/bus/registry.json';
const SCHEMAS = 'specs/src/components/schemas';
const SCANNED = ['packages/react-ui/src/', 'apps/browser/src/'];
const SOURCE = /\.(ts|tsx|mts|cts)$/;
const TEST = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?tsx?$/;

const failures = [];
const fail = (message) => failures.push(message);

const registry = JSON.parse(readFileSync(resolve(ROOT, REGISTRY), 'utf8'));
const channels = new Map(registry.channels.map((channel) => [channel.channel, channel]));
if (channels.size === 0) fail(`${REGISTRY} declares no channel: the check has lost what it reads`);

/** The members of an object as written in braces or in a schema: each by its name, and whether it must be there. */
function written(members) {
  const named = new Map();
  for (const member of members) {
    const [, name, optional] = /^\s*([A-Za-z_$][\w$]*)(\?)?\s*(?::|$)/.exec(member) ?? [];
    if (name === undefined) return null;
    named.set(name, optional === undefined);
  }
  return named;
}

/** The parts of the braces `text` opens with, split where no bracket encloses a comma or a semicolon. Null when they do not close. */
function parts(text) {
  const found = [];
  let part = '';
  for (let at = 0, depth = 0; at < text.length; at++) {
    const char = text[at];
    if ('([{'.includes(char) && depth++ === 0) continue;
    if (')]}'.includes(char) && --depth === 0) return [...found, part].filter((each) => each.trim() !== '');
    if (depth === 1 && (char === ',' || char === ';')) { found.push(part); part = ''; } else part += char;
  }
  return null;
}

/** The members of a schema, with those of every schema its `allOf` takes in. */
function membersOf(schema) {
  const members = new Map();
  const take = (node) => {
    for (const name of Object.keys(node.properties ?? {})) members.set(name, (node.required ?? []).includes(name) || members.get(name) === true);
    for (const part of node.allOf ?? []) take(part.$ref === undefined ? part : JSON.parse(readFileSync(resolve(ROOT, SCHEMAS, part.$ref), 'utf8')));
  };
  take(schema);
  return members;
}

/**
 * What a channel carries: nothing, or a schema's members with whatever the
 * registry's refinement adds to them. Null where this check does not read it:
 * a channel that carries neither, or a refinement that is no `… & { … }` and
 * no type the protocol's header declares by name.
 */
function payloadOf(channel) {
  if (channel.shape === 'void') return { nothing: true };
  if (channel.shape !== 'schema') return null;
  const members = membersOf(JSON.parse(readFileSync(resolve(ROOT, SCHEMAS, `${channel.schema}.json`), 'utf8')));
  if (channel.tsRefinement !== undefined && !/^\w+$/.test(channel.tsRefinement)) {
    const [, refined, added] = /^components\['schemas'\]\['(\w+)'\] & (\{[^{}]*\})$/.exec(channel.tsRefinement) ?? [];
    const more = refined === channel.schema ? written(parts(added) ?? ['']) : null;
    if (more === null) return null;
    for (const [name, required] of more) members.set(name, required);
  }
  return { schema: channel.schema, members };
}

/** Every tag of `text`, whole: a tag runs to the next one or to the end of its comment. */
function tagsOf(text) {
  const tags = [];
  const lines = text.split('\n');
  for (let at = 0; at < lines.length; at++) {
    const [, kind, channel, rest] = /^\s*\*\s*@(emits|subscribes)\s+(\S+)(.*)$/.exec(lines[at]) ?? [];
    if (kind === undefined) continue;
    let said = rest;
    for (let next = at + 1; next < lines.length; next++) {
      const [, more] = /^\s*\*(?!\/)\s?(.*)$/.exec(lines[next]) ?? [];
      if (more === undefined || more.trimStart().startsWith('@')) break;
      said += ` ${more.trim()}`;
    }
    tags.push({ line: at + 1, kind, channel, payload: /\bPayload:\s*(.*)$/.exec(said)?.[1] });
  }
  return tags;
}

let tags = 0;
const files = repositoryFiles(ROOT).filter((file) => SCANNED.some((prefix) => file.startsWith(prefix)) && SOURCE.test(file) && !TEST.test(file));
for (const file of files) {
  for (const { line, kind, channel, payload } of tagsOf(readFileSync(resolve(ROOT, file), 'utf8'))) {
    tags++;
    const at = `${file}:${line} @${kind} ${channel}`;
    const declared = channels.get(channel);
    if (declared === undefined) { fail(`${at}: ${REGISTRY} declares no such channel`); continue; }
    if (payload === undefined) continue;
    const carried = payloadOf(declared);
    if (/^undefined\b/.test(payload)) {
      if (carried?.nothing !== true) fail(`${at}: says its payload is undefined, and the channel carries ${declared.schema ?? `a payload (${declared.shape})`}`);
      continue;
    }
    if (carried === null) { fail(`${at}: states a payload, and what the channel carries (${declared.shape}${declared.tsRefinement === undefined ? '' : ', refined'}) is not something this check reads`); continue; }
    if (carried.nothing === true) { fail(`${at}: states a payload, and the channel carries nothing`); continue; }
    const named = /^([A-Z]\w*)/.exec(payload)?.[1];
    if (named !== undefined) {
      if (named !== carried.schema) fail(`${at}: names ${named} as its payload, and the channel carries ${carried.schema}`);
      continue;
    }
    const stated = payload.startsWith('{') ? written(parts(payload) ?? ['']) : null;
    if (stated === null) { fail(`${at}: states its payload in a form this check does not read: it reads undefined, a schema's name, and members in braces`); continue; }
    for (const [name, required] of stated) {
      if (!carried.members.has(name)) fail(`${at}: writes ${name} in its payload, which ${carried.schema} does not have`);
      else if (!required && carried.members.get(name)) fail(`${at}: marks ${name} optional, which ${carried.schema} requires`);
    }
    for (const [name, required] of carried.members) {
      if (required && !stated.has(name)) fail(`${at}: leaves ${name} out of its payload, which ${carried.schema} requires`);
    }
  }
}
if (tags === 0) fail(`no @emits or @subscribes tag under ${SCANNED.join(' or ')}: the check has lost what it reads`);

if (failures.length > 0) {
  for (const message of failures) console.error(`✗ ${message}`);
  process.exit(1);
}
console.log(`✓ lint:event-tags — ${tags} tags name channels the registry declares, and each payload one states is its channel's`);
