#!/usr/bin/env node
// generate-python.mjs — generate the Python SDK's bus vocabulary from
// specs/src/bus/registry.json, the same file the TypeScript and Go generators
// read.
//
//   packages/sdk-python/src/semiont/channels.py    every channel, typed by its payload
//   packages/sdk-python/src/semiont/operations.py  every request, with its two replies
//
// A channel's payload type is DERIVED from its shape, as the TypeScript
// generator derives it: the registry states the payload once, in a form every
// language reads. The payload classes themselves are the OpenAPI schemas',
// generated into semiont/types.py.
//
// --check compares without writing (the CI drift gate).

import { validateRegistry, validateRegistryFormat } from './validate-registry.mjs';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeOrCheck } from '../spec/committed-source.mjs';
import { pyBanner, pyConstant, pyString } from '../spec/python-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REGISTRY = resolve(ROOT, 'specs/src/bus/registry.json');
const OUT_DIR = resolve(ROOT, 'packages/sdk-python/src/semiont');
const CHECK = process.argv.includes('--check');

const registryText = readFileSync(REGISTRY, 'utf8');
validateRegistryFormat(registryText);
const reg = JSON.parse(registryText);
validateRegistry(reg);

const SCRIPT = 'scripts/bus/generate-python.mjs';

/** The Python type of a channel's payload, and the schemas it names. */
function payloadOf(c) {
  switch (c.shape) {
    case 'schema':
      return { type: c.schema, names: [c.schema] };
    case 'envelope':
      return { type: `Response[${c.schema}]`, names: [c.schema] };
    case 'storedEvent': {
      const event = c.enriched === true ? 'EnrichedResourceEvent' : 'StoredEventResponse';
      return { type: event, names: [event] };
    }
    case 'void':
    case 'empty':
      return { type: 'Empty', names: [] };
    default:
      throw new Error(`registry: "${c.channel}" has no payload type for shape ${JSON.stringify(c.shape)}`);
  }
}

const constants = new Map();
for (const c of reg.channels) {
  const constant = pyConstant(c.channel);
  if (constants.has(constant)) {
    throw new Error(`registry: "${c.channel}" and "${constants.get(constant)}" would both be the Python constant ${constant}`);
  }
  constants.set(constant, c.channel);
}

const payloads = reg.channels.map((c) => ({ channel: c.channel, constant: pyConstant(c.channel), ...payloadOf(c) }));

// What a client hears with no scope held, unless it names a narrower list:
// every operation's two replies, then the events sent to every client. And what
// holding a resource adds. A channel in both would be delivered twice.
const bridged = [...reg.operations.flatMap((o) => [o.result, o.failure]), ...reg.audience.everyone];
const scoped = reg.audience.scoped;
const twice = scoped.find((channel) => bridged.includes(channel));
if (twice !== undefined) {
  throw new Error(`registry: "${twice}" is delivered both globally and per scope: a client would be given it twice`);
}
const names = (channels) => channels.map((channel) => `    ${pyString(channel)},`).join('\n');
const schemaNames = [...new Set(payloads.flatMap((p) => p.names))].sort();

const channelsPy = `${pyBanner('specs/src/bus/registry.json', SCRIPT)}
"""Every channel of the bus, typed by the payload it carries.

A constant names its channel and holds its payload's type, so a function that
takes a \`Channel[P]\` and a \`P\` is refused another channel's payload by a type
checker. The payload types are the protocol's own (\`semiont.types\`); which
belongs to which channel is the registry's to say, and is derived here from
each channel's shape.

A channel a resource's scope carries is a \`ScopedChannel[P]\`, by the
registry's \`audience\`: it is read for a resource, and a type checker refuses
a read of one that names none.
"""

from collections.abc import Mapping
from types import MappingProxyType
from typing import Final, Literal

from semiont.channel import AnyChannel, Channel, Empty, Response, ScopedChannel
from semiont.types import (
${schemaNames.map((name) => `    ${name},`).join('\n')}
)

__all__ = [
    "BRIDGED_CHANNELS",
    "CHANNELS",
    "CHANNEL_NAMES",
    "RESOURCE_SCOPED_CHANNELS",
${payloads
  .map((p) => p.constant)
  .sort()
  .map((name) => `    ${pyString(name)},`)
  .join('\n')}
    "ChannelName",
]

# Every channel's name.
type ChannelName = Literal[
${reg.channels.map((c) => `    ${pyString(c.channel)},`).join('\n')}
]

CHANNEL_NAMES: Final[tuple[ChannelName, ...]] = (
${reg.channels.map((c) => `    ${pyString(c.channel)},`).join('\n')}
)

${payloads.map((p) => `${p.constant}: Final = ${scoped.includes(p.channel) ? 'ScopedChannel' : 'Channel'}[${p.type}](${pyString(p.channel)}, ${p.type})`).join('\n')}

# Every channel, by its name: for code that is given a name and not a constant.
CHANNELS: Final[Mapping[str, AnyChannel]] = MappingProxyType(
    {
${payloads.map((p) => `        ${pyString(p.channel)}: ${p.constant},`).join('\n')}
    }
)

# The channels a client hears with no scope held, unless it names a narrower list: every
# operation's result and failure, and the events sent to every client.
BRIDGED_CHANNELS: Final[tuple[ChannelName, ...]] = (
${names(bridged)}
)

# The channels a resource's scope carries: what holding a resource adds to a client's stream.
RESOURCE_SCOPED_CHANNELS: Final[tuple[ChannelName, ...]] = (
${names(scoped)}
)
`;

const byChannel = new Map(payloads.map((p) => [p.channel, p]));
const operation = (o) =>
  `${pyConstant(o.request)}: Final = Operation(\n    request=channels.${byChannel.get(o.request).constant},\n    result=channels.${byChannel.get(o.result).constant},\n    failure=channels.${byChannel.get(o.failure).constant},\n)`;

// Every limits operation asks and answers the same, which is what lets one caller ask them all.
const limitsOperations = reg.operations.filter((o) => o.request.endsWith(':limits-requested'));
const shapeOf = (o) => [o.request, o.result, o.failure].map((channel) => byChannel.get(channel).type).join(' / ');
if (limitsOperations.length === 0) throw new Error('registry: no operation is named <flow>:limits-requested');
if (new Set(limitsOperations.map(shapeOf)).size !== 1) {
  throw new Error(`registry: the limits operations do not all ask and answer the same: ${limitsOperations.map((o) => `${o.request} (${shapeOf(o)})`).join('; ')}`);
}

const operationsPy = `${pyBanner('specs/src/bus/registry.json', SCRIPT)}
"""Every request of the bus, with the two channels it is answered on.

An operation is named for its request channel. Its type says what is sent and
what a reply carries, so a request is refused another operation's payload, and
its answer is typed, by a type checker.
"""

from collections.abc import Mapping
from types import MappingProxyType
from typing import Final

from semiont import channels
from semiont.channel import AnyOperation, Operation

__all__ = [
    "LIMITS_OPERATIONS",
    "OPERATIONS",
${reg.operations
  .map((o) => pyConstant(o.request))
  .sort()
  .map((name) => `    ${pyString(name)},`)
  .join('\n')}
]

${reg.operations.map(operation).join('\n')}

# Every operation, by the name of its request channel: for code that is given a name and not a constant.
OPERATIONS: Final[Mapping[str, AnyOperation]] = MappingProxyType(
    {
${reg.operations.map((o) => `        ${pyString(o.request)}: ${pyConstant(o.request)},`).join('\n')}
    }
)

# The operations that report the limits of the models a service holds credentials for: one per
# such service, each named \`<flow>:limits-requested\`. A new key holder's joins by being registered.
LIMITS_OPERATIONS: Final = (
${limitsOperations.map((o) => `    ${pyConstant(o.request)},`).join('\n')}
)
`;

writeOrCheck(ROOT, resolve(OUT_DIR, 'channels.py'), channelsPy, CHECK);
writeOrCheck(ROOT, resolve(OUT_DIR, 'operations.py'), operationsPy, CHECK);
if (!CHECK) console.log(`channels: ${reg.channels.length}, operations: ${reg.operations.length}`);
