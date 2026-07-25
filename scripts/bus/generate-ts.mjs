#!/usr/bin/env node
// generate-ts.mjs — regenerate the TypeScript bus authority from
// specs/src/bus/registry.json.
//
//   packages/core/src/bus-protocol.ts   (EventMap + CHANNEL_SCHEMAS)
//   packages/core/src/bus-operations.ts (BUS_OPERATIONS)
//
// Byte-identical output is the CUTOVER PROOF: regenerate over the committed
// files and `git diff` must be empty, which is what makes "the extraction was
// faithful" a demonstration rather than a claim. Run with --check to diff
// without writing (the CI drift gate).

import { validateRegistry } from './validate-registry.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REGISTRY = resolve(ROOT, 'specs/src/bus/registry.json');
const PROTOCOL = resolve(ROOT, 'packages/core/src/bus-protocol.ts');
const BRIDGED = resolve(ROOT, 'packages/core/src/bridged-channels.ts');
const OPERATIONS = resolve(ROOT, 'packages/core/src/bus-operations.ts');

const CHECK = process.argv.includes('--check');
const reg = JSON.parse(readFileSync(REGISTRY, 'utf8'));

// Source-level invariants BEFORE anything is emitted: no generated artifact
// may come from a registry that breaks the bus's cross-list rules.
validateRegistry(reg);
const byChannel = new Map(reg.channels.map((c) => [c.channel, c]));

/** Pad `head` out to `col`; a head that overflows gets a single space —
 *  the convention the hand-written files already follow.
 *
 *  The generator NORMALIZES alignment. The committed file is column 38
 *  everywhere except 8 FRAME entries a human aligned to 39 — an
 *  inconsistency, not a rule, and preserving it would mean carrying
 *  formatting cruft in the authority. Those 8 lines shift by one space at
 *  cutover; `--check` proves the CONTENT is untouched. */
const pad = (head, col) => head + (head.length < col ? ' '.repeat(col - head.length) : ' ');

/** Generated files must say so — the whole point of an authority is that
 *  nobody hand-edits its output and wonders why it reverted. */
const BANNER = `// ⚠ GENERATED FILE — do not edit.
//
// Authority:   specs/src/bus/registry.json  (channels, payloads, operations)
// Regenerate:  node scripts/bus/generate-ts.mjs
// Go counterpart: node scripts/bus/generate-go.mjs → packages/sdk-go/bus
//
// Payload schemas themselves live in the OpenAPI components; the registry
// names which one each channel carries. Add or change a channel THERE.

`;

const VALUE_COL_SCHEMAS = 38;
const VALUE_COL_OPS = 41;
const FAILURE_COL_OPS = 85;

function emitLines(entries, format) {
  const out = [];
  for (const e of entries) {
    out.push(...e.lead);
    out.push(format(e));
  }
  return out;
}

// ── bus-protocol.ts ────────────────────────────────────────────────────
/** A channel named in an order list but missing from `channels` means the
 *  registry is corrupt; say so instead of dying on `undefined.docs`. */
function channelOr(ch, where) {
  const c = byChannel.get(ch);
  if (!c) throw new Error(`registry: channelOrder.${where} names "${ch}", which is missing from channels[]`);
  return c;
}

const eventMapLines = emitLines(
  reg.channelOrder.eventMap.map((ch) => {
    const c = channelOr(ch, 'eventMap');
    return { ...c, lead: c.docs.lead, trailing: c.docs.trailing };
  }),
  (e) => `  '${e.channel}': ${e.ts};${e.trailing ? ` ${e.trailing}` : ''}`,
);

const schemaLines = emitLines(
  reg.channelOrder.schemas.map((ch) => {
    const c = channelOr(ch, 'schemas');
    return { ...c, lead: c.schemaDocs.lead, trailing: c.schemaDocs.trailing };
  }),
  (e) =>
    pad(`  '${e.channel}':`, VALUE_COL_SCHEMAS) +
    (e.validate === null ? 'null' : `'${e.validate}'`) +
    ',' +
    (e.trailing ? ` ${e.trailing}` : ''),
);

// The sections between the two maps are TEMPLATE (derived types and the
// `satisfies` tails the generator owns) plus DATA and PROSE from the registry
// — never an opaque frozen blob, which is what made the generated file
// contain hand-edit zones that silently reverted.
const broadcastBody = [
  reg.resourceBroadcasts.bodyComment,
  ...reg.resourceBroadcasts.channels.map((c) => `  '${c}',`),
]
  .filter(Boolean)
  .join('\n');

const protocol =
  BANNER +
  reg.preamble.protocolHeader +
  'export type EventMap = {' +
  [...eventMapLines, ...reg.preamble.eventMapTail].join('\n') +
  '\n};\n\n' +
  // AnchorRect and friends live in the hand-written companion module; the
  // re-export keeps every existing `from './bus-protocol'` import working.
  "export type { AnchorRect } from './bus-ui-types';\n\n" +
  reg.docs.eventName +
  '\nexport type EventName = keyof EventMap;\n\n' +
  reg.docs.resourceBroadcasts +
  '\nexport const RESOURCE_BROADCAST_TYPES = [\n' +
  broadcastBody +
  '\n] as const satisfies readonly EventName[];\n\n' +
  'export type ResourceBroadcastType = typeof RESOURCE_BROADCAST_TYPES[number];\n\n' +
  reg.docs.channelSchemas +
  '\nexport const CHANNEL_SCHEMAS = {' +
  [...schemaLines, ...reg.preamble.schemasTail].join('\n') +
  "\n} as const satisfies Record<EventName, keyof components['schemas'] | null>;\n\n" +
  reg.docs.emittableChannel +
  '\nexport type EmittableChannel = {\n' +
  '  [K in EventName]: typeof CHANNEL_SCHEMAS[K] extends null ? never : K\n' +
  '}[EventName];\n';

// ── bus-operations.ts ──────────────────────────────────────────────────
const opsLines = emitLines(
  reg.operations.map((o) => ({ ...o, lead: o.docs.lead, trailing: o.docs.trailing })),
  (o) => {
    // Absolute columns: pad the WHOLE prefix to the failure column, not the
    // result segment on its own.
    const head = pad(pad(`  '${o.request}':`, VALUE_COL_OPS) + `{ result: '${o.result}',`, FAILURE_COL_OPS);
    const rest = `failure: '${o.failure}'` + (o.progress ? `, progress: '${o.progress}'` : '') + ' },';
    return head + rest + (o.trailing ? ` ${o.trailing}` : '');
  },
);

const operations =
  BANNER +
  reg.preamble.operationsHeader +
  'export const BUS_OPERATIONS = {' +
  [...opsLines, ...reg.preamble.operationsInnerTail].join('\n') +
  '\n}' +
  reg.preamble.operationsFooter;

// ── bridged-channels.ts ────────────────────────────────────────────────
// The broadcast LIST is registry data (it is protocol vocabulary, and Go
// needs it too — `semiont listen` subscribes to exactly this set). The
// derivation below it is template: it never varies with the data, it just
// composes the operations' reply channels with the broadcasts.
const bridged =
  BANNER +
  reg.preamble.bridgedHeader +
  reg.bridgedBroadcasts.doc +
  '\nexport const BRIDGED_BROADCASTS = [\n' +
  reg.bridgedBroadcasts.channels.map((c) => `  '${c}',`).join('\n') +
  '\n] as const satisfies readonly EventName[];\n\n' +
  reg.preamble.bridgedDerivation;

const outputs = [
  [PROTOCOL, protocol],
  [OPERATIONS, operations],
  [BRIDGED, bridged],
];

// Alignment-insensitive comparison: the proof that matters is that no
// CONTENT changed. Whitespace normalization is reported separately so a
// cutover diff can never hide a semantic change.
const squash = (s) => s.replace(BANNER, '').replace(/':[ ]+/g, "': ").replace(/,[ ]+failure:/g, ', failure:');

let drift = 0;
for (const [path, text] of outputs) {
  const current = readFileSync(path, 'utf8');
  if (current === text) {
    console.log(`ok    ${path.replace(ROOT + '/', '')}`);
    continue;
  }
  if (squash(current) === squash(text)) {
    const n = current.split('\n').filter((l, i) => l !== text.split('\n')[i]).length;
    console.log(`ok    ${path.replace(ROOT + '/', '')} — content identical, ${n} line(s) realigned`);
    if (!CHECK) writeFileSync(path, text);
    continue;
  }
  drift++;
  const a = current.split('\n');
  const b = text.split('\n');
  console.log(`DRIFT ${path.replace(ROOT + '/', '')}  (${a.length} → ${b.length} lines)`);
  for (let i = 0, shown = 0; i < Math.max(a.length, b.length) && shown < 6; i++) {
    if (a[i] !== b[i]) {
      console.log(`  line ${i + 1}\n    committed: ${JSON.stringify(a[i])}\n    generated: ${JSON.stringify(b[i])}`);
      shown++;
    }
  }
  if (!CHECK) writeFileSync(path, text);
}
if (CHECK && drift) process.exit(1);
console.log(CHECK ? 'check complete' : drift ? 'files rewritten' : 'no changes');
