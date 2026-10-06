#!/usr/bin/env node
// Generate the Python SDK's telemetry table from
// specs/src/sdk-telemetry/telemetry.json: every span and metric its transports
// export, by name, kind and the attributes each carries.
//
//   packages/sdk-python/src/semiont/telemetry_table.py
//
// The output is committed; `--check` compares without writing (the CI drift
// gate).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeOrCheck } from './committed-source.mjs';
import { pyBanner, pyComment, pyConstant, pyString } from './python-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TABLE = resolve(ROOT, 'specs/src/sdk-telemetry/telemetry.json');
const OUT = resolve(ROOT, 'packages/sdk-python/src/semiont/telemetry_table.py');
const CHECK = process.argv.includes('--check');

/** OTLP's span kinds, and the one instrument the table states. */
const SPAN_KINDS = ['internal', 'server', 'client', 'producer', 'consumer'];
const INSTRUMENTS = ['counter'];
/** What stands for the bus channel in a span's name. */
const CHANNEL = '{channel}';

function refuse(message) {
  console.error(`✗ ${TABLE}: ${message}`);
  process.exit(1);
}

const table = JSON.parse(readFileSync(TABLE, 'utf8'));
if (!Array.isArray(table.spans) || !Array.isArray(table.metrics)) refuse('it states no spans, or no metrics');

function attributesOf(row) {
  if (typeof row.name !== 'string' || row.name === '') refuse('a row has no name');
  if (typeof row.meaning !== 'string' || row.meaning === '') refuse(`${row.name} does not say what it means`);
  if (!Array.isArray(row.attributes)) refuse(`${row.name} lists no attributes`);
  const keys = row.attributes.map((attribute) => {
    if (typeof attribute.key !== 'string' || attribute.key === '') refuse(`${row.name} has an attribute with no key`);
    return attribute.key;
  });
  if (new Set(keys).size !== keys.length) refuse(`${row.name} lists an attribute twice`);
  return { all: keys, always: row.attributes.filter((attribute) => attribute.only === undefined).map((attribute) => attribute.key) };
}

/** The name of a row's constant: its name, without what stands for the channel. */
const constantOf = (name) => pyConstant(name.replace(`:${CHANNEL}`, ''));

const spans = table.spans.map((row) => {
  const { all, always } = attributesOf(row);
  if (!SPAN_KINDS.includes(row.kind)) refuse(`${row.name} is of kind ${JSON.stringify(row.kind)}, which is not one of OTLP's`);
  if (row.name.replace(CHANNEL, '').includes('{')) refuse(`${row.name} has a placeholder this script does not know`);
  return { name: row.name, kind: row.kind, meaning: row.meaning, all, always, constant: constantOf(row.name) };
});
const metrics = table.metrics.map((row) => {
  const { all, always } = attributesOf(row);
  if (!INSTRUMENTS.includes(row.instrument)) refuse(`${row.name} is a ${JSON.stringify(row.instrument)}, which this script does not know`);
  return { name: row.name, instrument: row.instrument, meaning: row.meaning, all, always, constant: constantOf(row.name) };
});

const constants = [...spans, ...metrics].map((row) => row.constant);
if (new Set(constants).size !== constants.length) refuse('two rows would be the same Python constant');

const tuple = (keys) => (keys.length === 1 ? `(${pyString(keys[0])},)` : `(${keys.map(pyString).join(', ')})`);
const literal = (values) => `Literal[${[...new Set(values)].sort().map(pyString).join(', ')}]`;

const text = `${pyBanner('specs/src/sdk-telemetry/telemetry.json', 'scripts/spec/generate-sdk-telemetry-python.mjs')}
"""The telemetry a Semiont SDK's transports export, when the process they run
in exports at all: every span and metric, its kind, and the attributes it
carries.

The table is every SDK's: the conformance suite holds each to it from outside.
A span's name may hold \`${CHANNEL}\`, which stands for the bus channel.
"""

from dataclasses import dataclass
from typing import Final, Literal, final

__all__ = [
${['METRICS', 'SPANS', 'Instrument', 'MetricRow', 'SpanKindName', 'SpanRow', ...constants].sort().map((name) => `    ${pyString(name)},`).join('\n')}
]

# The kinds of span the table states, by OTLP's names for them.
type SpanKindName = ${literal(spans.map((row) => row.kind))}

# The instruments the table states.
type Instrument = ${literal(metrics.map((row) => row.instrument))}


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class SpanRow:
    """A span an SDK exports."""

    name: str
    kind: SpanKindName
    attributes: tuple[str, ...]
    """Every attribute it may carry. It carries no other."""
    always: tuple[str, ...]
    """The attributes every one of them carries."""


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class MetricRow:
    """A metric an SDK exports."""

    name: str
    instrument: Instrument
    attributes: tuple[str, ...]
    """Every attribute a data point of it may carry. It carries no other."""
    always: tuple[str, ...]
    """The attributes every data point of it carries."""


${spans
  .map(
    (row) =>
      `${pyComment(row.meaning)}\n${row.constant}: Final = SpanRow(\n    name=${pyString(row.name)},\n    kind=${pyString(row.kind)},\n    attributes=${tuple(row.all)},\n    always=${tuple(row.always)},\n)\n`,
  )
  .join('\n')}
${metrics
  .map(
    (row) =>
      `${pyComment(row.meaning)}\n${row.constant}: Final = MetricRow(\n    name=${pyString(row.name)},\n    instrument=${pyString(row.instrument)},\n    attributes=${tuple(row.all)},\n    always=${tuple(row.always)},\n)\n`,
  )
  .join('\n')}
SPANS: Final[tuple[SpanRow, ...]] = (
${spans.map((row) => `    ${row.constant},`).join('\n')}
)

METRICS: Final[tuple[MetricRow, ...]] = (
${metrics.map((row) => `    ${row.constant},`).join('\n')}
)
`;

writeOrCheck(ROOT, OUT, text, CHECK);
