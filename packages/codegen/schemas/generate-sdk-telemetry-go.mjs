#!/usr/bin/env node
// Generate the Go SDK's telemetry table from
// specs/src/sdk-telemetry/telemetry.json: every span its transports export,
// by name and kind, every metric, by name and meaning, and every attribute
// key the rows carry.
//
//   packages/go/sdk/telemetry_gen.go
//
// The reading of the table is sdk-telemetry-table.mjs's, shared with the
// Python generator. The output is committed; `--check` compares without
// writing (the CI drift gate).

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeOrCheck } from '../lib/committed-source.mjs';
import { goComment } from '../lib/go-source.mjs';
import { CHANNEL, readSdkTelemetry } from './sdk-telemetry-table.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TABLE = resolve(ROOT, 'specs/src/sdk-telemetry/telemetry.json');
const OUT = resolve(ROOT, 'packages/go/sdk/telemetry_gen.go');
const CHECK = process.argv.includes('--check');

function refuse(message) {
  console.error(`✗ ${TABLE}: ${message}`);
  process.exit(1);
}

const table = readSdkTelemetry(TABLE, refuse);

/** OTLP's span kinds, as OpenTelemetry's Go API names them. */
const SPAN_KIND = {
  internal: 'trace.SpanKindInternal',
  server: 'trace.SpanKindServer',
  client: 'trace.SpanKindClient',
  producer: 'trace.SpanKindProducer',
  consumer: 'trace.SpanKindConsumer',
};

/** A dotted, underscored name as an unexported Go identifier behind `prefix`: `content.size_bytes` is `keyContentSizeBytes`. */
const identifier = (prefix, name) =>
  prefix +
  name
    .replace(`:${CHANNEL}`, '')
    .split(/[._]/)
    .map((word) => (word === 'id' ? 'ID' : word[0].toUpperCase() + word.slice(1)))
    .join('');

const spans = table.spans.map((row) => ({ ...row, identifier: identifier('span', row.name) }));
const metrics = table.metrics.map((row) => ({ ...row, identifier: identifier('metric', row.name) }));
const keys = [...new Set([...table.spans, ...table.metrics].flatMap((row) => row.all))].sort().map((key) => ({ key, identifier: identifier('key', key) }));

const identifiers = [...spans, ...metrics, ...keys].map((row) => row.identifier);
if (new Set(identifiers).size !== identifiers.length) refuse('two of its names would be the same Go identifier');

const text = `// Code generated from specs/src/sdk-telemetry/telemetry.json — DO NOT EDIT.
//
// Regenerate: node packages/codegen/schemas/generate-sdk-telemetry-go.mjs
// The Python table is generated from the same table.

package semiont

import (
\t"go.opentelemetry.io/otel/attribute"
\t"go.opentelemetry.io/otel/trace"
)

// telemetryChannel stands for the bus channel in a span's name.
const telemetryChannel = ${JSON.stringify(CHANNEL)}

// telemetrySpan is a span the SDK's transports export: its name, in which
// telemetryChannel stands for the bus channel, and its kind.
type telemetrySpan struct {
\tname string
\tkind trace.SpanKind
}

// telemetryMetric is a metric the SDK's transports export: its name, and
// what it means, which is its description.
type telemetryMetric struct {
\tname    string
\tmeaning string
}

${spans.map((row) => `${goComment(row.meaning)}\nvar ${row.identifier} = telemetrySpan{name: ${JSON.stringify(row.name)}, kind: ${SPAN_KIND[row.kind]}}\n`).join('\n')}
${metrics.map((row) => `${goComment(`${row.meaning} A ${row.instrument}.`)}\nvar ${row.identifier} = telemetryMetric{name: ${JSON.stringify(row.name)}, meaning: ${JSON.stringify(row.meaning)}}\n`).join('\n')}
// The attributes the rows carry.

${keys.map(({ key, identifier: name }) => `const ${name} attribute.Key = ${JSON.stringify(key)}`).join('\n')}
`;

writeOrCheck(ROOT, OUT, text, CHECK);
