#!/usr/bin/env node
// lint:spec-reply-bounds — how large each answer on the bus can be.
//
// A bus message is bounded by its question; an answer whose size follows a
// document or a collection is read over HTTP. specs/src/bus/reply-bounds.json
// names each list or map an operation's reply carries that its own schema does
// not bound: one bounded by a member of the request, or one that grows.
//
// It fails when:
//   - a reply carries a list or map with no `maxItems` or `maxProperties` that
//     the table does not name: a new answer that can outgrow the bus;
//   - the table names a list a reply no longer carries, or one its schema now
//     bounds, or an operation the registry does not have;
//   - an entry says neither `by` nor `grows`, or both; a `by` names no member
//     of the request, or one that is neither an array nor an integer with a
//     `maximum`; a `grows` says with nothing.
//
// The lists inside a resource's descriptor or an annotation are the record's,
// bounded by the write that made them, and are not walked.
//
// It reads the source files, so it cannot pass on a stale bundle.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(import.meta.url), '../../..');
const SCHEMAS = resolve(REPO, 'specs/src/components/schemas');
const RECORD = ['ResourceDescriptor.json', 'Annotation.json'];

const load = (file) => JSON.parse(readFileSync(file, 'utf8'));
const registry = load(resolve(REPO, 'specs/src/bus/registry.json'));
const table = load(resolve(REPO, 'specs/src/bus/reply-bounds.json')).replies;
const channels = new Map(registry.channels.map((entry) => [entry.channel, entry]));

const failures = [];
const fail = (message) => failures.push(message);

/** Every list and map `node` carries, by its path, walking objects and stopping at the record's schemas. */
function collections(node, file, path, found, seen) {
  if (node.$ref) {
    const target = resolve(dirname(file), node.$ref.split('#')[0]);
    if (seen.has(target) || RECORD.some((name) => target.endsWith(`/${name}`))) return;
    collections(load(target), target, path, found, new Set([...seen, target]));
    return;
  }
  for (const key of ['allOf', 'oneOf', 'anyOf']) for (const branch of node[key] ?? []) collections(branch, file, path, found, seen);
  if (node.type === 'array' || node.items) {
    found.set(path, node.maxItems !== undefined);
    return;
  }
  if (typeof node.additionalProperties === 'object') found.set(path, node.maxProperties !== undefined);
  for (const [name, member] of Object.entries(node.properties ?? {})) collections(member, file, path ? `${path}.${name}` : name, found, seen);
}

/** The member `name` of the request schema `schema`, its $refs and allOf followed. */
function member(schema, name) {
  const file = resolve(SCHEMAS, `${schema}.json`);
  const found = load(file).properties?.[name];
  if (found === undefined) return undefined;
  if (found.$ref) return load(resolve(SCHEMAS, found.$ref));
  return found;
}

const operations = new Set(registry.operations.map((operation) => operation.request));
for (const request of Object.keys(table)) {
  if (!operations.has(request)) fail(`reply-bounds.json names ${request}, which is no operation of the registry`);
}

for (const { request, result } of registry.operations) {
  const reply = channels.get(result);
  const entries = table[request] ?? {};
  const found = new Map();
  if (reply.shape === 'schema') {
    const file = resolve(SCHEMAS, `${reply.schema}.json`);
    collections(load(file), file, '', found, new Set([file]));
  }
  for (const [path, bounded] of found) {
    if (!bounded && !(path in entries)) fail(`${result} carries ${path}, a list with no bound that reply-bounds.json does not name: bound it in its schema, or say what bounds it`);
  }
  for (const [path, entry] of Object.entries(entries)) {
    if (!found.has(path)) fail(`reply-bounds.json names ${path} of ${result}, which it does not carry`);
    else if (found.get(path)) fail(`reply-bounds.json names ${path} of ${result}, which its schema bounds`);
    const by = entry.by;
    const grows = entry.grows;
    if ((by === undefined) === (grows === undefined)) fail(`${request} ${path}: an entry says \`by\` or \`grows\`, one of them`);
    if (grows !== undefined && (typeof grows !== 'string' || !grows.startsWith('with '))) fail(`${request} ${path}: \`grows\` says with what`);
    if (by !== undefined) {
      const asked = member(channels.get(request).schema, by);
      if (asked === undefined) fail(`${request} ${path} is bounded by ${by}, which is no member of its request`);
      else if (!(asked.type === 'array' || (asked.type === 'integer' && asked.maximum !== undefined))) fail(`${request} ${path} is bounded by ${by}, which is neither an array nor an integer with a maximum`);
    }
  }
}

if (failures.length > 0) {
  console.error(`lint:spec-reply-bounds: ${failures.length} failure(s):\n${failures.map((line) => `  - ${line}`).join('\n')}`);
  process.exit(1);
}
console.log(`lint:spec-reply-bounds: ${registry.operations.length} operations' replies are bounded or named.`);
