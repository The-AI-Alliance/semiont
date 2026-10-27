#!/usr/bin/env node
// generate-go.mjs — generate the Go SDK's bus vocabulary from
// specs/src/bus/registry.json, the same file the TypeScript and Python
// generators read.
//
//   packages/sdk-go/bus/channels_gen.go   every channel, typed by its payload, and the field a
//                                         relayed frame's trace rides in
//   packages/sdk-go/bus/operations_gen.go every request, typed, with its two replies; and the
//                                         replies of each by name, with what each result
//                                         states beside its response
//   packages/sdk-go/bus/bridged_gen.go    the channels bridged to every client, and those a
//                                         resource's scope carries
//
// A channel's payload type is DERIVED from its shape, as the TypeScript and
// Python generators derive it: the registry states the payload once, in a
// form every language reads. The payload types themselves are the OpenAPI
// schemas', generated into packages/sdk-go/api/client_gen.go. The typed
// values are of the kinds packages/sdk-go/bus/typed.go declares.
//
// --check diffs without writing (the CI drift gate).

import { validateRegistry, validateRegistryFormat } from './validate-registry.mjs';
import { goComment } from '../spec/go-source.mjs';
import { replyNames } from './reply-names.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REGISTRY = resolve(ROOT, 'specs/src/bus/registry.json');
const OUT_DIR = resolve(ROOT, 'packages/sdk-go/bus');
const SCHEMAS = resolve(ROOT, 'specs/src/components/schemas');
const CHECK = process.argv.includes('--check');

const registryText = readFileSync(REGISTRY, 'utf8');

// Source-level invariants BEFORE anything is emitted: no generated artifact
// may come from a registry that breaks the bus's cross-list rules — or that
// was re-encoded on its way through an editor.
validateRegistryFormat(registryText);
const reg = JSON.parse(registryText);
validateRegistry(reg);

/** `mark:delegate-timeout` → `MarkDelegateTimeout` */
const goName = (channel) =>
  channel
    .split(/[:\-]/)
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : ''))
    .join('');

const names = new Map();
for (const c of reg.channels) {
  const name = goName(c.channel);
  if (names.has(name)) throw new Error(`registry: "${c.channel}" and "${names.get(name)}" would both be the Go name ${name}`);
  names.set(name, c.channel);
}

const BANNER = `// Code generated from specs/src/bus/registry.json — DO NOT EDIT.
//
// Regenerate: node scripts/bus/generate-go.mjs
`;

/** gofmt aligns a run of rows to its longest first cell; emit that alignment
 *  directly so generated output is gofmt-clean and the drift gate never fights
 *  the formatter. */
function alignRows(pairs) {
  const width = Math.max(...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `\t${k}${' '.repeat(width - k.length)} ${v}`);
}

/** The Go type of a channel's payload, and for a stored event the type of the event's own payload. */
function payloadOf(c) {
  switch (c.shape) {
    case 'schema':
      return { type: `api.${c.schema}` };
    case 'envelope':
      return { type: `Response[api.${c.schema}]` };
    case 'storedEvent':
      return { type: c.enriched === true ? 'api.EnrichedResourceEvent' : 'api.StoredEventResponse', recorded: `api.${c.payload}` };
    case 'void':
    case 'empty':
      return { type: 'Empty' };
    default:
      throw new Error(`registry: "${c.channel}" has no payload type for shape ${JSON.stringify(c.shape)}`);
  }
}

const byChannel = new Map(reg.channels.map((c) => [c.channel, c]));
const scoped = new Set(reg.audience.scoped);
const requested = new Set(reg.operations.map((o) => o.request));

/** A channel's typed value: what it carries, and whether it is emitted, read for a resource, or of the record. */
function valueOf(c) {
  const { type, recorded } = payloadOf(c);
  // A scoped channel is a stored event: validate-registry.mjs refuses one that is not.
  if (recorded !== undefined) return `${scoped.has(c.channel) ? 'Scoped' : 'Recorded'}[${type}, ${recorded}]`;
  return `${c.validate ? 'Emittable' : 'Of'}[${type}]`;
}

// ── channels_gen.go ────────────────────────────────────────────────────
// An operation's request channel is the operation's value, under the
// channel's name (operations_gen.go).
const channelRows = alignRows(
  reg.channels.filter((c) => !requested.has(c.channel)).map((c) => [goName(c.channel), `= ${valueOf(c)}{${JSON.stringify(c.channel)}}`]),
);

const channelsGo = `${BANNER}
package bus

import "github.com/The-AI-Alliance/semiont/packages/sdk-go/api"

// Channel is a bus channel's name: what a channel chosen at run time is
// given as, and what each typed value below is named by.
type Channel string

// Every channel that is no operation's request, typed by the payload it
// carries. An operation's request is the operation (operations_gen.go).
var (
${channelRows.join('\n')}
)

${goComment(reg.trace.meaning)}
const TraceField = ${JSON.stringify(reg.trace.field)}
`;

// ── operations_gen.go ──────────────────────────────────────────────────
for (const o of reg.operations) {
  if (!byChannel.get(o.request).validate) {
    throw new Error(`registry: "${o.request}" is an operation's request the gateway does not accept on /bus/emit: it could never be asked`);
  }
}
const typeOf = (channel) => payloadOf(byChannel.get(channel)).type;
const operationRows = alignRows(
  reg.operations.map((o) => [
    goName(o.request),
    `= Operation[${typeOf(o.request)}, ${typeOf(o.result)}, ${typeOf(o.failure)}]{${[o.request, o.result, o.failure].map((c) => JSON.stringify(c)).join(', ')}}`,
  ]),
);
// Every limits operation asks and answers the same, which is what lets one caller ask them all.
const limitsOperations = reg.operations.filter((o) => o.request.endsWith(':limits-requested'));
const shapeOf = (o) => [o.request, o.result, o.failure].map(typeOf).join(', ');
if (limitsOperations.length === 0) throw new Error('registry: no operation is named <flow>:limits-requested');
if (new Set(limitsOperations.map(shapeOf)).size !== 1) {
  throw new Error(`registry: the limits operations do not all ask and answer the same: ${limitsOperations.map((o) => `${o.request} (${shapeOf(o)})`).join('; ')}`);
}

// What a result states beside its response is READ from the component schema
// the registry says it carries (reply-names.mjs, the derivation every
// generator shares), never listed.
const namedBy = replyNames(reg, (name) => JSON.parse(readFileSync(resolve(SCHEMAS, `${name}.json`), 'utf8')));
const restated = (o) => {
  const named = namedBy.get(o.request);
  return named.length === 0 ? '' : `, ReplyNames: []string{${named.map((name) => JSON.stringify(name)).join(', ')}}`;
};
const repliesRows = alignRows(
  reg.operations.map((o) => [`${JSON.stringify(o.request)}:`, `{Result: ${JSON.stringify(o.result)}, Failure: ${JSON.stringify(o.failure)}${restated(o)}},`]),
);

const operationsGo = `${BANNER}
package bus

import "github.com/The-AI-Alliance/semiont/packages/sdk-go/api"

// Every operation, named for its request channel and typed by what it sends
// and what each of its replies carries.
var (
${operationRows.join('\n')}
)

// LimitsOperations is the operations that report the limits of the models a
// service holds credentials for: one per such service, each named
// <flow>:limits-requested. A new key holder's joins by being registered.
var LimitsOperations = []Operation[${shapeOf(limitsOperations[0])}]{
${limitsOperations.map((o) => `\t${goName(o.request)},`).join('\n')}
}

// Replies is the two channels a request is answered on, and what its result
// states beside its response.
type Replies struct {
\tResult  Channel
\tFailure Channel
\t// ReplyNames is what the result states beside its response: properties of
\t// the request, which whoever answers states again (the resource a context
\t// was gathered for, the reference a search was for). None, for most.
\tReplyNames []string
}

// Operations is each operation's replies, by the name of its request
// channel: for a request named at run time. ${reg.operations.length} operations.
var Operations = map[Channel]Replies{
${repliesRows.join('\n')}
}
`;

// ── bridged_gen.go ─────────────────────────────────────────────────────
// Only these can be received over a transport. `semiont listen` defaults to
// the broadcasts; the full set adds every operation's reply channels, which
// are derived here exactly as the TypeScript side derives them.
const listed = (channels) => channels.map((c) => `\t${JSON.stringify(c)},`).join('\n');

const bridgedGo = `${BANNER}
package bus

// BridgedBroadcasts: channels with no owning operation — job lifecycle, KB
// vocabulary changes, attention signals, SSE infrastructure. These are what a
// client subscribes to when it wants to watch a KB rather than await a reply.
var BridgedBroadcasts = []Channel{
${listed(reg.audience.everyone)}
}

// BridgedChannels: everything a transport delivers — the broadcasts plus
// every operation's reply channels. Derived from Operations, so a reply can
// never be missing from the set (the recurring unbridged-reply bug).
var BridgedChannels = func() []Channel {
\tout := append([]Channel(nil), BridgedBroadcasts...)
\tfor _, op := range Operations {
\t\tout = append(out, op.Result, op.Failure)
\t}
\treturn out
}()

// Bridged reports whether a channel can be received over a transport at all.
// Subscribing to anything else delivers nothing, silently — the trap the bus
// docs warn about.
func Bridged(c Channel) bool {
\tfor _, b := range BridgedChannels {
\t\tif b == c {
\t\t\treturn true
\t\t}
\t}
\treturn false
}

// ResourceScopedChannels: the channels a resource's scope carries, which a
// client holding the scope names in that scope's entry of its subscription.
// Disjoint from BridgedChannels: a channel in both would reach a client twice,
// under two ids.
var ResourceScopedChannels = []Channel{
${listed(reg.audience.scoped)}
}

// PersistedEventTypes: the channels of the events of the record, each named
// for the event it carries: every event the event log holds. A follower of the
// record receives each of them (docs/protocol/TRANSPORT-CONTRACT.md § What
// repairs a passing frame).
var PersistedEventTypes = []Channel{
${listed(reg.channels.filter((c) => c.event).map((c) => c.channel))}
}
`;

mkdirSync(OUT_DIR, { recursive: true });
let drift = 0;
for (const [name, text] of [
  ['channels_gen.go', channelsGo],
  ['operations_gen.go', operationsGo],
  ['bridged_gen.go', bridgedGo],
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
  `channels: ${reg.channels.length}, emittable: ${reg.channels.filter((c) => c.validate).length}, operations: ${reg.operations.length}`,
);
if (CHECK && drift) process.exit(1);
