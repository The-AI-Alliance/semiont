#!/usr/bin/env node
// generate-go.mjs — generate the Go bus authority from
// specs/src/bus/registry.json, the same file the TypeScript generator reads.
//
//   packages/sdk-go/bus/channels_gen.go   channel constants + payload metadata
//   packages/sdk-go/bus/operations_gen.go the request→{result,failure,progress} map
//
// Payload STRUCTS are not generated here: the OpenAPI schemas a channel
// carries already have Go types in packages/sdk-go/client_gen.go. What Go
// needs from the registry is the vocabulary — which channels exist, which
// schema each carries, and which triples form a request/reply operation.
//
// Channels whose payload is TypeScript-only (DOM geometry, callbacks) are
// EXCLUDED: they never cross the wire, so a Go constant for them would be an
// invitation to emit something the backend will reject.
//
// --check diffs without writing (the CI drift gate).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REGISTRY = resolve(ROOT, 'specs/src/bus/registry.json');
const OUT_DIR = resolve(ROOT, 'packages/sdk-go/bus');
const CHECK = process.argv.includes('--check');

const reg = JSON.parse(readFileSync(REGISTRY, 'utf8'));

/** TS-only payloads: functions or DOM geometry — never wire vocabulary. */
const TS_ONLY = /=>|AnchorRect/;
const wireChannels = reg.channels.filter((c) => !(c.shape === 'custom' && TS_ONLY.test(c.ts)));
const skipped = reg.channels.length - wireChannels.length;

/** `mark:assist-timeout` → `MarkAssistTimeout` */
const goName = (channel) =>
  channel
    .split(/[:\-]/)
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : ''))
    .join('');

const BANNER = `// Code generated from specs/src/bus/registry.json — DO NOT EDIT.
//
// Regenerate: node scripts/bus/generate-go.mjs
// The TypeScript side (packages/core/src/bus-protocol.ts) generates from the
// same registry, so the two languages cannot drift apart by hand.
`;

// ── channels_gen.go ────────────────────────────────────────────────────
const channelLines = wireChannels.map((c) => {
  const doc = c.validate
    ? `payload: ${c.validate}`
    : c.shape === 'storedEvent'
      ? `payload: StoredEvent(${c.event}) — not emittable`
      : c.shape === 'void'
        ? 'no payload — not emittable'
        : 'not emittable (no registered schema)';
  return `\t// ${doc}\n\t${goName(c.channel)} Channel = ${JSON.stringify(c.channel)}`;
});

/** gofmt aligns map values to the longest key in a contiguous block; emit
 *  that alignment directly so generated output is gofmt-clean and the drift
 *  gate never fights the formatter. */
function alignRows(pairs) {
  const width = Math.max(...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `\t${k}${' '.repeat(width - k.length)} ${v},`);
}

const emittable = wireChannels.filter((c) => c.validate);
const schemaRows = alignRows(emittable.map((c) => [`${goName(c.channel)}:`, JSON.stringify(c.validate)]));

const channelsGo = `${BANNER}
package bus

// Channel is a bus channel name. Only channels the backend will accept on
// /bus/emit have an entry in ChannelSchemas; emitting anything else is a
// client bug the server rejects.
type Channel string

const (
${channelLines.join('\n\n')}
)

// ChannelSchemas maps an emittable channel to the OpenAPI schema name its
// payload must satisfy — the same mapping the backend validates against.
// A channel absent from this map is not emittable.
var ChannelSchemas = map[Channel]string{
${schemaRows.join('\n')}
}

// Emittable reports whether the backend accepts this channel on /bus/emit.
func (c Channel) Emittable() bool {
\t_, ok := ChannelSchemas[c]
\treturn ok
}
`;

// ── operations_gen.go ──────────────────────────────────────────────────
const opRows = alignRows(
  reg.operations.map((o) => {
    const progress = o.progress ? `, Progress: ${JSON.stringify(o.progress)}` : '';
    return [
      `${JSON.stringify(o.request)}:`,
      `{Result: ${JSON.stringify(o.result)}, Failure: ${JSON.stringify(o.failure)}${progress}}`,
    ];
  }),
);

const operationsGo = `${BANNER}
package bus

// Operation is one request/reply pair: emit the request channel with a
// correlationId, then take the first matching Result or Failure. Progress is
// set for streaming operations, which emit intermediate events under the same
// correlationId before the terminal reply.
type Operation struct {
\tResult   Channel
\tFailure  Channel
\tProgress Channel // "" when the operation is not streaming
}

// Operations is the request→reply registry: ${reg.operations.length} operations.
var Operations = map[Channel]Operation{
${opRows.join('\n')}
}

// Streaming reports whether this operation emits progress events before its
// terminal reply.
func (o Operation) Streaming() bool { return o.Progress != "" }
`;

mkdirSync(OUT_DIR, { recursive: true });
let drift = 0;
for (const [name, text] of [
  ['channels_gen.go', channelsGo],
  ['operations_gen.go', operationsGo],
]) {
  const path = resolve(OUT_DIR, name);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (current === text) {
    console.log(`ok    packages/sdk-go/bus/${name}`);
    continue;
  }
  drift++;
  console.log(`${current ? 'DRIFT' : 'new  '} packages/sdk-go/bus/${name}`);
  if (!CHECK) writeFileSync(path, text);
}
console.log(
  `channels: ${wireChannels.length} wire (${skipped} TS-only excluded), emittable: ${emittable.length}, operations: ${reg.operations.length}`,
);
if (CHECK && drift) process.exit(1);
