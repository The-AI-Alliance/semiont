#!/usr/bin/env node
// generate-stored-python.mjs — generate what the Python SDK's registry keeps
// in a SessionStorage from protocol/specs/src/session/stored.json: the key each thing
// is kept under, the key of a knowledge base's session, the keys of what a
// session keeps of its stream and its queries, the stored session's shape, an
// open resource's, the queries a client keeps (read by kept-queries.mjs) with
// the key of one per nothing and the version of what keeps them, and the shape
// of the stream's places.
//
//   packages/python/sdk/src/semiont/stored.py
//
// A registry in one SDK finds what one in another wrote, over one storage,
// only if both say these alike. The other SDKs state them by hand or read the
// table, each held to it by a test; Python's are this. The reading of the
// session's schema is sign-in-schema.mjs's; an open resource's members are
// not all text, so its reading is this file's own. The pending sign-in's shape is
// not rendered here: semiont/http/oauth.py states it, and
// packages/python/sdk/tests/test_registry_http.py holds it to the table. What
// a document of a kept query holds is semiont/storage.py's, held to
// protocol/specs/src/session/cache-cases.json by
// packages/python/sdk/tests/test_cache_cases.py.
//
// --check compares without writing (the CI drift gate).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeOrCheck } from '../lib/committed-source.mjs';
import { pyBanner, pyComment, pyConstant, pyDocstring, pySnake, pyString } from '../lib/python-source.mjs';
import { readIdentifierKinds } from './identifier-kinds.mjs';
import { readKeptQueries, WHOLE } from './kept-queries.mjs';
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
  if (!['$comment', 'keys', 'sessionKeyPrefix', 'lastEventIdKeyPrefix', 'cacheKeyPrefix', 'keptQueries', 'wholeKey', 'storedSession', 'pendingAuthorization', 'openResource', 'cacheDocument', 'lastEventIds'].includes(member)) refuse(`states \`${member}\`, which this generator does not render`);
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

const { kept, wholeKey, version } = readKeptQueries(ROOT, refuse);
if (!stated(table.wholeKey.docs)) refuse('`wholeKey` states no `docs`');
const versionDocs = table.cacheDocument.properties.version.description;
if (!stated(versionDocs)) refuse("`cacheDocument`'s `version` has no description");

/** The component a `$ref` names, refused unless it is one. */
function componentOf(form, where, wrong) {
  const name = /^\.\.\/components\/schemas\/([A-Za-z]+)\.json$/.exec(form?.$ref ?? '')?.[1];
  if (Object.keys(form ?? {}).join(' ') !== '$ref' || name === undefined || !existsSync(resolve(SCHEMAS, `${name}.json`))) {
    wrong(`\`${where}\` is a ${JSON.stringify(form)}, not a $ref to a component`);
  }
  return name;
}

/** `lastEventIds`'s title and description, the kind of id it names its members by, and the component each member is. */
function readLastEventIds(schema) {
  const wrong = (message) => refuse(`\`lastEventIds\` ${message}`);
  for (const keyword of Object.keys(schema ?? {})) {
    if (!['title', 'type', 'description', 'propertyNames', 'additionalProperties'].includes(keyword)) wrong(`uses \`${keyword}\`, which this generator does not render`);
  }
  if (schema?.type !== 'object') wrong('is not an object schema');
  if (!stated(schema.title) || !/^[A-Z][A-Za-z]*$/.test(schema.title)) wrong('has no title that names a type');
  if (!stated(schema.description)) wrong('has no description');
  const scope = componentOf(schema.propertyNames, 'propertyNames', wrong);
  if (!kinds.has(scope)) wrong(`names its members by ${scope}, which is no kind of id`);
  return { title: schema.title, description: schema.description, scope, place: componentOf(schema.additionalProperties, 'additionalProperties', wrong) };
}
const lastEventIds = readLastEventIds(table.lastEventIds);

const named = [lastEventIds.scope, lastEventIds.place];
const identifiers = [...new Set([...openResource.fields.flatMap(({ kind }) => (kind === undefined ? [] : [kind])), ...named.filter((name) => kinds.has(name))])].sort();
const components = [...new Set(named.filter((name) => !kinds.has(name)))].sort();

/** What a kept query's entries are keyed by, and what each keeps. */
const keptAs = ({ key, component, member }) => {
  const value = member === undefined ? component : `${component}'s \`${member}\``;
  return `Keyed by ${key === WHOLE ? 'WHOLE_KEY alone' : key}; its value is ${value}.`;
};

const field = ({ name, description, required, type, least }) => {
  const python = pySnake(name);
  const plain = required ? type : `${type} | None`;
  const said = [...(python === name ? [] : [`alias=${pyString(name)}`]), ...(least === undefined ? [] : [`ge=${least}`])];
  const annotated = said.length === 0 ? plain : `Annotated[${plain}, Field(${said.join(', ')})]`;
  return `${pyComment(description, '    ')}\n    ${python}: ${annotated}${required ? '' : ' = None'}`;
};

const constants = table.keys.map(({ member, key, docs }) => ({ name: pyConstant(member), key, docs }));
const exported = [
  ...[...constants.map(({ name }) => name), 'CACHE_DOCUMENT_VERSION', 'KEPT_QUERIES', 'WHOLE_KEY'].sort(),
  ...[session.title, openResource.title, lastEventIds.title, 'KeptQuery', 'WholeKey'].sort(),
  'cache_key',
  'kb_of_session_key',
  'last_event_id_key',
  'session_key',
];

const text = `${pyBanner('protocol/specs/src/session/stored.json', 'packages/codegen/schemas/generate-stored-python.mjs')}
"""What a registry of knowledge bases keeps in a \`SessionStorage\` (\`protocol/specs/src/session/stored.json\`):
the key each thing it keeps is kept under, the shape of a knowledge base's
stored session, and the shape of a resource open in one. And what the
sessions it makes keep there: which queries, and the stream's places.
"""

from typing import Annotated, Final, Literal, final

from pydantic import Field
${identifiers.length === 0 ? '' : `\nfrom semiont.identifiers import ${identifiers.join(', ')}`}
from semiont.model import WireModel${components.length === 0 ? '' : `\nfrom semiont.types import ${components.join(', ')}`}

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
    """The key a knowledge base's stream's places are kept under, as \`${lastEventIds.title}\`."""
    return f"{_LAST_EVENT_ID_KEY_PREFIX}{kb_id}"


${pyComment(lastEventIds.description)}
type ${lastEventIds.title} = dict[${lastEventIds.scope}, ${lastEventIds.place}]


${pyComment(cachePrefix.docs)}
_CACHE_KEY_PREFIX: Final = ${pyString(cachePrefix.prefix)}

# The queries a client keeps across a restart, each by its name in
# protocol/specs/src/client/refresh.json, and each as one document under \`cache_key\`.
type KeptQuery = Literal[
${kept.map((each) => `${pyComment(keptAs(each), '    ')}\n    ${pyString(each.query)},`).join('\n')}
]

KEPT_QUERIES: Final[tuple[KeptQuery, ...]] = (
${kept.map(({ query }) => `    ${pyString(query)},`).join('\n')}
)


def cache_key(key_prefix: str, query: KeptQuery) -> str:
    """The key \`query\` is kept under, by a persistence whose key prefix is \`key_prefix\`."""
    return f"{_CACHE_KEY_PREFIX}{key_prefix}.{query}"


${pyComment(table.wholeKey.docs)}
type WholeKey = Literal[${pyString(wholeKey)}]
WHOLE_KEY: Final[WholeKey] = ${pyString(wholeKey)}

${pyComment(versionDocs)}
CACHE_DOCUMENT_VERSION: Final = ${version}


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
