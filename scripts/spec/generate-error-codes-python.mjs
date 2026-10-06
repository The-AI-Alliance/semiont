#!/usr/bin/env node
// Generate the Python SDK's error vocabularies from specs/src/errors/codes.json:
// the code types, the wire → bus-code mapping, and the HTTP status classifier.
//
//   packages/sdk-python/src/semiont/error_codes.py
//
// The reading of the table, and the account it is held to, are
// error-codes-table.mjs's, shared with the TypeScript generator. The output is
// committed; `--check` compares without writing (the CI drift gate).
//
// `--table <path>` and `--out <path>` name another table and another output.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readErrorCodes } from './error-codes-table.mjs';
import { writeOrCheck } from './committed-source.mjs';
import { pyBanner, pyComment, pyConstant, pyString } from './python-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function option(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

const TABLE = resolve(option('--table') ?? resolve(ROOT, 'specs/src/errors/codes.json'));
const OUT = resolve(option('--out') ?? resolve(ROOT, 'packages/sdk-python/src/semiont/error_codes.py'));
const COMMAND_ERROR = resolve(ROOT, 'specs/src/components/schemas/CommandError.json');
const CHECK = process.argv.includes('--check');

function refuse(message) {
  console.error(`✗ ${TABLE}: ${message}`);
  process.exit(1);
}

const { table, busCodes, busByWire, unrecognized, transportCodes, byStatus, ranges, unclassified, jobCodes, sessionCodes, signInCodes, kbIdentityCodes } =
  readErrorCodes(TABLE, COMMAND_ERROR, refuse);

const vocabularies = [
  ['BusRequestErrorCode', table.busRequest, busCodes],
  ['TransportErrorCode', table.transport, transportCodes],
  ['JobErrorCode', table.job, jobCodes],
  ['SemiontSessionErrorCode', table.session, sessionCodes],
  ['SignInErrorCode', table.signIn, signInCodes],
  ['IdentityUnverifiableReason', table.kbIdentity, kbIdentityCodes],
];

/** A vocabulary as a `Literal` union, and the same codes as a tuple to iterate. */
const union = ([name, vocabulary, codes]) => `${pyComment(vocabulary.docs)}
type ${name} = Literal[
${codes.map((entry) => `${pyComment(entry.docs, '    ')}\n    ${pyString(entry.code)},`).join('\n')}
]

${pyConstant(name)}S: Final[tuple[${name}, ...]] = (
${codes.map((entry) => `    ${pyString(entry.code)},`).join('\n')}
)
`;

const text = `${pyBanner('specs/src/errors/codes.json', 'scripts/spec/generate-error-codes-python.mjs')}
"""The codes a Semiont client reports a failure under.

Each vocabulary is a closed set: a \`Literal\` union, so a \`match\` over one that
ends in \`assert_never\` is checked to name every code, and a tuple of the same
codes to iterate.
"""

from collections.abc import Mapping
from types import MappingProxyType
from typing import Final, Literal

__all__ = [
${[
  ...vocabularies.flatMap(([name]) => [name, `${pyConstant(name)}S`]),
  'BUS_REQUEST_CODE_BY_WIRE_CODE',
  'UNRECOGNIZED_FAILURE_CODE',
  'transport_error_code_for_status',
]
  .sort()
  .map((name) => `    ${pyString(name)},`)
  .join('\n')}
]

${union(vocabularies[0])}
# The bus code a failure's own wire code (\`CommandError.code\`) becomes.
BUS_REQUEST_CODE_BY_WIRE_CODE: Final[Mapping[str, BusRequestErrorCode]] = MappingProxyType(
    {
${[...busByWire].map(([wire, code]) => `        ${pyString(wire)}: ${pyString(code)},`).join('\n')}
    }
)

# What a failure becomes when its code is one this vocabulary does not name, or absent.
UNRECOGNIZED_FAILURE_CODE: Final[BusRequestErrorCode] = ${pyString(unrecognized.code)}

${union(vocabularies[1])}

def transport_error_code_for_status(status: int) -> TransportErrorCode:
    """The transport code an HTTP status becomes."""
    match status:
${[...byStatus].map(([status, code]) => `        case ${status}:\n            return ${pyString(code)}`).join('\n')}
        case _:
            pass
${ranges.map((entry) => `    if status >= ${entry.statusFrom}:\n        return ${pyString(entry.code)}\n`).join('')}    return ${pyString(unclassified.code)}


${vocabularies.slice(2).map(union).join('\n')}`;

writeOrCheck(ROOT, OUT, text, CHECK);
