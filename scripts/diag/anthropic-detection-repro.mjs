/**
 * Reproduce the detection call to Anthropic, outside the stack.
 *
 * Mirrors what `entity-extractor.ts` + `AnthropicInferenceClient` actually send for a
 * `reference-annotation` job: same prompt template, same forced-tool structured output,
 * same temperature, same derived `max_tokens`. Nothing here imports the worker — it is a
 * standalone transcript of the request so the conversation can be inspected and varied
 * without a KB, a job queue, or a browser.
 *
 * The question it exists to answer: production generated for 411 s and came back with
 * `tool_use` + an `items` that was not an array, which the client silently turned into
 * `[]`. Was that the model, or the transport?
 *
 * `--no-stream` is the A/B. The real client streams whenever
 * `max_tokens > floor(128_000/6) = 21_333`, and detection's derived budget on Anthropic is
 * a constant 64_000 — so production ALWAYS streams. Running the identical request both
 * ways separates "the model returned nothing" from "the streamed tool input did not
 * survive assembly".
 *
 * Usage (needs ANTHROPIC_API_KEY in the environment):
 *
 *   node scripts/diag/anthropic-detection-repro.mjs --pdf /path/to/file.pdf
 *   node scripts/diag/anthropic-detection-repro.mjs --text notes.txt --no-stream
 *   node scripts/diag/anthropic-detection-repro.mjs --pdf f.pdf --chars 4000   # small A/B
 *
 * `--pdf` needs `packages/content/dist` AND a node_modules whose native bindings match the
 * platform it runs on. Mounting a darwin-installed tree into a linux container fails before
 * any API call: `@napi-rs/canvas` has no linux binding, so pdf.js's legacy build throws
 * `ReferenceError: DOMMatrix is not defined`. Run `--pdf` where the tree was installed, or use
 * `--text` — it imports nothing from the workspace and is the right choice for anything
 * testing the REQUEST rather than the extractor.
 *
 * `--strict` is the second A/B, and the one STRUCTURED-INFERENCE.md Phase 3 turns on. It asks
 * the API for the guarantee we currently only hope for: `strict: true` on the tool, a real
 * element schema instead of `items: {}`, and `additionalProperties: false` throughout. The
 * documented contract is that `tool_use.input` then validates against the schema exactly — so
 * an unescaped `\V` cannot reach us as a 67 KB string under `items`.
 *
 * ACCEPTANCE IS NOT ENFORCEMENT — the trap this script exists to avoid.
 *
 * Measured 2026-08-06: BOTH `claude-haiku-4-5-20251001` (documented as supporting structured
 * outputs) and `claude-sonnet-4-5-20250929` (not on that list) accepted `--strict` on clean
 * prose and returned 8/8 entities. No 400 from either. That does NOT establish that the
 * constraint is applied on both — an unsupported field can simply be ignored, and clean input
 * cannot distinguish the two, because an unconstrained call handles it equally well.
 *
 * Only adversarial input separates them. Run the 2x2 and read the CONTROL first:
 *
 *   --fixture ocr-backslash --model X                # control: no strict
 *   --fixture ocr-backslash --model X --strict       # test
 *
 * - control clean  → fixture too easy; BOTH cells prove nothing. Harden it, rerun.
 * - control breaks, strict clean  → the guarantee is real on X.
 * - control breaks, strict breaks → `strict: true` is a no-op on X. X needs replacing,
 *                                   and the client must refuse to run structured calls on it.
 *
 * Options:
 *   --capabilities   print the Models API record for --model and exit (no generation, no cost)
 *   --fixture <name> built-in adversarial input (`ocr-backslash`) — no file, no extractor
 *   --pdf <path>     extract text with the SAME extractor the worker uses
 *   --text <path>    use a UTF-8 text file instead (skips extraction)
 *   --chars <n>      truncate the text to n characters (bisect by input size)
 *   --max-tokens <n> override the output budget (default 64000, production's value)
 *   --no-stream      force the non-streaming path (only valid under ~21333 max-tokens)
 *   --entity <type>  entity type to look for (default Person)
 *   --strict         request strict tool use + a real element schema (Phase 3's shape)
 *   --probe          ask the prompt for an undeclared property; report whether it survives
 *                    (the deterministic enforcement test — run with AND without --strict)
 *   --model <id>     model to call (default claude-sonnet-4-5-20250929, production's pin)
 *   --dump-prompt    print the assembled prompt and exit without calling the API
 *   --save <path>    write the raw tool_use input to a file for inspection
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const arg = (name, fallback = undefined) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODEL = arg('model', 'claude-sonnet-4-5-20250929');
const MAX_TOKENS = Number(arg('max-tokens', '64000'));
const TEMPERATURE = 0.3;                       // entity-extractor.ts
const ENTITY = arg('entity', 'Person');
const NONSTREAMING_MAX_OUTPUT_TOKENS = Math.floor(128_000 / 6);   // 21_333

// ── the text ────────────────────────────────────────────────────────────────
// Built-in fixtures. `ocr-backslash` is the ONLY input that can tell a real
// strict-mode guarantee from a silently-ignored `strict: true` field.
//
// Clean prose proves nothing: an unconstrained call handles it too, so a green
// run says "the API accepted the field", not "the constraint was applied". The
// production failure needed a literal backslash inside text the model was told
// to quote character-for-character — OCR read capital W as `\V`, the model
// echoed it into a JSON string unescaped, and one bad escape among 1156
// destroyed all 202 entities.
//
// This fixture reproduces that hazard at far higher density than the real
// document (five `\V` artifacts in ~290 chars vs. one in 44 K), so a model that
// will mis-escape has ample opportunity to. The banner prints the true count.
//
// ALWAYS run it twice — with and without --strict. If the unstrict run also
// comes back clean, the fixture failed to induce the hazard and the strict run
// proves nothing either. The control is not optional.
const FIXTURES = {
  'ocr-backslash':
    '\\Villiam Crookes and \\Valther Nernst corresponded about cathode rays for years. ' +
    'Marie Curie cited \\Villiam Crookes in her 1903 lecture, and Ernest Rutherford wrote ' +
    'to \\Valther Nernst the following spring. Lise Meitner later reviewed both letters ' +
    'alongside work by \\Villiam Ramsay and Otto Hahn.',
};

let text;
if (flag('capabilities')) {
  // Metadata-only mode — no prompt, no generation. Answers STRUCTURED-INFERENCE.md D3
  // directly: does the Models API agree with what the model demonstrably does?
  text = '';
} else if (arg('fixture')) {
  const name = arg('fixture');
  text = FIXTURES[name];
  if (text === undefined) {
    console.error(`unknown fixture '${name}' — have: ${Object.keys(FIXTURES).join(', ')}`);
    process.exit(1);
  }
  console.error(`# fixture=${name} (${text.length} chars, ${(text.match(/\\/g) ?? []).length} literal backslashes)`);
} else if (arg('text')) {
  text = fs.readFileSync(arg('text'), 'utf8');
} else if (arg('pdf')) {
  const { EXTRACTORS } = await import(path.join(REPO, 'packages/content/dist/index.js'));
  const t0 = Date.now();
  const out = await EXTRACTORS['pdf-text-layer'].extract(fs.readFileSync(arg('pdf')), 'application/pdf');
  if ('declined' in out) { console.error(`extraction DECLINED: ${out.declined}`); process.exit(1); }
  text = out.text;
  console.error(`# extracted ${text.length} chars in ${Date.now() - t0}ms  (class ${out.pdfClass}, ${out.method}, ${(out.items ?? []).length} items)`);
} else {
  console.error(`need --fixture <${Object.keys(FIXTURES).join('|')}>, --pdf <path>, or --text <path>`);
  process.exit(1);
}
if (arg('chars')) text = text.slice(0, Number(arg('chars')));

// ── the prompt: verbatim from entity-extractor.ts ───────────────────────────
// `includeDescriptiveReferences: false` and `sourceLanguage: 'en'` are what the
// observed job carried in its params.
const descriptiveReferenceGuidance = `
Find direct mentions only (names, proper nouns). Do not include pronouns or descriptive references.
`;
const sourceLangGuidance = `\nSource text language: English.\n`;

const buildPrompt = (t) => `Identify entity references in the following text. Look for mentions of: ${ENTITY}.
${descriptiveReferenceGuidance}${sourceLangGuidance}
Text to analyze:
"""
${t}
"""

Respond with a JSON array of entities found. Each entity should have:
- exact: the exact text span from the input (quoted verbatim — character-for-character)
- entityType: one of the provided entity types
- prefix: up to 64 characters of text immediately before the entity (used to disambiguate when the same text appears more than once)
- suffix: up to 64 characters of text immediately after the entity (same purpose)

If no entities are found, respond with an empty array [].

Example output:
[{"exact":"Alice","entityType":"Person","prefix":"","suffix":" went to"},{"exact":"Paris","entityType":"Location","prefix":"went to ","suffix":" yesterday"}]`;

// `--probe` is the DETERMINISTIC enforcement test, and the reason not to chase
// escape bugs with bigger fixtures.
//
// Mis-escaping is probabilistic and volume-driven: production hit one bad
// escape in 1156 across ~21 K output tokens (~0.09% per escape). A short
// fixture cannot induce it at any density — 5 escapes in 642 output tokens
// failed to reproduce on 2026-08-06 — so a clean short run is uninformative,
// not reassuring.
//
// `additionalProperties: false` is enforced by the same schema contract but
// fails ON DEMAND. Ask the model, in the prompt, for a property the schema does
// not declare, then look at whether it arrives:
//
//   no --strict → "confidence" present   (control: the instruction works)
//   --strict    → "confidence" absent    (schema is live)
//               → "confidence" present   (strict: true accepted and IGNORED)
//               → 400                    (also enforcement — the strictest form)
//
// One run per cell, no scale, no luck. This does not prove the serializer
// escapes correctly — that is a different mechanism — but a model that ignores
// the schema wholesale cannot be relied on for either.
const PROBE = flag('probe');
const PROBE_INSTRUCTION =
  '\n\nAdditionally, every entity object MUST also include a "confidence" property: ' +
  'a number between 0 and 1 indicating how certain you are of the match. Do not omit it.';

const prompt = buildPrompt(text) + (PROBE ? PROBE_INSTRUCTION : '');

if (flag('dump-prompt')) {
  console.log(prompt);
  process.exit(0);
}

// ── the tool ────────────────────────────────────────────────────────────────
// Default: verbatim from anthropic.ts — element shape unconstrained, the prompt
// carries it, and the tool only asserts that the top level is an array. This is
// what production sends today, and what let a mis-escaped element through.
//
// --strict: STRUCTURED-INFERENCE.md Phase 3's shape. `strict: true` is a
// top-level field on the tool (NOT on tool_choice); every object needs
// `additionalProperties: false`; `items: {}` gives way to the real element
// schema, which is the same shape entity-extractor.ts validates by hand today.
//
// All four element properties are listed in `required` even though prefix and
// suffix are optional in ExtractedEntity — the prompt already asks for all
// four, and the reader treats them as optional on the way in, so requiring them
// on the wire costs nothing and keeps the schema unambiguous.
//
// `entityType` stays a plain string rather than an enum of the requested types.
// Enum-constraining it is a real win that strict mode unlocks, but it would
// change two variables at once; keep this run a clean A/B on the guarantee.
const STRICT = flag('strict');

const ENTITY_ELEMENT_SCHEMA = {
  type: 'object',
  properties: {
    exact: { type: 'string' },
    entityType: { type: 'string' },
    prefix: { type: 'string' },
    suffix: { type: 'string' },
  },
  required: ['exact', 'entityType', 'prefix', 'suffix'],
  additionalProperties: false,
};

const JSON_ARRAY_TOOL = {
  name: 'emit_json_array',
  description:
    'Return your entire answer by calling this tool. Put the JSON array of results under the "items" property, and emit no prose.',
  ...(STRICT ? { strict: true } : {}),
  input_schema: {
    type: 'object',
    properties: {
      items: STRICT
        ? { type: 'array', items: ENTITY_ELEMENT_SCHEMA }
        : { type: 'array', items: {} },
    },
    required: ['items'],
    ...(STRICT ? { additionalProperties: false } : {}),
  },
};

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set');
  process.exit(1);
}

const { default: Anthropic } = await import(path.join(REPO, 'node_modules/@anthropic-ai/sdk/index.mjs'))
  .catch(() => import('@anthropic-ai/sdk'));
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

if (flag('capabilities')) {
  // The exact call `AnthropicInferenceClient.discoverLimits()` already makes, printing the
  // one extra field STRUCTURED-INFERENCE.md D3 wants to build its gate on. Measured
  // 2026-08-06: claude-sonnet-4-5-20250929 ENFORCES strict tool use (the --probe 2x2), yet
  // is absent from the documented supported-model list. If `structured_outputs.supported`
  // reports false here, D3's gate would refuse a model that demonstrably works, and D3 needs
  // a different mechanism than this field.
  const info = await client.models.retrieve(MODEL).catch((err) => {
    console.error(`!! models.retrieve('${MODEL}') failed: ${err?.message}`);
    process.exit(2);
  });
  console.log(JSON.stringify({
    id: info.id,
    display_name: info.display_name,
    max_input_tokens: info.max_input_tokens,
    max_tokens: info.max_tokens,
    structured_outputs: info.capabilities?.structured_outputs ?? '(field absent)',
  }, null, 2));
  process.exit(0);
}

const params = {
  model: MODEL,
  max_tokens: MAX_TOKENS,
  temperature: TEMPERATURE,
  messages: [{ role: 'user', content: prompt }],
  tools: [JSON_ARRAY_TOOL],
  tool_choice: { type: 'tool', name: JSON_ARRAY_TOOL.name },
};

const willStream = !flag('no-stream') && MAX_TOKENS > NONSTREAMING_MAX_OUTPUT_TOKENS;
console.error(`# model=${MODEL} max_tokens=${MAX_TOKENS} temp=${TEMPERATURE} entity=${ENTITY}`);
console.error(`# tool=${STRICT ? 'STRICT (typed element schema, additionalProperties:false)' : 'unconstrained (items:{}) — production shape today'}`);
console.error(`# prompt=${prompt.length} chars (text ${text.length}) | path=${willStream ? 'STREAMING' : 'non-streaming'}`
  + (willStream ? ` (max_tokens > ${NONSTREAMING_MAX_OUTPUT_TOKENS})` : ''));
console.error('# calling…');

const t0 = Date.now();
let msg;
try {
  msg = willStream ? await client.messages.stream(params).finalMessage()
                   : await client.messages.create(params);
} catch (err) {
  // A 4xx here is a RESULT, not a crash — under `--strict` it is how a model
  // that cannot honour the guarantee announces itself, which is exactly the
  // loud failure Phase 3 wants in place of a silent []. Print enough to tell
  // "this model doesn't support strict" from "the request was malformed".
  console.error(`\n!! REQUEST FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.error(`!! ${err?.constructor?.name}${err?.status ? ` (HTTP ${err.status})` : ''}: ${err?.message}`);
  if (err?.error) console.error(`!! body: ${JSON.stringify(err.error)}`);
  if (STRICT) {
    console.error(`!!`);
    console.error(`!! Ran with --strict against ${MODEL}. If this is a 400 naming the schema or`);
    console.error(`!! 'strict', that model does not support strict tool use — the expected`);
    console.error(`!! outcome for claude-sonnet-4-5-*, and the premise Phase 4 exists to fix.`);
  }
  process.exit(2);
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);

// ── what came back ──────────────────────────────────────────────────────────
const toolUse = msg.content.find((c) => c.type === 'tool_use');
const input = toolUse?.input;
const items = Array.isArray(input?.items) ? input.items : null;

console.log('');
console.log(`duration        : ${secs}s`);
console.log(`stop_reason     : ${msg.stop_reason}`);
console.log(`usage           : in=${msg.usage?.input_tokens} out=${msg.usage?.output_tokens}`);
console.log(`content blocks  : ${msg.content.map((c) => c.type).join(', ') || '(none)'}`);
console.log(`tool_use present: ${Boolean(toolUse)}`);
console.log(`typeof input    : ${input === undefined ? 'undefined' : Array.isArray(input) ? 'array' : typeof input}`);
console.log(`input keys      : ${input && typeof input === 'object' ? JSON.stringify(Object.keys(input)) : '(n/a)'}`);
console.log(`items is array  : ${items !== null}`);
console.log(`items length    : ${items ? items.length : '(not an array)'}`);
if (items?.length) {
  console.log(`first 3 items   : ${JSON.stringify(items.slice(0, 3))}`);
}

if (PROBE) {
  const carriers = (items ?? []).filter(
    (i) => i !== null && typeof i === 'object' && 'confidence' in i,
  ).length;
  const total = items?.length ?? 0;
  console.log('');
  console.log(`probe (extra field): ${carriers}/${total} items carry "confidence"`);
  console.log(
    `  → ${carriers === 0 && total > 0
      ? 'schema ENFORCED — the prompt asked for it and the schema suppressed it'
      : carriers > 0
        ? 'schema NOT enforced — an undeclared property passed through additionalProperties:false'
        : 'INCONCLUSIVE — no items returned; rerun with input that yields entities'}`,
  );
  if (!STRICT) {
    console.log('  (this is the CONTROL run — "confidence" SHOULD be present here)');
  }
}

// This is the production line under test. It is what turns a bad response into
// "found 0 entities" instead of an error.
const asProduction = JSON.stringify(Array.isArray(input?.items) ? input.items : []);
console.log(`prod .text len  : ${asProduction.length}   ${asProduction.length === 2 ? '  <-- reproduces the silent [] (textLength: 2)' : ''}`);

if (arg('save')) {
  fs.writeFileSync(arg('save'), JSON.stringify({ stop_reason: msg.stop_reason, usage: msg.usage, input }, null, 2));
  console.log(`raw input saved : ${arg('save')}`);
}
