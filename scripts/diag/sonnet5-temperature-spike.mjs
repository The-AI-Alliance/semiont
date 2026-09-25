// Spike instrument: which request shapes does `claude-sonnet-5` refuse over
// `temperature`? (SONNET-5-MIGRATION Phase 0 — the two cells production's 400
// did not answer: the output_config shape, and whether the DEFAULT value is
// accepted when sent explicitly.)
//
// Raw fetch, same rationale as output-config-root-spike.mjs: the question is
// what the API accepts on the wire.
//
// Key sourcing: ANTHROPIC_API_KEY env if set, else --config <anthropic.toml>
// (the launcher-recorded KB config), read in-process. The key is never logged.
import { readFileSync } from 'node:fs';

const MODEL = process.env.SPIKE_MODEL || 'claude-sonnet-5';

function apiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const flag = process.argv.indexOf('--config');
  if (flag < 0) throw new Error('no ANTHROPIC_API_KEY and no --config <anthropic.toml>');
  const toml = readFileSync(process.argv[flag + 1], 'utf8');
  const m = toml.match(/^\s*apiKey\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error('no apiKey line found in config');
  if (m[1].startsWith('${')) throw new Error(`apiKey is an unresolved env reference (${m[1]}) — export it instead`);
  return m[1];
}
const KEY = apiKey();

const ELEMENT = {
  type: 'object',
  properties: { exact: { type: 'string' }, entityType: { type: 'string' } },
  required: ['exact', 'entityType'],
  additionalProperties: false,
};

function body(shape, temperature) {
  const b = {
    model: MODEL,
    max_tokens: 64,
    messages: [{ role: 'user', content: shape === 'structured'
      ? 'People in this sentence: Alice Okafor met Marcus Lindqvist.'
      : 'Reply with the single word: ok' }],
  };
  if (temperature !== undefined) b.temperature = temperature;
  if (shape === 'structured') {
    b.output_config = { format: { type: 'json_schema', schema: { type: 'array', items: ELEMENT } } };
  }
  return b;
}

async function probe(label, shape, temperature) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body(shape, temperature)),
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json();
  if (res.ok) {
    const text = (data.content?.find(c => c.type === 'text')?.text ?? '').slice(0, 60);
    console.log(`${label}: ${res.status} | stop=${data.stop_reason} | text="${text}"`);
  } else {
    console.log(`${label}: ${res.status} | ${data.error?.type} | ${String(data.error?.message).slice(0, 120)}`);
  }
}

// Controls first (a failed control voids its test cell), then tests.
await probe('C. plain,   temp omitted     ', 'plain', undefined);
await probe('A. plain,   temp 0.7         ', 'plain', 0.7);
await probe('B. plain,   temp 1 (default) ', 'plain', 1);
await probe('E. struct,  temp omitted     ', 'structured', undefined);
await probe('D. struct,  temp 0.7         ', 'structured', 0.7);

// D2: does the Models API expose sampling-parameter acceptance?
const mres = await fetch(`https://api.anthropic.com/v1/models/${MODEL}`, {
  headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
  signal: AbortSignal.timeout(30_000),
});
const model = await mres.json();
console.log(`F. models API ${mres.status} | top-level keys: ${Object.keys(model).join(', ')}`);
if (model.capabilities) console.log('   capabilities:', JSON.stringify(model.capabilities));
