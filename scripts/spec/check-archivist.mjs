// The Archivist spec gate.
//
// What the Archivist keeps and how it is started is stated in specs/ for a
// second implementation to read instead of the code. The check fails when a
// part of that statement is missing, or when two parts that restate one fact
// disagree:
//
//   - a file the record keeps has no schema, or its schema is not a component
//     of the spec;
//   - ArchivistConfig defaults anything, or leaves optional anything but a
//     role of the roster, which is absent when no one serves it;
//   - the roster's job types are not exactly JobType, or its mark motivations
//     not exactly Motivation;
//   - the anchored-text entry's provenance is not ExtractedText's, or its
//     decline classes are not ExtractionDeclined's;
//   - the shard table is empty, or a case's shard is not two pairs of
//     lowercase hex digits;
//   - the roster table is empty, or a case's roster is not an ArchivistRoster;
//   - the roster table states no refusal, or one that lacks its reason, its
//     config or the section it must name;
//   - the protocol's account of the Archivist is missing, or does not name a
//     schema, a table, a persisted event or a route of its HTTP surface.
//
// It reads the source files, so it cannot pass on a stale bundle.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(import.meta.url), '../../..');
const SCHEMAS = resolve(REPO, 'specs/src/components/schemas');
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const schema = (name) => read(resolve(SCHEMAS, `${name}.json`));

const failures = [];
const fail = (message) => failures.push(message);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const RECORD_SCHEMAS = [
  'ResourceView',
  'ResourceAnnotations',
  'EntityTypesProjection',
  'TagSchemasProjection',
  'PeopleProjection',
  'StorageUriEntry',
  'AnchoredTextEntry',
  'AnchoredTextExtractedEntry',
  'AnchoredTextDeclinedEntry',
];
const CONFIG_SCHEMAS = ['ArchivistConfig', 'ArchivistRoster', 'ArchivistRosterRole'];
const TABLES = ['specs/src/archivist/shard-cases.json', 'specs/src/service-config/roster-cases.json'];
const PROTOCOL = 'docs/protocol/ARCHIVIST.md';

const components = read(resolve(REPO, 'specs/src/openapi.json')).components.schemas;
const present = [];
for (const name of [...RECORD_SCHEMAS, ...CONFIG_SCHEMAS]) {
  if (!existsSync(resolve(SCHEMAS, `${name}.json`))) {
    fail(`${name} has no schema in specs/src/components/schemas`);
  } else if (components[name]?.$ref !== `components/schemas/${name}.json`) {
    fail(`${name} is not a component of specs/src/openapi.json`);
  } else {
    present.push(name);
  }
}
const has = (name) => present.includes(name);

if (has('ArchivistConfig') && has('ArchivistRoster')) {
  const everythingStated = (node, path, optionalAllowed) => {
    if ('default' in node) fail(`ArchivistConfig defaults ${path}`);
    if (node.type !== 'object') return;
    for (const [name, property] of Object.entries(node.properties ?? {})) {
      const at = path ? `${path}.${name}` : name;
      if (!node.required?.includes(name) && !optionalAllowed) fail(`ArchivistConfig leaves ${at} optional`);
      const resolved = property.$ref === './ArchivistRoster.json' ? schema('ArchivistRoster') : property;
      everythingStated(resolved, at, at === 'roster.workers' || at === 'roster.workers.mark' || at === 'roster.actors');
    }
  };
  everythingStated(schema('ArchivistConfig'), '', false);

  const rosterJobTypes = Object.keys(schema('ArchivistRoster').properties.workers.properties);
  const jobTypes = schema('JobType').enum;
  if ([...rosterJobTypes].sort().join() !== [...jobTypes].sort().join()) {
    fail(`the roster's job types are [${rosterJobTypes}], JobType is [${jobTypes}]`);
  }
  const rosterMotivations = Object.keys(schema('ArchivistRoster').properties.workers.properties.mark.properties);
  const motivations = schema('Motivation').enum;
  if ([...rosterMotivations].sort().join() !== [...motivations].sort().join()) {
    fail(`the roster's mark motivations are [${rosterMotivations}], Motivation is [${motivations}]`);
  }
}

if (has('AnchoredTextEntry')) {
  const [extracted, declined] = schema('AnchoredTextEntry').oneOf.map((member) => read(resolve(SCHEMAS, member.$ref)));
  const provenance = Object.fromEntries(
    Object.entries(schema('ExtractedText').allOf[1].properties).filter(([name]) => name !== 'kind'),
  );
  for (const [name, property] of Object.entries(provenance)) {
    if (!same(extracted.properties[name], property)) fail(`AnchoredTextEntry's ${name} is not ExtractedText's`);
  }
  if (!same(declined.properties.declined, schema('ExtractionDeclined').properties.declined)) {
    fail(`AnchoredTextEntry's declined is not ExtractionDeclined's`);
  }
}

const table = (path) => (existsSync(resolve(REPO, path)) ? read(resolve(REPO, path)).cases ?? [] : null);
for (const path of TABLES) {
  const cases = table(path);
  if (cases === null) fail(`${path} is missing`);
  else if (cases.length === 0) fail(`${path} has no cases`);
}
for (const { key, shard } of table(TABLES[0]) ?? []) {
  if (!/^[0-9a-f]{2}\/[0-9a-f]{2}$/.test(shard)) fail(`shard case ${JSON.stringify(key)}: ${JSON.stringify(shard)} is not <ab>/<cd>`);
}
if (has('ArchivistRoster')) {
  const roster = schema('ArchivistRoster');
  for (const { why, roster: stated } of table(TABLES[1]) ?? []) {
    for (const group of ['workers', 'actors']) {
      if (typeof stated?.[group] !== 'object') { fail(`roster case "${why}" has no ${group}`); continue; }
      for (const role of Object.keys(stated[group])) {
        if (!(role in roster.properties[group].properties)) fail(`roster case "${why}" names ${group}.${role}, which the roster does not have`);
      }
      for (const motivation of Object.keys((group === 'workers' && stated.workers.mark) || {})) {
        if (!(motivation in roster.properties.workers.properties.mark.properties)) fail(`roster case "${why}" names workers.mark.${motivation}, which the roster does not have`);
      }
    }
  }
}
if (existsSync(resolve(REPO, TABLES[1]))) {
  const refusals = read(resolve(REPO, TABLES[1])).refusals ?? [];
  if (refusals.length === 0) fail(`${TABLES[1]} states no refusal`);
  for (const [index, refusal] of refusals.entries()) {
    for (const member of ['why', 'config', 'names']) {
      if (typeof refusal[member] !== 'string' || refusal[member] === '') fail(`roster refusal ${refusal.why ? `"${refusal.why}"` : `#${index + 1}`} has no ${member}`);
    }
  }
}

if (!existsSync(resolve(REPO, PROTOCOL))) {
  fail(`${PROTOCOL} is missing`);
} else {
  const protocol = readFileSync(resolve(REPO, PROTOCOL), 'utf8');
  const named = (what, term) => { if (!protocol.includes(term)) fail(`${PROTOCOL} does not name ${what} ${term}`); };
  for (const name of [...RECORD_SCHEMAS.filter((name) => !/^AnchoredText.+Entry$/.test(name)), 'ArchivistConfig']) named('the schema', name);
  for (const path of TABLES) named('the table', path.split('/').pop());
  const registry = read(resolve(REPO, 'specs/src/bus/registry.json'));
  const persisted = registry.channels
    .filter((channel) => channel.shape === 'storedEvent')
    .map((channel) => channel.channel);
  if (persisted.length === 0) fail('the bus registry names no persisted event: the check has lost what it reads');
  for (const type of persisted) named('the persisted event', `\`${type}\``);
  const surface = read(resolve(REPO, 'specs/src/archivist/openapi.json'));
  for (const path of Object.keys(surface.paths)) named('the route', `\`${path}\``);
}

if (failures.length > 0) {
  for (const message of failures) console.error(`✗ ${message}`);
  process.exit(1);
}
console.log(`✓ the Archivist is specified (${RECORD_SCHEMAS.length} file-format schemas, its configuration document, ${TABLES.length} shared tables, ${PROTOCOL})`);
