/**
 * STRUCTURED-INFERENCE Phase 5 spike: does `output_config.format` accept a
 * TOP-LEVEL ARRAY root schema?
 *
 * Strict tool use provably requires an object root (tool inputs are objects);
 * if response-level structured output accepts an array root, the
 * `emit_json_array` tool + `items` wrapper + unwrap all delete. If the root
 * must be an object, Phase 5 is a no-op and says so.
 *
 * 2×2 discipline (per the 2026-08-06 measurement campaign): the OBJECT-root
 * control must succeed for the ARRAY-root cell to be informative — a 400 on
 * the control means the field itself is wrong/unsupported and the run is VOID.
 *
 * Usage (needs ANTHROPIC_API_KEY in the environment):
 *   node scripts/diag/output-config-root-spike.mjs [model]
 *
 * Raw fetch, not the SDK: the question is what the API accepts, and the SDK
 * types `JSONOutputFormat.schema` as an unconstrained record either way.
 */

const args = process.argv.slice(2);
const probe = args.includes('--probe');
const model = args.find((a) => !a.startsWith('--')) ?? 'claude-sonnet-4-5-20250929';
const key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  console.error('ANTHROPIC_API_KEY is not set');
  process.exit(1);
}

const ELEMENT = {
  type: 'object',
  properties: { exact: { type: 'string' }, entityType: { type: 'string' } },
  required: ['exact', 'entityType'],
  additionalProperties: false,
};

const PROMPT = 'List the people mentioned: "Ada Lovelace corresponded with Charles Babbage." Answer only in the structured format.';

async function attempt(label, schema) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 300,
      messages: [{ role: 'user', content: PROMPT }],
      output_config: { format: { type: 'json_schema', schema } },
    }),
  });

  const body = await res.json();
  if (!res.ok) {
    console.log(`${label}: HTTP ${res.status} — ${body?.error?.type}: ${body?.error?.message}`);
    return { ok: false, status: res.status, message: body?.error?.message };
  }

  const text = body.content?.find?.((c) => c.type === 'text')?.text ?? '';
  let parsed, parseError;
  try { parsed = JSON.parse(text); } catch (e) { parseError = String(e); }
  console.log(`${label}: HTTP 200, stop_reason=${body.stop_reason}, text ${text.length} chars,`,
    parseError ? `PARSE FAILED: ${parseError}` : `parsed root=${Array.isArray(parsed) ? 'array' : typeof parsed}`);
  if (!parseError) console.log(`${label} value:`, JSON.stringify(parsed).slice(0, 300));
  return { ok: true, parsed, isArray: Array.isArray(parsed) };
}

if (probe) {
  // ── Enforcement probe (--probe) ─────────────────────────────────────────
  // The root spike proved ACCEPTANCE; this proves ENFORCEMENT — the campaign's
  // own distinction ("an unsupported request field can be ignored rather than
  // rejected"). Same discipline as the strict-tool --probe: the prompt demands
  // an undeclared `confidence` property on every item. Control (open element
  // schema) must show it present, or the instruction failed and the run is
  // VOID; test (closed schema, additionalProperties: false) must suppress it.
  // Fixture carries the OCR-backslash artifacts for escaping observation.
  const BACKSLASH_TEXT =
    '\\Villiam Crookes and \\Valther Nernst corresponded about cathode rays for years. ' +
    'Marie Curie cited \\Villiam Crookes in her 1903 lecture, and Ernest Rutherford ' +
    'wrote to \\Valther Nernst about the same experiments. \\Vilhelm Rontgen joined later.';
  const PROBE_PROMPT =
    `Identify every Person mentioned in the text below. For EACH item, include a ` +
    `"confidence" property between 0 and 1 — this is required. Quote spans verbatim.\n\n` +
    `Text:\n"""\n${BACKSLASH_TEXT}\n"""`;

  // A fully open control is IMPOSSIBLE here: the API 400s any object schema
  // without `additionalProperties: false` (measured — itself an enforcement
  // signal: openness is structurally prohibited under output_config). The
  // control therefore DECLARES `confidence`, proving the instruction works
  // and the model emits it when the schema permits; the test omits it.
  const controlElement = {
    type: 'object',
    properties: { exact: { type: 'string' }, entityType: { type: 'string' }, confidence: { type: 'number' } },
    required: ['exact', 'entityType'],
    additionalProperties: false,
  };
  const closedElement = {
    type: 'object',
    properties: { exact: { type: 'string' }, entityType: { type: 'string' } },
    required: ['exact', 'entityType'],
    additionalProperties: false,
  };

  const run = async (label, element) => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 2000,
        messages: [{ role: 'user', content: PROBE_PROMPT }],
        output_config: { format: { type: 'json_schema', schema: { type: 'array', items: element } } },
      }),
    });
    const body = await res.json();
    if (!res.ok) {
      console.log(`${label}: HTTP ${res.status} — ${body?.error?.message}`);
      return null;
    }
    const text = body.content?.find?.((c) => c.type === 'text')?.text ?? '';
    let parsed;
    try { parsed = JSON.parse(text); } catch {
      console.log(`${label}: 200 but text is not parseable JSON (${text.length} chars)`);
      return null;
    }
    if (!Array.isArray(parsed)) { console.log(`${label}: parsed root=${typeof parsed}, not array`); return null; }
    const withConf = parsed.filter((it) => it && typeof it === 'object' && 'confidence' in it).length;
    console.log(`${label}: 200, items=${parsed.length}, "confidence" on ${withConf}/${parsed.length}`);
    console.log(`${label} first item:`, JSON.stringify(parsed[0]).slice(0, 200));
    return { items: parsed.length, withConf };
  };

  console.log(`model: ${model} — output_config ENFORCEMENT probe\n`);
  const control = await run('CONTROL (confidence declared)', controlElement);
  if (!control || control.withConf === 0) {
    console.log('\nVERDICT: VOID — the control did not show the undeclared property, so the instruction itself failed; the test cell is uninformative.');
    process.exit(2);
  }
  const test = await run('TEST (additionalProperties: false)', closedElement);
  if (test && test.withConf === 0) {
    console.log('\nVERDICT: ENFORCED — the closed schema suppressed the demanded undeclared property under output_config.');
  } else if (test) {
    console.log('\nVERDICT: NOT ENFORCED — the undeclared property survived additionalProperties: false under output_config.');
  }
  process.exit(0);
}

console.log(`model: ${model}\n`);

const control = await attempt('CONTROL (object root)', {
  type: 'object',
  properties: { items: { type: 'array', items: ELEMENT } },
  required: ['items'],
  additionalProperties: false,
});

if (!control.ok) {
  console.log('\nVERDICT: VOID — the object-root control was rejected; the field itself is unsupported here. The array cell is uninformative.');
  process.exit(2);
}

const test = await attempt('TEST (array root)', { type: 'array', items: ELEMENT });

if (test.ok && test.isArray) {
  console.log('\nVERDICT: GO — output_config.format accepts a top-level array root and returns a parseable array. The emit_json_array tool, the items wrapper, and the unwrap can delete.');
} else if (test.ok) {
  console.log('\nVERDICT: NO-OP (soft) — accepted but did not yield an array root; wrapper still required.');
} else {
  console.log('\nVERDICT: NO-OP — array roots are rejected; the object wrapper is required either way, and Phase 5 closes as a documented no-op.');
}
