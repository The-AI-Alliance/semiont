// Generate the client error vocabularies from specs/src/errors/codes.json:
// the code types, the wire → bus-code mapping, and the HTTP status classifier.
//
// The table is the authority every SDK generates from, so the generator is
// also where it is held to account: it refuses a table that disagrees with the
// wire's own vocabulary (`CommandError.code`) in either direction, or that
// says one thing twice. Output is gitignored and rebuilt by core's `prebuild`.
//
// `--table <path>` and `--out <path>` name another table and another output;
// the test of the refusals passes them.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

function option(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

const TABLE = resolve(option('--table') ?? resolve(ROOT, 'specs/src/errors/codes.json'));
const OUT = resolve(option('--out') ?? resolve(ROOT, 'packages/core/src/generated/error-codes.ts'));
const COMMAND_ERROR = resolve(ROOT, 'specs/src/components/schemas/CommandError.json');

function refuse(message) {
  console.error(`✗ ${TABLE}: ${message}`);
  process.exit(1);
}

/** A vocabulary's codes, each stated once and each documented. */
function codesOf(name, vocabulary) {
  if (!vocabulary || !Array.isArray(vocabulary.codes) || vocabulary.codes.length === 0) {
    refuse(`"${name}" lists no codes`);
  }
  if (typeof vocabulary.docs !== 'string' || vocabulary.docs === '') refuse(`"${name}" has no docs`);
  const seen = new Set();
  for (const entry of vocabulary.codes) {
    if (typeof entry.code !== 'string' || entry.code === '') refuse(`"${name}" has an entry with no code`);
    if (seen.has(entry.code)) refuse(`"${name}" states ${entry.code} twice`);
    seen.add(entry.code);
    if (typeof entry.docs !== 'string' || entry.docs === '') refuse(`${entry.code} has no docs`);
  }
  return vocabulary.codes;
}

const table = JSON.parse(readFileSync(TABLE, 'utf8'));
const wireCodes = JSON.parse(readFileSync(COMMAND_ERROR, 'utf8')).properties.code.enum;

// ── busRequest ──────────────────────────────────────────────────────────
const busCodes = codesOf('busRequest', table.busRequest);
const busByWire = new Map();
for (const entry of busCodes) {
  if (entry.wire === undefined) continue;
  if (!wireCodes.includes(entry.wire)) {
    refuse(`${entry.code} restates the wire code "${entry.wire}", which CommandError.code does not declare`);
  }
  if (busByWire.has(entry.wire)) {
    refuse(`the wire code "${entry.wire}" becomes both ${busByWire.get(entry.wire)} and ${entry.code}`);
  }
  busByWire.set(entry.wire, entry.code);
}
for (const wire of wireCodes) {
  if (!busByWire.has(wire)) refuse(`CommandError.code declares "${wire}", and no busRequest code restates it`);
}
const unrecognized = busCodes.find((entry) => entry.code === table.busRequest.unrecognizedFailure);
if (!unrecognized) refuse(`busRequest.unrecognizedFailure names "${table.busRequest.unrecognizedFailure}", which is not one of its codes`);
if (unrecognized.wire !== undefined) refuse(`busRequest.unrecognizedFailure is ${unrecognized.code}, which restates a wire code; an unrecognized failure cannot be a recognized one`);

// ── transport ───────────────────────────────────────────────────────────
const transportCodes = codesOf('transport', table.transport);
const byStatus = new Map();
const ranges = [];
for (const entry of transportCodes) {
  if (entry.status !== undefined && entry.statusFrom !== undefined) {
    refuse(`${entry.code} states both a status and a statusFrom`);
  }
  if (entry.status !== undefined) {
    if (!Number.isInteger(entry.status)) refuse(`${entry.code}'s status is not an integer`);
    if (byStatus.has(entry.status)) refuse(`status ${entry.status} is both ${byStatus.get(entry.status)} and ${entry.code}`);
    byStatus.set(entry.status, entry.code);
  }
  if (entry.statusFrom !== undefined) {
    if (!Number.isInteger(entry.statusFrom)) refuse(`${entry.code}'s statusFrom is not an integer`);
    ranges.push(entry);
  }
}
if (ranges.length > 1) refuse(`${ranges.map((entry) => entry.code).join(' and ')} each state a statusFrom; one open range is all a status can fall in`);
for (const [status, code] of byStatus) {
  if (ranges[0] && status >= ranges[0].statusFrom) {
    refuse(`status ${status} is ${code} and also falls in ${ranges[0].code}'s range`);
  }
}
const unclassified = transportCodes.find((entry) => entry.code === table.transport.unclassified);
if (!unclassified) refuse(`transport.unclassified names "${table.transport.unclassified}", which is not one of its codes`);
if (unclassified.status !== undefined || unclassified.statusFrom !== undefined) {
  refuse(`transport.unclassified is ${unclassified.code}, which a status already maps to`);
}
for (const entry of transportCodes) {
  if (entry !== unclassified && entry.status === undefined && entry.statusFrom === undefined) {
    refuse(`${entry.code} maps from no status and is not the unclassified code, so nothing produces it`);
  }
}

// ── job ─────────────────────────────────────────────────────────────────
const jobCodes = codesOf('job', table.job);

// ── session ─────────────────────────────────────────────────────────────
const sessionCodes = codesOf('session', table.session);

// ── render ──────────────────────────────────────────────────────────────
const doc = (text, indent = '') => `${indent}/** ${text.replaceAll('*/', '*\\/')} */`;
const union = (name, vocabulary, codes) =>
  `${doc(vocabulary.docs)}
export type ${name} =
${codes.map((entry) => `${doc(entry.docs, '  ')}\n  | ${JSON.stringify(entry.code)}`).join('\n')};
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  `// ⚠ GENERATED FILE — do not edit.
// Source: specs/src/errors/codes.json → scripts/spec/generate-error-codes.mjs
// Rebuilt by \`npm run prebuild\` in @semiont/core; gitignored on purpose.

${union('BusRequestErrorCode', table.busRequest, busCodes)}
/** The bus code a failure's own wire code (\`CommandError.code\`) becomes. */
export const busRequestCodeByWireCode = {
${[...busByWire].map(([wire, code]) => `  ${JSON.stringify(wire)}: ${JSON.stringify(code)},`).join('\n')}
} as const;

/** What a failure becomes when its code is one this vocabulary does not name, or absent. */
export const unrecognizedFailureCode = ${JSON.stringify(unrecognized.code)} as const;

${union('TransportErrorCode', table.transport, transportCodes)}
/** The transport code an HTTP status becomes. */
export function transportErrorCodeForStatus(status: number): TransportErrorCode {
  switch (status) {
${[...byStatus].map(([status, code]) => `    case ${status}: return ${JSON.stringify(code)};`).join('\n')}
  }
${ranges.map((entry) => `  if (status >= ${entry.statusFrom}) return ${JSON.stringify(entry.code)};\n`).join('')}  return ${JSON.stringify(unclassified.code)};
}

${union('JobErrorCode', table.job, jobCodes)}
${union('SemiontSessionErrorCode', table.session, sessionCodes)}`,
);

console.log(
  `generated ${busCodes.length} bus-request, ${transportCodes.length} transport, ${jobCodes.length} job and ${sessionCodes.length} session error codes → ${OUT}`,
);
