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
 *    few of no dimension, each listed below with why. Its colour says what it
 *    is: two labels share a colour exactly when they are in one colour group.
 *    A dimension is one group, but kind:, whose every label is its own group,
 *    and verb:, whose groups are the three ways a verb works on the corpus,
 *    listed below. A label of no dimension is its own group.
 * 3. Six dimensions restate what something else owns, and are held to it
 *    both ways:
 *      app:    the directories under apps/, whose libraries are
 *              packages/<language>/<app>/
 *      image:  the directories under images/
 *      tests:  the directories under tests/
 *      spec:   the parts of the spec, by who honours them (SPEC_PARTS); every
 *              directory under specs/src/, and every file directly in it, is
 *              in exactly one
 *      verb:   the namespaces of specs/src/client/surface.json, but the ones
 *              listed below as no verb
 *      stack:  the kinds the schemas of specs/src/stack are for, in kebab case
 *    sdk: has a label for every SDK the repository holds (each
 *    packages/<language>/sdk), and for the languages ruled ahead of their
 *    SDKs. The app:, image:, tests: and sdk: values
 *    the repository owns are the labels its files give (path-labels.mjs),
 *    the rule the Path Labels workflow applies to a pull request's files. kind:
 *    and media: are vocabularies, and nothing owns them.
 * 4. Every entry of .github/dependabot.yml states its labels. One that states
 *    none gets Dependabot's own, which the next sync deletes; a label it
 *    names that does not exist it never applies. They are kind:dependencies
 *    and, when every directory of the entry gives one path label, that label.
 *    An entry that reaches several is labelled by none of them: each of its
 *    pull requests may touch any one, and gets the ones its files give from
 *    the Path Labels workflow.
 *
 * WHAT THE REPOSITORY HOLDS is what git says it does (repository-files.mjs).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { pathLabel, SPEC_PARTS } from './path-labels.mjs';
import { repositoryFiles } from './repository-files.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const LABELS = '.github/labels.yml';
const DEPENDABOT = '.github/dependabot.yml';
const SURFACE = 'specs/src/client/surface.json';
const STACK = 'specs/src/stack/';

const DIMENSIONS = ['kind', 'verb', 'app', 'image', 'sdk', 'stack', 'spec', 'media', 'tests'];
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

/** The verbs by what each does to the corpus, as the docs group them: each group is one colour. */
const VERB_GROUPS = {
  writing: ['yield', 'mark', 'bind', 'frame'],
  reading: ['browse', 'match', 'gather'],
  attention: ['beckon'],
};

const failures = [];
const fail = (message) => failures.push(message);
const files = repositoryFiles(ROOT);

/** The labels the repository's files give (path-labels.mjs). */
const pathLabels = new Set(files.map(pathLabel).filter((label) => label !== null));
/** The values of a dimension that the repository's files give. */
const givenIn = (dimension) => new Set([...pathLabels].filter((label) => label.startsWith(`${dimension}:`)).map((label) => label.slice(dimension.length + 1)));

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
for (const [dimension, of] of byDimension) if (of.length === 0) fail(`${LABELS} has no ${dimension}: label`);

const verbs = byDimension.get('verb').map((label) => label.value);
for (const verb of verbs) {
  const groups = Object.keys(VERB_GROUPS).filter((group) => VERB_GROUPS[group].includes(verb));
  if (groups.length !== 1) fail(`verb:${verb} is in ${groups.length === 0 ? 'no group' : `${groups.length} groups (${groups.join(', ')})`} of VERB_GROUPS; each verb is in one`);
}
for (const [group, members] of Object.entries(VERB_GROUPS)) {
  for (const verb of members) if (!verbs.includes(verb)) fail(`VERB_GROUPS lists ${verb} under ${group}, and ${LABELS} has no verb:${verb}: take it off the list`);
}

/** The colour group a label is in. */
function colourGroup(name) {
  const [dimension, value] = name.split(':');
  if (value === undefined || dimension === 'kind') return name;
  if (dimension === 'verb') return `verb: ${Object.keys(VERB_GROUPS).find((group) => VERB_GROUPS[group].includes(value))}`;
  return `${dimension}:`;
}
const addTo = (map, key, value) => {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
};
const coloursOf = new Map();
const groupsOf = new Map();
for (const { name, color } of labels) {
  addTo(coloursOf, colourGroup(name), color);
  addTo(groupsOf, color, colourGroup(name));
}
for (const [group, colours] of coloursOf) if (colours.size > 1) fail(`${group} has ${colours.size} colours (${[...colours].join(', ')}); a colour group has one`);
for (const [color, groups] of groupsOf) if (groups.size > 1) fail(`${color} is the colour of ${[...groups].join(' and ')}; a colour says one group`);

// Rule 3: the dimensions that restate what something else owns.
const valuesOf = (dimension) => new Set(byDimension.get(dimension).map((label) => label.value));
function heldBothWays(dimension, owned, owner) {
  if (owned.size === 0) fail(`${owner} names nothing: the check has lost what it reads`);
  const have = valuesOf(dimension);
  for (const value of owned) if (!have.has(value)) fail(`${owner} has ${value}, and ${LABELS} has no ${dimension}:${value}`);
  for (const value of have) if (!owned.has(value)) fail(`${dimension}:${value} names nothing ${owner} has`);
}
heldBothWays('app', givenIn('app'), 'apps/');
heldBothWays('image', givenIn('image'), 'images/');
heldBothWays('tests', givenIn('tests'), 'tests/');

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

const sdks = givenIn('sdk');
if (sdks.size === 0) fail('packages/ holds no SDK: the check has lost what it reads');
for (const language of sdks) {
  if (!valuesOf('sdk').has(language)) fail(`packages/ holds the ${language} SDK, and ${LABELS} has no sdk:${language}`);
}

// Rule 4: Dependabot applies labels the file has, and the ones its directories give it.
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
  const reached = new Set(directories.map((directory) => pathLabel(`${directory.replace(/\/+$/, '')}/`)));
  const given = ['kind:dependencies', ...(reached.size === 1 && !reached.has(null) ? reached : [])];
  if ([...update.labels].sort().join() !== [...given].sort().join()) {
    fail(`${at} applies ${update.labels.join(', ')}, and its directories give it ${given.join(', ')}: kind:dependencies, and the one path label they all give`);
  }
}

if (failures.length > 0) {
  console.error(`❌ lint:labels — ${failures.length} problem(s):`);
  for (const failure of failures) console.error(`   ${failure}`);
  process.exit(1);
}
console.log(
  `✅ lint:labels — ${labels.length} labels in ${LABELS}, ${DIMENSIONS.length} dimensions, each colour one group's; app:, image:, tests:, spec:, verb: and stack: agree with what they name, every SDK has its sdk:, and each of ${updates.length} Dependabot entries applies the labels its directories give it`,
);
