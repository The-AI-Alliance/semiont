#!/usr/bin/env node
// generate-stored-python.mjs — generate what the Python SDK's registry keeps
// in a SessionStorage from protocol/specs/src/session/stored.json: the key each thing
// is kept under, the key of a knowledge base's session, the keys of what a
// session keeps of its stream and its queries, the stored session's shape, and
// an open resource's.
//
//   packages/python/sdk/src/semiont/stored.py
//
// A registry in one SDK finds what one in another wrote, over one storage,
// only if both say these alike. The other SDKs state them by hand or read the
// table, each held to it by a test; Python's are this. The reading of the
// session's schema is sign-in-schema.mjs's; an open resource's members are
// not all text, so its reading is this file's own. The pending sign-in's shape is
// not rendered here: semiont/http/oauth.py states it, and
// packages/python/sdk/tests/test_registry_http.py holds it to the table.
//
// --check compares without writing (the CI drift gate).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeOrCheck } from '../lib/committed-source.mjs';
import { pyBanner, pyComment, pyConstant, pyDocstring, pySnake, pyString } from '../lib/python-source.mjs';
import { readIdentifierKinds } from './identifier-kinds.mjs';
import { readFlatSchema } from './sign-in-schema.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TABLE = resolve(ROOT, 'protocol/specs/src/session/stored.json');
const KINDS = resolve(ROOT, 'protocol/specs/src/identifiers/kinds.json');
const SCHEMAS = resolve(ROOT, 'protocol/specs/src/components/schemas');
const OUT = resolve(ROOT, 'packages/python/sdk/src/semiont/stored.py');
const CHECK = process.argv.includes('--check');

function refuse(message) {
  console.error(`✗ ${TABLE}: ${message}`);
  process.exit(1);
}

const table = JSON.parse(readFileSync(TABLE, 'utf8'));
const stated = (value) => typeof value === 'string' && value !== '';

for (const member of Object.keys(table)) {
  if (!['$comment', 'keys', 'sessionKeyPrefix', 'lastEventIdKeyPrefix', 'cacheKeyPrefix', 'storedSession', 'pendingAuthorization', 'openResource'].includes(member)) refuse(`states \`${member}\`, which this generator does not render`);
}
if (!Array.isArray(table.keys) || table.keys.length === 0) refuse('states no `keys`');
const seen = new Set();
for (const entry of table.keys) {
  if (!stated(entry.member) || !/^[a-z][A-Za-z]*Key$/.test(entry.member)) refuse(`a key's \`member\` ${JSON.stringify(entry.member)} is not a constant's name ending in Key`);
  if (!stated(entry.key) || !stated(entry.docs)) refuse(`\`${entry.member}\` states no \`key\` or no \`docs\``);
  if (seen.has(entry.key)) refuse(`the key ${JSON.stringify(entry.key)} is stated twice`);
  seen.add(entry.key);
}
/** The prefix `member` states, refused unless it has its `docs` and no fixed key begins with it. */
function prefixOf(member) {
  const prefixed = table[member];
  if (!stated(prefixed?.prefix) || !stated(prefixed?.docs)) refuse(`states no \`${member}\` with its \`prefix\` and \`docs\``);
  if (table.keys.some(({ key }) => key.startsWith(prefixed.prefix))) refuse(`a fixed key begins with \`${member}\`'s ${JSON.stringify(prefixed.prefix)}, so it would read as one of its keys`);
  return prefixed;
}
const prefix = prefixOf('sessionKeyPrefix');
const lastEventIdPrefix = prefixOf('lastEventIdKeyPrefix');
const cachePrefix = prefixOf('cacheKeyPrefix');
const session = readFlatSchema(table.storedSession, (message) => refuse(`\`storedSession\` ${message}`));
if (session.fields.some(({ isTime }) => isTime)) refuse('`storedSession` has a date-time, which a stored session does not');

const kinds = new Set(readIdentifierKinds(KINDS, SCHEMAS, (message) => refuse(`${KINDS}: ${message}`)).map(({ name }) => name));

/** A member's Python type and the least it may be, refused unless its form is one rendered here: a kind of id, text, or a whole number. */
function typeOf(name, form, wrong) {
  const keywords = Object.keys(form).sort().join(' ');
  if (keywords === 'allOf') {
    const [reference, ...more] = Array.isArray(form.allOf) ? form.allOf : [];
    const kind = /^\.\.\/components\/schemas\/([A-Za-z]+)\.json$/.exec(reference?.$ref ?? '')?.[1];
    if (more.length > 0 || Object.keys(reference ?? {}).join(' ') !== '$ref' || !kinds.has(kind)) wrong(`\`${name}\` is an \`allOf\` other than one kind of id, which this generator does not render`);
    return { type: kind, kind };
  }
  if (keywords === 'type' && form.type === 'string') return { type: 'str' };
  if ((keywords === 'type' || keywords === 'minimum type') && form.type === 'integer') {
    if (form.minimum !== undefined && !Number.isInteger(form.minimum)) wrong(`\`${name}\` has a \`minimum\` that is not a whole number`);
    return { type: 'int', least: form.minimum };
  }
  wrong(`\`${name}\` is a ${JSON.stringify(form)}, which this generator does not render`);
}

/** `openResource`'s title, description and members. */
function readOpenResource(schema) {
  const wrong = (message) => refuse(`\`openResource\` ${message}`);
  for (const keyword of Object.keys(schema ?? {})) {
    if (!['title', 'type', 'description', 'properties', 'required'].includes(keyword)) wrong(`uses \`${keyword}\`, which this generator does not render`);
  }
  if (schema?.type !== 'object') wrong('is not an object schema');
  if (!stated(schema.title) || !/^[A-Z][A-Za-z]*$/.test(schema.title)) wrong('has no title that names a type');
  if (!stated(schema.description)) wrong('has no description');
  const properties = Object.entries(schema.properties ?? {});
  if (properties.length === 0) wrong('states no properties');
  const required = schema.required;
  if (!Array.isArray(required) || required.length === 0) wrong('requires nothing');
  for (const name of required) {
    if (!Object.hasOwn(schema.properties, name)) wrong(`requires \`${name}\`, which is not a property`);
  }
  const fields = properties.map(([name, { description, ...form }]) => {
    if (!/^[a-z][A-Za-z]*$/.test(name)) wrong(`\`${name}\` is not a camelCase property name`);
    if (!stated(description)) wrong(`\`${name}\` has no description`);
    return { name, description, required: required.includes(name), ...typeOf(name, form, wrong) };
  });
  return { title: schema.title, description: schema.description, fields };
}
const openResource = readOpenResource(table.openResource);
const identifiers = [...new Set(openResource.fields.flatMap(({ kind }) => (kind === undefined ? [] : [kind])))].sort();

const field = ({ name, description, required, type, least }) => {
  const python = pySnake(name);
  const plain = required ? type : `${type} | None`;
  const said = [...(python === name ? [] : [`alias=${pyString(name)}`]), ...(least === undefined ? [] : [`ge=${least}`])];
  const annotated = said.length === 0 ? plain : `Annotated[${plain}, Field(${said.join(', ')})]`;
  return `${pyComment(description, '    ')}\n    ${python}: ${annotated}${required ? '' : ' = None'}`;
};

const constants = table.keys.map(({ member, key, docs }) => ({ name: pyConstant(member), key, docs }));
const exported = [...constants.map(({ name }) => name).sort(), ...[session.title, openResource.title].sort(), 'kb_of_session_key', 'session_key'];

const text = `${pyBanner('protocol/specs/src/session/stored.json', 'packages/codegen/schemas/generate-stored-python.mjs')}
"""What a registry of knowledge bases keeps in a \`SessionStorage\` (\`protocol/specs/src/session/stored.json\`):
the key each thing it keeps is kept under, the shape of a knowledge base's
stored session, and the shape of a resource open in one.
"""

from typing import Annotated, Final, final

from pydantic import Field
${identifiers.length === 0 ? '' : `\nfrom semiont.identifiers import ${identifiers.join(', ')}`}
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


${pyComment(lastEventIdPrefix.docs)}
_LAST_EVENT_ID_KEY_PREFIX: Final = ${pyString(lastEventIdPrefix.prefix)}


def last_event_id_key(kb_id: str) -> str:
    """The key a knowledge base's stream's places are kept under."""
    return f"{_LAST_EVENT_ID_KEY_PREFIX}{kb_id}"


${pyComment(cachePrefix.docs)}
_CACHE_KEY_PREFIX: Final = ${pyString(cachePrefix.prefix)}


def cache_key(key_prefix: str, name: str) -> str:
    """The key the query \`name\` is kept under, by a persistence whose key prefix is \`key_prefix\`."""
    return f"{_CACHE_KEY_PREFIX}{key_prefix}.{name}"


@final
class ${session.title}(WireModel, frozen=True):
${pyDocstring(session.description, '    ')}

${session.fields.map((each) => field({ ...each, type: 'str' })).join('\n\n')}


@final
class ${openResource.title}(WireModel, frozen=True):
${pyDocstring(openResource.description, '    ')}

${openResource.fields.map(field).join('\n\n')}
`;

writeOrCheck(ROOT, OUT, text, CHECK);
