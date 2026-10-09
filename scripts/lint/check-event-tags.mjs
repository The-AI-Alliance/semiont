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
 * A tag belongs to the declaration its comment documents, and is held to
 * that declaration's code and to no other's: a function, a component or a
 * constant declared at the top level of its file. It fails when
 *   - a declaration sends on a channel its own comment has no `@emits` tag
 *     for. A channel the registry calls a read needs none;
 *   - an `@emits` tag names a channel its declaration does not send on: the
 *     code it describes is somewhere else;
 *   - a tag is in a comment that documents no declaration, or a send stands
 *     outside every declaration.
 *
 * What a declaration sends on is read from it as written: an emit of its
 * own, `.emit('<channel>', …)`, and a call of a method of the SDK's client,
 * `….<namespace>.<method>(…)`, whatever holds the client. Which channel a
 * method sends on is read from the SDK (packages/sdk/src/namespaces), from
 * the method's own body: where it emits on the client's bus or its
 * transport, or makes a request.
 *
 * A payload's members are its schema's, those of the schema's `allOf` among
 * them, and the ones the registry's `tsRefinement` adds as `… & { … }`:
 * `browse:click` carries `anchorRect?` beside its schema.
 *
 * What is held is the names of a payload's members, not their types. A tag
 * that states no payload is held to its channel alone. A send made through
 * anything but the client's own namespaces, a state unit's or a child
 * component's, is not read; nor is one a client method makes outside its own
 * body. And nothing holds a subscription to a `@subscribes` tag.
 *
 * Scanned: the TypeScript of packages/react-ui and apps/browser, comments
 * included, since a tag is one. Not scanned: tests.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryFiles } from './repository-files.mjs';
import { withoutComments } from './source-text.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REGISTRY = 'specs/src/bus/registry.json';
const SCHEMAS = 'specs/src/components/schemas';
const CLIENT = 'packages/sdk/src/client.ts';
const NAMESPACES = 'packages/sdk/src/namespaces';
const SCANNED = ['packages/react-ui/src/', 'apps/browser/src/'];
const SOURCE = /\.(ts|tsx|mts|cts)$/;
const TEST = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?tsx?$/;

const failures = [];
const fail = (message) => failures.push(message);

const registry = JSON.parse(readFileSync(resolve(ROOT, REGISTRY), 'utf8'));
const channels = new Map(registry.channels.map((channel) => [channel.channel, channel]));
const reads = new Set(registry.effect.reads);
if (channels.size === 0 || reads.size === 0) fail(`${REGISTRY} declares no channel or no read: the check has lost what it reads`);

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

const DECLARATION = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;

/** The declarations at the top level of a file, each by its name and the line it begins on. Each runs to the next. */
const declarationsOf = (lines) => lines.flatMap((line, at) => (DECLARATION.test(line) ? [{ name: DECLARATION.exec(line)[1], at }] : []));

/**
 * Every tag of a file, whole: a tag runs to the next one or to the end of its
 * comment. Each with the declaration its comment documents: the one that
 * begins on the first line after the comment that is not blank.
 */
function tagsOf(lines, declarations) {
  const tags = [];
  for (let at = 0; at < lines.length; at++) {
    const [, kind, channel, rest] = /^\s*\*\s*@(emits|subscribes)\s+(\S+)(.*)$/.exec(lines[at]) ?? [];
    if (kind === undefined) continue;
    let said = rest;
    for (let next = at + 1; next < lines.length; next++) {
      const [, more] = /^\s*\*(?!\/)\s?(.*)$/.exec(lines[next]) ?? [];
      if (more === undefined || more.trimStart().startsWith('@')) break;
      said += ` ${more.trim()}`;
    }
    let after = lines.findIndex((line, index) => index >= at && line.includes('*/')) + 1;
    while (after < lines.length && lines[after].trim() === '') after++;
    tags.push({ line: at + 1, kind, channel, payload: /\bPayload:\s*(.*)$/.exec(said)?.[1], documents: declarations.find((declaration) => declaration.at === after) });
  }
  return tags;
}

/** Where the bracket that opens at `open` closes. */
function closing(code, open) {
  let depth = 0;
  for (let at = open; at < code.length; at++) {
    if ('([{'.includes(code[at])) depth++;
    else if (')]}'.includes(code[at]) && --depth === 0) return at;
  }
  return -1;
}

const SEND = "(?:this\\.(?:bus|transport)\\.emit\\(|\\bbusRequest\\(\\s*(?:this\\.)?transport,)\\s*'([a-z]+:[a-z-]+)'";

/**
 * The channels each method of the SDK's client sends on, by `<namespace>.<method>`:
 * the ones its own body names where it emits or makes a request.
 */
function sentByClient() {
  const sent = new Map();
  const namespaces = [...readFileSync(resolve(ROOT, CLIENT), 'utf8').matchAll(/^\s*public readonly (\w+): \w+Namespace\b/gm)].map((declared) => declared[1]);
  if (namespaces.length === 0) fail(`${CLIENT} declares no namespace: the check has lost what it reads`);
  for (const namespace of namespaces) {
    const code = withoutComments(readFileSync(resolve(ROOT, NAMESPACES, `${namespace}.ts`), 'utf8'));
    let read = 0;
    for (const method of code.matchAll(/^  (?:async )?(?!constructor\b)(\w+)(?:<[^>]*>)?\(/gm)) {
      // The body opens with the brace that ends the signature's line: a return type may hold braces of its own.
      const opens = /\{[ \t]*\n/g;
      opens.lastIndex = closing(code, method.index + method[0].length - 1);
      const body = opens.exec(code)?.index ?? code.length;
      const named = [...code.slice(body, closing(code, body) + 1).matchAll(new RegExp(SEND, 'g'))].map((site) => site[1]);
      read += named.filter((channel) => !reads.has(channel)).length;
      if (named.length > 0) sent.set(`${namespace}.${method[1]}`, new Set(named));
    }
    // A read may be made where no method's body names it: a constructor wires the fetch of a cached one.
    const all = [...code.matchAll(new RegExp(SEND, 'g'))].filter((site) => !reads.has(site[1])).length;
    if (read !== all) fail(`${NAMESPACES}/${namespace}.ts sends on a channel that is no read, outside the methods this check reads: it has lost what it reads`);
  }
  return sent;
}
const sentBy = sentByClient();
if (sentBy.size === 0) fail(`no method of the SDK's client sends on a channel: the check has lost what it reads`);
const CALL = new RegExp(`\\.\\s*(${[...new Set([...sentBy.keys()].map((method) => method.split('.')[0]))].join('|')})\\s*\\??\\.\\s*(\\w+)\\s*\\(`, 'g');

let tags = 0;
const files = repositoryFiles(ROOT).filter((file) => SCANNED.some((prefix) => file.startsWith(prefix)) && SOURCE.test(file) && !TEST.test(file));
for (const file of files) {
  const text = readFileSync(resolve(ROOT, file), 'utf8');
  const declarations = declarationsOf(text.split('\n'));
  const found = tagsOf(text.split('\n'), declarations);

  // What each declaration sends on, and how: the declaration a send is in is the last to begin before it.
  const code = withoutComments(text);
  const sent = new Map(declarations.map((declaration) => [declaration, new Map()]));
  const send = (index, channel, how) => {
    const line = code.slice(0, index).split('\n').length - 1;
    const declaration = declarations.findLast((each) => each.at <= line);
    if (declaration === undefined) fail(`${file}:${line + 1}: sends on ${channel}, through ${how}, outside every declaration`);
    else sent.get(declaration).set(channel, how);
  };
  for (const call of code.matchAll(CALL)) {
    for (const channel of sentBy.get(`${call[1]}.${call[2]}`) ?? []) send(call.index, channel, `${call[1]}.${call[2]}()`);
  }
  for (const emit of code.matchAll(/\.emit\(\s*'([a-z]+:[a-z-]+)'/g)) send(emit.index, emit[1], 'an emit of its own');

  for (const [declaration, channels] of sent) {
    const tagged = new Set(found.filter((tag) => tag.kind === 'emits' && tag.documents === declaration).map((tag) => tag.channel));
    for (const [channel, how] of channels) {
      if (!reads.has(channel) && !tagged.has(channel)) fail(`${file}:${declaration.at + 1} ${declaration.name}: sends on ${channel}, through ${how}, and its own comment has no @emits tag for it`);
    }
  }
  for (const tag of found) {
    if (tag.documents === undefined) fail(`${file}:${tag.line} @${tag.kind} ${tag.channel}: is in a comment that documents no declaration`);
    else if (tag.kind === 'emits' && !sent.get(tag.documents).has(tag.channel)) fail(`${file}:${tag.line} @emits ${tag.channel}: ${tag.documents.name} does not send on it: the code this tag describes is somewhere else`);
  }

  for (const { line, kind, channel, payload } of found) {
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
console.log(`✓ lint:event-tags — ${tags} tags name channels the registry declares, each payload one states is its channel's, and each @emits tag is on the declaration that sends`);
