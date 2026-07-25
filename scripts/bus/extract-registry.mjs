#!/usr/bin/env node
// extract-registry.mjs — ONE-SHOT migration tool (kept for provenance).
//
// Reads today's hand-written bus authority:
//   packages/core/src/bus-protocol.ts   (EventMap + CHANNEL_SCHEMAS)
//   packages/core/src/bus-operations.ts (BUS_OPERATIONS)
// and emits the language-neutral registry:
//   specs/src/bus/registry.json
//
// Comments are captured VERBATIM (banners, per-entry prose, trailing notes):
// this file carries a decade of hard-won rationale, and a migration that drops
// it is a migration that loses the institutional knowledge. The generators
// replay them, so the regenerated TS can be diffed against the original —
// the existing file is the golden, the extraction is proven, not asserted.
//
// Payload classification: `shape` is the neutral fact both languages use;
// `ts` is the verbatim TypeScript expression, needed only where the payload
// narrows OpenAPI types in ways JSON cannot express (Omit<>, branded
// interfaces, UI-only function types). Go types the neutral shapes and treats
// the rest as raw JSON.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PROTOCOL = resolve(ROOT, 'packages/core/src/bus-protocol.ts');
const OPERATIONS = resolve(ROOT, 'packages/core/src/bus-operations.ts');
const OUT = resolve(ROOT, 'specs/src/bus/registry.json');

const SCHEMA_RE = /^components\['schemas'\]\['(\w+)'\]$/;
const STORED_RE = /^StoredEvent<EventOfType<'([^']+)'>>$/;
const ENVELOPE_RE = /^\{ correlationId: string; response: components\['schemas'\]\['(\w+)'\] \}$/;
const CORR_RE = /^\{ correlationId: string \} & components\['schemas'\]\['(\w+)'\]$/;

/** The neutral classification both generators consume. */
function classify(ts) {
  const t = ts.trim();
  let m;
  if (t === 'void') return { shape: 'void' };
  if ((m = t.match(SCHEMA_RE))) return { shape: 'schema', schema: m[1] };
  if ((m = t.match(STORED_RE))) return { shape: 'storedEvent', event: m[1] };
  if ((m = t.match(ENVELOPE_RE))) return { shape: 'envelope', schema: m[1] };
  if ((m = t.match(CORR_RE))) return { shape: 'corrIntersect', schema: m[1] };
  // Everything else keeps its TS verbatim and is opaque to Go (inline objects,
  // Omit<> narrowings, UI-only types carrying functions or DOM geometry).
  return { shape: 'custom' };
}

/** Slice `body` of a `name = {` … `\n}` block, preserving inner text. */
function blockOf(src, opener) {
  const start = src.indexOf(opener);
  if (start < 0) throw new Error(`not found: ${opener}`);
  const from = start + opener.length;
  const end = src.indexOf('\n}', from);
  return src.slice(from, end);
}

/**
 * Walk a map body line by line, accumulating comment blocks and blank lines so
 * the generator can replay the file's exact texture. Entries may span lines;
 * an entry ends at the `;`/`,` that closes it at depth 0.
 */
function parseEntries(body, terminator) {
  const lines = body.split('\n');
  const out = [];
  let lead = []; // comment/blank lines preceding the next entry
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^(\s*)'([^']+)':\s*(.*)$/);
    if (!m) {
      lead.push(line);
      continue;
    }
    const [, indent, channel] = m;
    // Trailing `// …` must not count toward depth or hide the terminator —
    // `'yield:created': null, // StoredEvent` ends the entry despite the note.
    const code = (s) => s.replace(/\/\/.*$/, '');
    let rest = code(m[3]);
    const depthOf = (s) => (s.match(/[{<[(]/g) || []).length - (s.match(/[}>\])]/g) || []).length;
    let depth = depthOf(rest);
    const raw = [line];
    while (depth > 0 || !rest.trimEnd().endsWith(terminator)) {
      i++;
      if (i >= lines.length) break;
      const next = lines[i];
      raw.push(next);
      rest = code(next);
      depth += depthOf(rest);
    }
    // Value = everything after the colon, minus the terminator and any
    // trailing comment (kept separately so the generator can replay it).
    let value = raw.join('\n').slice(raw[0].indexOf(`'${channel}':`) + channel.length + 3);
    let trailing = '';
    const cm = value.match(/(\s*\/\/.*)$/);
    if (cm) {
      trailing = cm[1].trim();
      value = value.slice(0, cm.index);
    }
    value = value.trim().replace(new RegExp(`\\${terminator}$`), '').trim();
    // lead is an ARRAY of verbatim lines: '' would be ambiguous between "no
    // preceding lines" and "one blank line", and that ambiguity shows up as a
    // whitespace diff in the round-trip proof.
    out.push({ channel, value, indent, lead, trailing });
    lead = [];
  }
  return { entries: out, tail: lead };
}

const protocolSrc = readFileSync(PROTOCOL, 'utf8');
const operationsSrc = readFileSync(OPERATIONS, 'utf8');

const eventMap = parseEntries(blockOf(protocolSrc, 'export type EventMap = {'), ';');
const schemas = parseEntries(blockOf(protocolSrc, 'export const CHANNEL_SCHEMAS = {'), ',');
const ops = parseEntries(blockOf(operationsSrc, 'export const BUS_OPERATIONS = {'), ',');

const schemaByChannel = new Map(schemas.entries.map((e) => [e.channel, e]));
if (eventMap.entries.length !== schemas.entries.length) {
  throw new Error(`EventMap ${eventMap.entries.length} vs CHANNEL_SCHEMAS ${schemas.entries.length}`);
}

const channels = eventMap.entries.map((e) => {
  const cs = schemaByChannel.get(e.channel);
  if (!cs) throw new Error(`channel missing from CHANNEL_SCHEMAS: ${e.channel}`);
  const validate = cs.value === 'null' ? null : cs.value.replace(/^'|'$/g, '');
  return {
    channel: e.channel,
    ...classify(e.value),
    // The runtime-validated schema name, or null. Non-null ⇒ EmittableChannel.
    validate,
    ts: e.value,
    docs: { lead: e.lead, trailing: e.trailing },
    schemaDocs: { lead: cs.lead, trailing: cs.trailing },
  };
});

const operations = ops.entries.map((e) => {
  const obj = {};
  for (const [, k, v] of e.value.matchAll(/(\w+):\s*'([^']+)'/g)) obj[k] = v;
  return { request: e.channel, ...obj, docs: { lead: e.lead, trailing: e.trailing } };
});

const registry = {
  $comment:
    'AUTHORITY for the Semiont event bus: channels, their payloads, and the ' +
    'request/reply operations. TypeScript (packages/core) and Go ' +
    '(packages/sdk-go) are BOTH generated from this file — edit here, then ' +
    'run the generators. Payload schemas themselves live in the OpenAPI ' +
    'components; `validate` names the one a channel carries on the wire.',
  channelOrder: { eventMap: eventMap.entries.map((e) => e.channel), schemas: schemas.entries.map((e) => e.channel) },
  channels,
  operations,
  // Verbatim file texture the generators replay, so regenerated TS can be
  // diffed against the original rather than merely "looking right".
  preamble: {
    protocolHeader: protocolSrc.slice(0, protocolSrc.indexOf('export type EventMap = {')),
    protocolBetween: protocolSrc.slice(
      protocolSrc.indexOf('\n}', protocolSrc.indexOf('export type EventMap = {')) + 2,
      protocolSrc.indexOf('export const CHANNEL_SCHEMAS = {'),
    ),
    protocolFooter: protocolSrc.slice(
      protocolSrc.indexOf('\n}', protocolSrc.indexOf('export const CHANNEL_SCHEMAS = {')) + 2,
    ),
    eventMapTail: eventMap.tail,
    schemasTail: schemas.tail,
    operationsHeader: operationsSrc.slice(0, operationsSrc.indexOf('export const BUS_OPERATIONS = {')),
    operationsInnerTail: ops.tail,
    operationsFooter: operationsSrc.slice(
      operationsSrc.indexOf('\n}', operationsSrc.indexOf('export const BUS_OPERATIONS = {')) + 2,
    ),
  },
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(registry, null, 2) + '\n');

const byShape = channels.reduce((a, c) => ((a[c.shape] = (a[c.shape] || 0) + 1), a), {});
console.log(`channels: ${channels.length}`, byShape);
console.log(`operations: ${operations.length}`);
console.log(`emittable (validated): ${channels.filter((c) => c.validate).length}`);
console.log(`wrote ${OUT}`);
