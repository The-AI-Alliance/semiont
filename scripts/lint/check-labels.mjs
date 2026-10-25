#!/usr/bin/env node
/**
 * lint:labels — .github/labels.yml is every label the repository has, and
 * what names a label names one of them.
 *
 * The Labels workflow makes the repository's labels main's .github/labels.yml:
 * it creates, updates, renames and deletes until they agree, so a label made
 * by hand lasts until the next sync. The file is read here as the workflow's
 * action reads it, every value a string (js-yaml's FAILSAFE_SCHEMA).
 *
 * 1. Each entry is a `name`, a `color` (six lower-case hex digits, as GitHub
 *    returns a colour), a `description`, and a `from_name` while a rename
 *    waits for its sync. A description left out is one the file does not
 *    hold: the action leaves GitHub's as it is. GitHub keeps 50 characters
 *    of a name and 100 of a description. Names, and the names renamed from,
 *    are unique as GitHub compares them, without case.
 * 2. A label is `<dimension>:<value>`, for a dimension below, or one of the
 *    few of no dimension, each listed below with why. The labels of a
 *    dimension share one colour.
 * 3. Five dimensions restate what something else owns, and are held to it
 *    both ways:
 *      app:    the directories under apps/
 *      tests:  the directories under tests/
 *      spec:   the parts of the spec, listed below by who honours them; every
 *              directory under specs/src/, and every file directly in it, is
 *              in exactly one
 *      verb:   the namespaces of specs/src/client/surface.json, but the ones
 *              listed below as no verb
 *      stack:  the kinds the schemas of specs/src/stack are for, in kebab case
 *    sdk: has a label for every SDK the repository holds (packages/sdk, the
 *    TypeScript one, and each packages/sdk-<language>), and for the languages
 *    ruled ahead of their SDKs. kind: and media: are vocabularies, and
 *    nothing owns them.
 * 4. Every entry of .github/dependabot.yml states its labels. One that states
 *    none gets Dependabot's own, which the next sync deletes; a label it
 *    names that does not exist it never applies. They are kind:dependencies
 *    and, when every directory of the entry is in one app, test suite or SDK,
 *    that one's label. An entry that reaches several is labelled by none of
 *    them: each of its pull requests may touch any one.
 *
 * WHAT THE REPOSITORY HOLDS is what git says it does (repository-files.mjs).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { repositoryFiles } from './repository-files.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const LABELS = '.github/labels.yml';
const DEPENDABOT = '.github/dependabot.yml';
const SURFACE = 'specs/src/client/surface.json';
const STACK = 'specs/src/stack/';

const DIMENSIONS = ['kind', 'verb', 'app', 'sdk', 'stack', 'spec', 'media', 'tests'];
const KEYS = ['name', 'color', 'description', 'from_name'];

/** Labels of no dimension, each with why. */
const OF_NO_DIMENSION = {
  'good first issue': 'GitHub reads it by this name: its contribute page and its search (good-first-issues:) find the issues that carry it',
  'help wanted': 'GitHub reads it by this name: its search (help-wanted-issues:) counts the issues that carry it',
  Ontology: 'where it belongs is not yet ruled',
};

/** Namespaces of the client's surface that are no verb, each with what it is. */
const NOT_A_VERB = {
  job: "jobs' lifecycle, which the verbs' delegated work runs as",
  auth: "the gateway's view of who is signed in",
  system: 'what the knowledge base says about itself',
};

/** The parts of the spec, by who honours them, each the entries of specs/src it holds. */
const SPEC_PARTS = {
  protocol: ['openapi.json', 'components', 'paths', 'bus', 'identifiers', 'principals', 'jobs', 'media-types', 'locales'],
  sdk: ['client', 'session', 'retry', 'resources', 'errors', 'sdk-telemetry'],
  services: ['archivist', 'librarian', 'smelter', 'weaver', 'worker', 'follower', 'graph', 'vectors', 'text', 'annotations', 'service-environment', 'service-telemetry'],
  launcher: ['stack', 'kb-identity', 'discovery', 'sign-in-store'],
};

/** The directory of packages/ that holds the TypeScript SDK; every other SDK's is sdk-<language>. */
const TYPESCRIPT_SDK = 'sdk';

const failures = [];
const fail = (message) => failures.push(message);
const files = repositoryFiles(ROOT);

/** The directories directly under `top`, as git holds them. */
const directoriesUnder = (top) => new Set(files.filter((file) => file.startsWith(`${top}/`) && file.split('/').length > 2).map((file) => file.split('/')[1]));
const sdkLanguage = (directory) => (directory === TYPESCRIPT_SDK ? 'typescript' : directory.slice('sdk-'.length));
const isSdk = (directory) => directory === TYPESCRIPT_SDK || directory.startsWith('sdk-');

// Rule 1: each entry is a label GitHub can hold.
const entries = yaml.load(readFileSync(join(ROOT, LABELS), 'utf8'), { schema: yaml.FAILSAFE_SCHEMA });
if (!Array.isArray(entries) || entries.length === 0) {
  console.error(`❌ lint:labels — ${LABELS} is no list of labels`);
  process.exit(1);
}
const labels = [];
const named = new Map();
for (const [index, entry] of entries.entries()) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    fail(`${LABELS}, entry ${index + 1}: not a mapping`);
    continue;
  }
  const { name, color, description, from_name: fromName } = entry;
  if (typeof name !== 'string' || name === '') {
    fail(`${LABELS}, entry ${index + 1}: no name`);
    continue;
  }
  for (const key of Object.keys(entry)) if (!KEYS.includes(key)) fail(`${name}: ${key} is nothing a label has (${KEYS.join(', ')})`);
  if (name.length > 50) fail(`${name}: the name is ${name.length} characters, and GitHub keeps 50`);
  if (typeof color !== 'string' || !/^[0-9a-f]{6}$/.test(color)) fail(`${name}: the color ${JSON.stringify(color)} is not six lower-case hex digits`);
  if (typeof description !== 'string') fail(`${name}: no description, so the sync leaves GitHub's, which the file does not hold`);
  else if (description.length > 100) fail(`${name}: the description is ${description.length} characters, and GitHub keeps 100`);
  const names = fromName === undefined ? [name] : [name, fromName];
  if (fromName === '') fail(`${name}: from_name is empty`);
  for (const said of names) {
    const key = said.toLowerCase();
    if (named.has(key)) fail(`"${said}" is named twice in ${LABELS} (by ${named.get(key)} and ${name}): GitHub compares names without case`);
    else named.set(key, name);
  }
  labels.push({ name, color });
}

// Rule 2: every label is of a dimension, or listed as of none.
const byDimension = new Map(DIMENSIONS.map((dimension) => [dimension, []]));
for (const { name, color } of labels) {
  if (!name.includes(':')) {
    if (!(name in OF_NO_DIMENSION)) fail(`${name} is of no dimension: name it <dimension>:<value> (${DIMENSIONS.join(', ')}), or list it in OF_NO_DIMENSION with why`);
    continue;
  }
  const [dimension, value, ...more] = name.split(':');
  if (!byDimension.has(dimension)) fail(`${name}: ${dimension} is no dimension (${DIMENSIONS.join(', ')})`);
  else if (more.length > 0 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) fail(`${name}: a value is lower-case words joined by hyphens`);
  else byDimension.get(dimension).push({ value, color });
}
for (const [name, why] of Object.entries(OF_NO_DIMENSION)) {
  if (!labels.some((label) => label.name === name)) fail(`${name} is listed as of no dimension (${why}), and ${LABELS} has no such label: take it off the list`);
}
for (const [dimension, of] of byDimension) {
  if (of.length === 0) fail(`${LABELS} has no ${dimension}: label`);
  const colours = new Set(of.map((label) => label.color));
  if (colours.size > 1) fail(`the ${dimension}: labels have ${colours.size} colours (${[...colours].join(', ')}); a dimension has one`);
}

// Rule 3: the dimensions that restate what something else owns.
const valuesOf = (dimension) => new Set(byDimension.get(dimension).map((label) => label.value));
function heldBothWays(dimension, owned, owner) {
  if (owned.size === 0) fail(`${owner} names nothing: the check has lost what it reads`);
  const have = valuesOf(dimension);
  for (const value of owned) if (!have.has(value)) fail(`${owner} has ${value}, and ${LABELS} has no ${dimension}:${value}`);
  for (const value of have) if (!owned.has(value)) fail(`${dimension}:${value} names nothing ${owner} has`);
}
heldBothWays('app', directoriesUnder('apps'), 'apps/');
heldBothWays('tests', directoriesUnder('tests'), 'tests/');

/** What specs/src holds: its directories, and the files directly in it. */
const specEntries = new Set(files.filter((file) => file.startsWith('specs/src/')).map((file) => file.split('/')[2]));
for (const entry of specEntries) {
  const parts = Object.keys(SPEC_PARTS).filter((part) => SPEC_PARTS[part].includes(entry));
  if (parts.length !== 1) fail(`specs/src/${entry} is in ${parts.length === 0 ? 'no part' : `${parts.length} parts (${parts.join(', ')})`} of SPEC_PARTS; each is in one`);
}
for (const [part, entries] of Object.entries(SPEC_PARTS)) {
  for (const entry of entries) if (!specEntries.has(entry)) fail(`SPEC_PARTS lists specs/src/${entry} under ${part}, and specs/src has no such entry: take it off the list`);
}
heldBothWays('spec', new Set(Object.keys(SPEC_PARTS)), 'the parts of the spec (SPEC_PARTS)');

const namespaces = JSON.parse(readFileSync(join(ROOT, SURFACE), 'utf8')).namespaces.map((namespace) => namespace.namespace);
for (const [namespace, what] of Object.entries(NOT_A_VERB)) {
  if (!namespaces.includes(namespace)) fail(`${namespace} is listed as no verb (${what}), and ${SURFACE} has no such namespace: take it off the list`);
}
heldBothWays('verb', new Set(namespaces.filter((namespace) => !(namespace in NOT_A_VERB))), `the verbs of ${SURFACE}`);

/** A schema's kind is the one value its `kind` property admits. */
const kinds = files
  .filter((file) => file.startsWith(STACK) && file.endsWith('.json'))
  .map((file) => JSON.parse(readFileSync(join(ROOT, file), 'utf8')).properties?.kind?.const)
  .filter((kind) => typeof kind === 'string')
  .map((kind) => kind.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase());
heldBothWays('stack', new Set(kinds), `the kinds of ${STACK}`);

const sdks = [...directoriesUnder('packages')].filter(isSdk);
if (sdks.length === 0) fail('packages/ holds no SDK: the check has lost what it reads');
for (const directory of sdks) {
  if (!valuesOf('sdk').has(sdkLanguage(directory))) fail(`packages/${directory} is an SDK, and ${LABELS} has no sdk:${sdkLanguage(directory)}`);
}

// Rule 4: Dependabot applies labels the file has, and the ones its directories give it.
/** The label of the one app, test suite or SDK a directory is in, or null for one in none. */
function ownLabel(directory) {
  const [top, below] = directory.replace(/^\/+/, '').split('/');
  if (below === undefined || below === '') return null;
  if (top === 'apps') return `app:${below}`;
  if (top === 'tests') return `tests:${below}`;
  if (top === 'packages' && isSdk(below)) return `sdk:${sdkLanguage(below)}`;
  return null;
}
const labelNames = new Set(labels.map((label) => label.name));
const updates = yaml.load(readFileSync(join(ROOT, DEPENDABOT), 'utf8')).updates;
for (const update of updates) {
  const directories = update.directories ?? [update.directory];
  const at = `${DEPENDABOT}: the ${update['package-ecosystem']} entry for ${directories.join(', ')}`;
  if (!Array.isArray(update.labels)) {
    fail(`${at} states no labels, so Dependabot applies its own, which the next sync deletes`);
    continue;
  }
  for (const label of update.labels) if (!labelNames.has(label)) fail(`${at} applies ${label}, which ${LABELS} does not have`);
  const reached = new Set(directories.map(ownLabel));
  const given = ['kind:dependencies', ...(reached.size === 1 && !reached.has(null) ? reached : [])];
  if ([...update.labels].sort().join() !== [...given].sort().join()) {
    fail(`${at} applies ${update.labels.join(', ')}, and its directories give it ${given.join(', ')}: kind:dependencies, and the one app, test suite or SDK they are all in`);
  }
}

if (failures.length > 0) {
  console.error(`❌ lint:labels — ${failures.length} problem(s):`);
  for (const failure of failures) console.error(`   ${failure}`);
  process.exit(1);
}
console.log(
  `✅ lint:labels — ${labels.length} labels in ${LABELS}, ${DIMENSIONS.length} dimensions of one colour each; app:, tests:, spec:, verb: and stack: agree with what they name, every SDK has its sdk:, and each of ${updates.length} Dependabot entries applies the labels its directories give it`,
);
