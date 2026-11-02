#!/usr/bin/env node
// generate-sign-in-python.mjs — generate the Python SDK's entry of the sign-in
// store from specs/src/sign-in-store/SignIn.json, the schema the launcher and
// the Rust SDK generate their own from, and how the store's directory and
// files are kept to their owner from specs/src/sign-in-store/owner-only.json.
//
//   packages/python/sdk/src/semiont/sign_in.py            the entry
//   packages/python/sdk/src/semiont/_owner_only_table.py  the directory's and
//                                                         the files' modes, and
//                                                         the access list
//
// The launcher, an application on the Rust SDK and one on this SDK all read
// and write <stateDir>/tokens.json, so the entry's shape is the contract's to
// state, and so is how its directory is kept. The reading of the schema is
// sign-in-schema.mjs's, and of the owner-only file owner-only.mjs's.
//
// --check compares without writing (the CI drift gate).

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeOrCheck } from '../lib/committed-source.mjs';
import { readOwnerOnly } from './owner-only.mjs';
import { pyBanner, pyComment, pyDocstring, pySnake, pyString } from '../lib/python-source.mjs';
import { readSignInSchema } from './sign-in-schema.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SCHEMA = resolve(ROOT, 'specs/src/sign-in-store/SignIn.json');
const OWNER_ONLY = resolve(ROOT, 'specs/src/sign-in-store/owner-only.json');
const OUT = resolve(ROOT, 'packages/python/sdk/src/semiont/sign_in.py');
const OWNER_ONLY_OUT = resolve(ROOT, 'packages/python/sdk/src/semiont/_owner_only_table.py');
const CHECK = process.argv.includes('--check');

function refuse(message) {
  console.error(`✗ ${SCHEMA}: ${message}`);
  process.exit(1);
}

const schema = readSignInSchema(SCHEMA, refuse);

// A time stays the text it is written as: what this SDK reads it writes back
// as it came. The wire's name is beside the type, where both type checkers
// leave the Python name as the one an entry is built by.
const field = ({ name, description, required }) => {
  const python = pySnake(name);
  const plain = required ? 'str' : 'str | None';
  const type = python === name ? plain : `Annotated[${plain}, Field(alias=${pyString(name)})]`;
  return `${pyComment(description, '    ')}\n    ${python}: ${type}${required ? '' : ' = None'}`;
};

const usesField = schema.fields.some(({ name }) => pySnake(name) !== name);

const text = `${pyBanner('specs/src/sign-in-store/SignIn.json', 'packages/codegen/schemas/generate-sign-in-python.mjs')}
"""One entry of the sign-in store (\`specs/src/sign-in-store\`): the file where
\`semiont login\` keeps the sign-in to each stack, and where an application
finds it.
"""

from typing import ${usesField ? 'Annotated, ' : ''}final
${usesField ? '\nfrom pydantic import Field\n' : ''}
from semiont.model import WireModel

__all__ = [${pyString(schema.title)}]


@final
class ${schema.title}(WireModel, frozen=True):
${pyDocstring(schema.description, '    ')}

${schema.fields.map(field).join('\n\n')}
`;

writeOrCheck(ROOT, OUT, text, CHECK);

const { directoryMode, fileMode, accessList } = readOwnerOnly(OWNER_ONLY);

const ownerOnly = `${pyBanner('specs/src/sign-in-store/owner-only.json', 'packages/codegen/schemas/generate-sign-in-python.mjs')}
"""How a writer of the sign-in store keeps its directory and its files to their owner, as the launcher keeps its state home."""

from typing import Final

__all__ = ["DIRECTORY_MODE", "FILE_MODE", "access_list"]

${pyComment(directoryMode.docs)}
DIRECTORY_MODE: Final = 0o${directoryMode.octal}

${pyComment(fileMode.docs)}
FILE_MODE: Final = 0o${fileMode.octal}


def access_list(owner: str) -> str:
${pyDocstring(accessList.docs, '    ')}
    return ${pyString(accessList.before)} + owner + ${pyString(accessList.after)}
`;

writeOrCheck(ROOT, OWNER_ONLY_OUT, ownerOnly, CHECK);
