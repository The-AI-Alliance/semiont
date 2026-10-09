// Generate the client error vocabularies from specs/src/errors/codes.json:
// the code types, the wire → bus-code mapping, and the HTTP status classifier.
//
// The table is the authority every SDK generates from. Its reading, and the
// account it is held to, are error-codes-table.mjs's, shared with every other
// generator of it. Output is gitignored and rebuilt by core's `prebuild`.
//
// `--table <path>` and `--out <path>` name another table and another output;
// the test of the refusals passes them.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readErrorCodes } from './error-codes-table.mjs';

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

const { table, busCodes, busByWire, unrecognized, transportCodes, byStatus, ranges, unclassified, jobCodes, sessionCodes, signInCodes, kbIdentityCodes, spanRefusalCodes } =
  readErrorCodes(TABLE, COMMAND_ERROR, refuse);

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
${union('SemiontSessionErrorCode', table.session, sessionCodes)}
${union('SignInErrorCode', table.signIn, signInCodes)}
${union('IdentityUnverifiableReason', table.kbIdentity, kbIdentityCodes)}
${union('SpanRefusal', table.spanRefusal, spanRefusalCodes)}`,
);

console.log(
  `generated ${busCodes.length} bus-request, ${transportCodes.length} transport, ${jobCodes.length} job, ${sessionCodes.length} session, ${signInCodes.length} sign-in, ${kbIdentityCodes.length} identity and ${spanRefusalCodes.length} span-refusal error codes → ${OUT}`,
);
