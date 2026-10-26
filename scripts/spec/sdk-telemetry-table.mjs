// sdk-telemetry-table.mjs — the reading of specs/src/sdk-telemetry/telemetry.json
// that every SDK's generator shares: each span and metric, its kind or
// instrument, what it means, and its attributes, all of them and those every
// one carries.

import { readFileSync } from 'node:fs';

/** OTLP's span kinds, and the one instrument the table states. */
export const SPAN_KINDS = ['internal', 'server', 'client', 'producer', 'consumer'];
export const INSTRUMENTS = ['counter'];
/** What stands for the bus channel in a span's name. */
export const CHANNEL = '{channel}';

/**
 * The table at `path`: `{ spans, metrics }`, each row `{ name, meaning, all,
 * always }` with a span's `kind` or a metric's `instrument`. `all` is every
 * attribute a row may carry, `always` those not marked `only`. What the table
 * states that no generator can be trusted to write is `refuse`d.
 */
export function readSdkTelemetry(path, refuse) {
  const table = JSON.parse(readFileSync(path, 'utf8'));
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

  const spans = table.spans.map((row) => {
    const { all, always } = attributesOf(row);
    if (!SPAN_KINDS.includes(row.kind)) refuse(`${row.name} is of kind ${JSON.stringify(row.kind)}, which is not one of OTLP's`);
    if (row.name.replace(CHANNEL, '').includes('{')) refuse(`${row.name} has a placeholder no generator knows`);
    return { name: row.name, kind: row.kind, meaning: row.meaning, all, always };
  });
  const metrics = table.metrics.map((row) => {
    const { all, always } = attributesOf(row);
    if (!INSTRUMENTS.includes(row.instrument)) refuse(`${row.name} is a ${JSON.stringify(row.instrument)}, which no generator knows`);
    return { name: row.name, instrument: row.instrument, meaning: row.meaning, all, always };
  });
  return { spans, metrics };
}
