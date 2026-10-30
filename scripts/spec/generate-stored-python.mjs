#!/usr/bin/env node
// generate-stored-python.mjs — generate what the Python SDK's registry keeps
// in a SessionStorage from specs/src/session/stored.json: the key each thing
// is kept under, the key of a knowledge base's session, and the stored
// session's shape.
//
//   packages/python/sdk/src/semiont/stored.py
//
// A registry in one SDK finds what one in another wrote, over one storage,
// only if both say these alike. TypeScript, Rust, Go and Kotlin state them by hand,
// each held to the table by a test; Python's are this. The reading of the
// session's schema is sign-in-schema.mjs's.
//
// --check compares without writing (the CI drift gate).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeOrCheck } from './committed-source.mjs';
import { pyBanner, pyComment, pyConstant, pyDocstring, pySnake, pyString } from './python-source.mjs';
import { readFlatSchema } from './sign-in-schema.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TABLE = resolve(ROOT, 'specs/src/session/stored.json');
const OUT = resolve(ROOT, 'packages/python/sdk/src/semiont/stored.py');
const CHECK = process.argv.includes('--check');

function refuse(message) {
  console.error(`✗ ${TABLE}: ${message}`);
  process.exit(1);
}

const table = JSON.parse(readFileSync(TABLE, 'utf8'));
const stated = (value) => typeof value === 'string' && value !== '';

for (const member of Object.keys(table)) {
  if (!['$comment', 'keys', 'sessionKeyPrefix', 'storedSession'].includes(member)) refuse(`states \`${member}\`, which this generator does not render`);
}
if (!Array.isArray(table.keys) || table.keys.length === 0) refuse('states no `keys`');
const seen = new Set();
for (const entry of table.keys) {
  if (!stated(entry.member) || !/^[a-z][A-Za-z]*Key$/.test(entry.member)) refuse(`a key's \`member\` ${JSON.stringify(entry.member)} is not a constant's name ending in Key`);
  if (!stated(entry.key) || !stated(entry.docs)) refuse(`\`${entry.member}\` states no \`key\` or no \`docs\``);
  if (seen.has(entry.key)) refuse(`the key ${JSON.stringify(entry.key)} is stated twice`);
  seen.add(entry.key);
}
const prefix = table.sessionKeyPrefix;
if (!stated(prefix?.prefix) || !stated(prefix?.docs)) refuse('states no `sessionKeyPrefix` with its `prefix` and `docs`');
if (table.keys.some(({ key }) => key.startsWith(prefix.prefix))) refuse(`a fixed key begins with the session's prefix ${JSON.stringify(prefix.prefix)}, so it would read as a session's`);
const session = readFlatSchema(table.storedSession, (message) => refuse(`\`storedSession\` ${message}`));
if (session.fields.some(({ isTime }) => isTime)) refuse('`storedSession` has a date-time, which a stored session does not');

const field = ({ name, description, required }) => {
  const python = pySnake(name);
  const plain = required ? 'str' : 'str | None';
  const type = python === name ? plain : `Annotated[${plain}, Field(alias=${pyString(name)})]`;
  return `${pyComment(description, '    ')}\n    ${python}: ${type}${required ? '' : ' = None'}`;
};

const constants = table.keys.map(({ member, key, docs }) => ({ name: pyConstant(member), key, docs }));
const exported = [...constants.map(({ name }) => name), session.title, 'kb_of_session_key', 'session_key'].sort();

const text = `${pyBanner('specs/src/session/stored.json', 'scripts/spec/generate-stored-python.mjs')}
"""What a registry of knowledge bases keeps in a \`SessionStorage\` (\`specs/src/session/stored.json\`):
the key each thing it keeps is kept under, and the shape of a knowledge base's
stored session.
"""

from typing import Annotated, Final, final

from pydantic import Field

from semiont.model import WireModel

__all__ = [
${exported.map((name) => `    ${pyString(name)},`).join('\n')}
]

${constants.map(({ name, key, docs }) => `${pyComment(docs)}\n${name}: Final = ${pyString(key)}`).join('\n\n')}

${pyComment(prefix.docs)}
_SESSION_KEY_PREFIX: Final = ${pyString(prefix.prefix)}


def session_key(kb_id: str) -> str:
    """The key a knowledge base's session is kept under."""
    return f"{_SESSION_KEY_PREFIX}{kb_id}"


def kb_of_session_key(key: str) -> str | None:
    """The knowledge base a key is the session of; nothing when it is no session's key."""
    return key.removeprefix(_SESSION_KEY_PREFIX) if key.startswith(_SESSION_KEY_PREFIX) else None


@final
class ${session.title}(WireModel, frozen=True):
${pyDocstring(session.description, '    ')}

${session.fields.map(field).join('\n\n')}
`;

writeOrCheck(ROOT, OUT, text, CHECK);
