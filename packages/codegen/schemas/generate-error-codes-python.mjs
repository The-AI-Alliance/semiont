#!/usr/bin/env node
// Generate the Python SDK's error vocabularies from protocol/specs/src/errors/codes.json:
// the code types, the bus code each wire code becomes, and the HTTP status classifier.
//
// The bus code of a wire code is a `match` over the closed `CommandErrorCode`
// (`semiont.types`), ending in `assert_never`: the type checkers hold it to name
// every code, and the table reader refuses codes.json where it and
// CommandError.code disagree in either direction, so no code is left to fall
// back on.
//
//   packages/python/sdk/src/semiont/error_codes.py
//
// The reading of the table, and the account it is held to, are
// error-codes-table.mjs's, shared with the TypeScript generator. The output is
// committed; `--check` compares without writing (the CI drift gate).
//
// `--table <path>` and `--out <path>` name another table and another output.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readErrorCodes } from './error-codes-table.mjs';
import { writeOrCheck } from '../lib/committed-source.mjs';
import { pyBanner, pyComment, pyConstant, pyString } from '../lib/python-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function option(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

const TABLE = resolve(option('--table') ?? resolve(ROOT, 'protocol/specs/src/errors/codes.json'));
const OUT = resolve(option('--out') ?? resolve(ROOT, 'packages/python/sdk/src/semiont/error_codes.py'));
const COMMAND_ERROR = resolve(ROOT, 'protocol/specs/src/components/schemas/CommandError.json');
const CHECK = process.argv.includes('--check');

function refuse(message) {
  console.error(`✗ ${TABLE}: ${message}`);
  process.exit(1);
}

const { table, busCodes, busByWire, unrecognized, transportCodes, byStatus, ranges, unclassified, jobCodes, sessionCodes, signInCodes, kbIdentityCodes, spanRefusalCodes } =
  readErrorCodes(TABLE, COMMAND_ERROR, refuse);

const vocabularies = [
  ['BusRequestErrorCode', table.busRequest, busCodes],
  ['TransportErrorCode', table.transport, transportCodes],
  ['JobErrorCode', table.job, jobCodes],
  ['SemiontSessionErrorCode', table.session, sessionCodes],
  ['SignInErrorCode', table.signIn, signInCodes],
  ['IdentityUnverifiableReason', table.kbIdentity, kbIdentityCodes],
  ['SpanRefusal', table.spanRefusal, spanRefusalCodes],
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

const text = `${pyBanner('protocol/specs/src/errors/codes.json', 'packages/codegen/schemas/generate-error-codes-python.mjs')}
"""The codes a Semiont client reports a failure under.

Each vocabulary is a closed set: a \`Literal\` union, so a \`match\` over one that
ends in \`assert_never\` is checked to name every code, and a tuple of the same
codes to iterate.
"""

from typing import Final, Literal, assert_never

from semiont.types import CommandErrorCode

__all__ = [
${[
  ...vocabularies.flatMap(([name]) => [name, `${pyConstant(name)}S`]),
  'bus_request_code_for_wire_code',
  'transport_error_code_for_status',
]
  .sort()
  .map((name) => `    ${pyString(name)},`)
  .join('\n')}
]

${union(vocabularies[0])}

def bus_request_code_for_wire_code(code: CommandErrorCode | None) -> BusRequestErrorCode:
    """The bus code a failure's own code (\`CommandError.code\`) becomes.

    A failure that states none is the unrecognized failure, and so is one
    whose code the wire does not list, which is read as stating none.
    """
    match code:
${[...busByWire].map(([wire, code]) => `        case ${pyString(wire)}:\n            return ${pyString(code)}`).join('\n')}
        case None:
            return ${pyString(unrecognized.code)}
        case _:
            assert_never(code)


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
