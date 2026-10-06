#!/usr/bin/env node
// generate-sign-in-python.mjs — generate the Python SDK's entry of the sign-in
// store from specs/src/sign-in-store/SignIn.json, the schema the launcher and
// the Rust SDK generate their own from.
//
//   packages/sdk-python/src/semiont/sign_in.py
//
// The launcher, an application on the Rust SDK and one on this SDK all read
// and write <stateDir>/tokens.json, so the entry's shape is the contract's to
// state. The reading of the schema is sign-in-schema.mjs's.
//
// --check compares without writing (the CI drift gate).

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeOrCheck } from './committed-source.mjs';
import { pyBanner, pyComment, pyDocstring, pySnake, pyString } from './python-source.mjs';
import { readSignInSchema } from './sign-in-schema.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEMA = resolve(ROOT, 'specs/src/sign-in-store/SignIn.json');
const OUT = resolve(ROOT, 'packages/sdk-python/src/semiont/sign_in.py');
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

const text = `${pyBanner('specs/src/sign-in-store/SignIn.json', 'scripts/spec/generate-sign-in-python.mjs')}
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
