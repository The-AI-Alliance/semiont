#!/usr/bin/env node
// unfreeze-preamble.mjs — ONE-SHOT migration (kept for provenance).
//
// The first extraction froze everything outside the two maps into opaque
// `protocolBetween` / `protocolFooter` strings. That made the generated file
// contain hand-edit zones with no home: RESOURCE_BROADCAST_TYPES is the
// documented extension point for resource-scoped broadcasts, and editing it
// in the generated file is silently reverted by the next generate.
//
// This splits that blob into its parts:
//   DATA      → registry fields (resourceBroadcasts.channels, the doc prose)
//   TEMPLATE  → the generator (derived types: EventName, ResourceBroadcastType,
//               EmittableChannel, and the `satisfies` tails)
//   HAND-CODE → packages/core/src/bus-ui-types.ts (AnchorRect), imported and
//               re-exported by the generated file so consumers are unaffected.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REGISTRY = resolve(ROOT, 'specs/src/bus/registry.json');
const UI_TYPES = resolve(ROOT, 'packages/core/src/bus-ui-types.ts');

const reg = JSON.parse(readFileSync(REGISTRY, 'utf8'));
const { protocolHeader, protocolBetween, protocolFooter } = reg.preamble;

// ── 1. AnchorRect out of the header, into its own hand-written module ──
const anchorStart = protocolHeader.indexOf('/**\n * Viewport-space rectangle');
const anchorEnd = protocolHeader.indexOf('}\n', protocolHeader.indexOf('export interface AnchorRect')) + 2;
if (anchorStart < 0) throw new Error('AnchorRect block not found in header');
const anchorBlock = protocolHeader.slice(anchorStart, anchorEnd);

writeFileSync(
  UI_TYPES,
  `// Hand-written companion to the GENERATED bus-protocol.ts.
//
// Runtime-only types that ride UI channels and cannot live in the bus
// registry: they are TypeScript shapes (DOM geometry, callbacks), not wire
// vocabulary, so no OpenAPI schema describes them and no other language
// needs them. bus-protocol.ts imports and re-exports these, so consumers
// keep importing from @semiont/core exactly as before.

${anchorBlock}`,
);

// The header keeps its prose and imports, minus AnchorRect, plus the import
// the generated file now needs.
let header = protocolHeader.slice(0, anchorStart) + protocolHeader.slice(anchorEnd);
header = header.replace(
  "import type { EventOfType } from './persisted-events';",
  "import type { EventOfType } from './persisted-events';\nimport type { AnchorRect } from './bus-ui-types';",
);
header = header.replace(/\n{3,}(?=export type EventMap)/, '\n\n');

// ── 2. Split the between-blob into doc prose + broadcast data ───────────
const grab = (src, from, to) => src.slice(src.indexOf(from), to ? src.indexOf(to) : undefined);

const eventNameDoc = grab(protocolBetween, '/**\n * Any valid channel name', 'export type EventName').trimEnd();
const broadcastDoc = grab(protocolBetween, '/**\n * Genuine resource-bound', 'export const RESOURCE_BROADCAST_TYPES').trimEnd();
const channelSchemasDoc = grab(protocolBetween, '/**\n * Authoritative map from bus channel').trimEnd();

// The body of RESOURCE_BROADCAST_TYPES: today only an explanatory comment
// (the list is deliberately empty). Channels go in `channels`; the comment
// travels with them as prose that explains WHY it is empty.
const bodyStart = protocolBetween.indexOf('export const RESOURCE_BROADCAST_TYPES = [') + 'export const RESOURCE_BROADCAST_TYPES = ['.length;
const bodyEnd = protocolBetween.indexOf('] as const satisfies readonly EventName[];');
const rawBody = protocolBetween.slice(bodyStart, bodyEnd);
const channels = [...rawBody.matchAll(/^\s*'([^']+)',/gm)].map((m) => m[1]);
const bodyComment = rawBody
  .split('\n')
  .filter((l) => l.trim().startsWith('//'))
  .join('\n');

const emittableDoc = grab(protocolFooter, '/** Channels where', 'export type EmittableChannel').trimEnd();

reg.preamble = {
  protocolHeader: header,
  eventMapTail: reg.preamble.eventMapTail,
  schemasTail: reg.preamble.schemasTail,
  operationsHeader: reg.preamble.operationsHeader,
  operationsInnerTail: reg.preamble.operationsInnerTail,
  operationsFooter: reg.preamble.operationsFooter,
};
reg.docs = { eventName: eventNameDoc, resourceBroadcasts: broadcastDoc, channelSchemas: channelSchemasDoc, emittableChannel: emittableDoc };
reg.resourceBroadcasts = { channels, bodyComment };

writeFileSync(REGISTRY, JSON.stringify(reg, null, 2) + '\n');
console.log(`wrote ${UI_TYPES.replace(ROOT + '/', '')} (AnchorRect)`);
console.log(`resourceBroadcasts.channels: ${JSON.stringify(channels)}`);
console.log('registry: protocolBetween/protocolFooter replaced by docs + resourceBroadcasts');
