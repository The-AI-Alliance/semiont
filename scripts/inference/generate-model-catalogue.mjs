#!/usr/bin/env node
// Generate a model catalogue file: the part of the models.dev catalogue a
// Python inference driver reads, from the npm package @opencode-ai/models at
// the one version the repository's package.json pins.
//
//   node scripts/inference/generate-model-catalogue.mjs --out <directory>
//   node scripts/inference/generate-model-catalogue.mjs --check <directory>
//
// `--out` writes two files in <directory>, and `--check` compares them
// without writing:
//
//   model-catalogue.json      the catalogue file
//   model-catalogue.LICENSE   the notice that goes with it
//
// The directory is always stated. There is no place this script writes on
// its own.
//
// models.dev is an open database of what each model can take, kept by its
// maintainers from each provider's documentation (MIT, the data included).
// A driver whose provider's own API does not state a model's facts takes
// them from a catalogue file, which `semiont_inference.catalogue` reads at
// the path it is pointed to. The Python package carries no copy of the
// catalogue and downloads nothing: an image that runs such a driver makes
// the file with this script when it is built, and carries it.
//
// The repository keeps one generated copy, the fixture of the Python
// package's tests: packages/inference-python/tests/catalogue. It is real
// data at the pin, so those tests read real entries, and CI's drift job
// (`npm run generate:model-catalogue:check`) holds this script, the reader
// and the pinned package to each other. A bump of the pin comes with
// `npm run generate:model-catalogue` run again.
//
// What a catalogue file holds, under the catalogue's own names:
//
//   - the providers `google`, `openai` and `togetherai`;
//   - of each, the models the catalogue says write text (`modalities.output`
//     names `text`) and gives a context window and an output ceiling above
//     zero. The catalogue writes zero where a limit does not apply;
//   - of each model, `limit` (`context`, `input`, `output`),
//     `structured_output`, `temperature`, `reasoning`, `reasoning_options`
//     and `status`.
//
// Every one of those is written for every model. One the catalogue does not
// state is null, and so is a `limit.input` of zero: no value is put in its
// place. A reasoning option has the members of its kind, each null where the
// catalogue leaves it out; a kind this script does not know is refused. What
// the words of a fact may be (a status, a reasoning effort) is the reader's
// to say: `semiont_inference.catalogue` refuses a word it does not know, and
// the package's tests read every entry of the fixture through it.
//
// The notice is the npm package's own LICENSE, which MIT asks to go with a
// copy.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeOrCheck } from '../spec/committed-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PACKAGE = '@opencode-ai/models';
const FILE = 'model-catalogue.json';

const [mode, directory, ...more] = process.argv.slice(2);
if ((mode !== '--out' && mode !== '--check') || directory === undefined || more.length > 0) {
  console.error('usage: generate-model-catalogue.mjs --out <directory> | --check <directory>');
  process.exit(1);
}
const CHECK = mode === '--check';
const OUT = resolve(directory, FILE);
const NOTICE = resolve(directory, 'model-catalogue.LICENSE');

/** The providers copied, by the catalogue's names for them, in the order they are written. */
const PROVIDERS = ['google', 'openai', 'togetherai'];
/** What each kind of reasoning option has beside its `type`. */
const REASONING_OPTIONS = { effort: ['values'], toggle: [], budget_tokens: ['min', 'max'] };

function refuse(message) {
  console.error(`✗ ${PACKAGE}: ${message}`);
  process.exit(1);
}

const pinned = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).devDependencies?.[PACKAGE];
if (typeof pinned !== 'string' || !/^\d+\.\d+\.\d+$/.test(pinned)) {
  refuse(`the repository's package.json pins it as ${JSON.stringify(pinned)}, which is not one version`);
}

/** Where the installed package's snapshot is: the copy of the database it carries. */
function snapshotOfTheInstalledPackage() {
  try {
    return import.meta.resolve(`${PACKAGE}/snapshot`);
  } catch {
    return refuse(`it is not installed. Run npm install, which installs ${pinned}`);
  }
}

/** The directory of the installed package: the nearest one above its snapshot whose package.json names it. */
function directoryOfTheInstalledPackage(snapshot) {
  for (let directory = dirname(fileURLToPath(snapshot)); ; directory = dirname(directory)) {
    const manifest = resolve(directory, 'package.json');
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === PACKAGE) return directory;
    if (directory === dirname(directory)) return refuse(`no package.json above ${snapshot} names it`);
  }
}

const snapshot = snapshotOfTheInstalledPackage();
const installed = directoryOfTheInstalledPackage(snapshot);
const manifest = JSON.parse(readFileSync(resolve(installed, 'package.json'), 'utf8'));
if (manifest.version !== pinned) refuse(`${manifest.version} is installed and package.json pins ${pinned}. Run npm install`);
if (typeof manifest.license !== 'string') refuse('its package.json states no licence');

const { providers, generatedAt } = await import(snapshot);
if (typeof generatedAt !== 'string') refuse('its snapshot does not say when it was generated');

const isCount = (value) => Number.isInteger(value) && value >= 0;

/** A reasoning option with every member of its kind, null where the catalogue leaves one out. */
function reasoningOption(where, stated) {
  if (stated === null || typeof stated !== 'object' || !Object.hasOwn(REASONING_OPTIONS, stated.type)) {
    refuse(`${where} has a reasoning option of a kind this script does not know: ${JSON.stringify(stated)}`);
  }
  const members = REASONING_OPTIONS[stated.type];
  const unknown = Object.keys(stated).filter((member) => member !== 'type' && !members.includes(member));
  if (unknown.length > 0) refuse(`the ${stated.type} reasoning option of ${where} has a member this script does not know: ${unknown.join(', ')}`);
  return { type: stated.type, ...Object.fromEntries(members.map((member) => [member, stated[member] ?? null])) };
}

/** What is copied of one model, or null for a model that is left out. */
function copied(where, model) {
  const { context, input, output } = model.limit ?? {};
  if (!isCount(context) || !isCount(output) || (input !== undefined && !isCount(input))) {
    refuse(`${where} has a limit that is not a count of tokens: ${JSON.stringify(model.limit)}`);
  }
  if (!Array.isArray(model.modalities?.output)) refuse(`${where} does not say what it writes`);
  if (!model.modalities.output.includes('text') || context === 0 || output === 0) return null;
  if (model.reasoning_options !== undefined && !Array.isArray(model.reasoning_options)) {
    refuse(`${where} has reasoning options that are not a list`);
  }
  return {
    limit: { context, input: input === undefined || input === 0 ? null : input, output },
    reasoning: model.reasoning ?? null,
    reasoning_options: model.reasoning_options?.map((stated) => reasoningOption(where, stated)) ?? null,
    status: model.status ?? null,
    structured_output: model.structured_output ?? null,
    temperature: model.temperature ?? null,
  };
}

const sections = PROVIDERS.map((provider) => {
  const models = providers?.[provider]?.models;
  if (models === null || typeof models !== 'object') refuse(`its snapshot has no models of ${provider}`);
  const kept = [];
  const leftOut = [];
  for (const id of Object.keys(models).sort()) {
    if (models[id].id !== id) refuse(`${provider}/${id} is listed under a name that is not its id (${JSON.stringify(models[id].id)})`);
    const facts = copied(`${provider}/${id}`, models[id]);
    if (facts === null) leftOut.push(id);
    else kept.push(`        ${JSON.stringify(id)}: ${JSON.stringify(facts)}`);
  }
  if (kept.length === 0) refuse(`no model of ${provider} writes text within a window`);
  console.log(`      ${provider}: ${kept.length} of ${kept.length + leftOut.length} models${leftOut.length > 0 ? `; left out: ${leftOut.join(', ')}` : ''}`);
  return [`    ${JSON.stringify(provider)}: {`, '      "models": {', kept.join(',\n'), '      }', '    }'].join('\n');
});

const text = [
  '{',
  `  "package": ${JSON.stringify(PACKAGE)},`,
  `  "version": ${JSON.stringify(pinned)},`,
  `  "generatedAt": ${JSON.stringify(generatedAt)},`,
  `  "license": ${JSON.stringify(manifest.license)},`,
  '  "providers": {',
  sections.join(',\n'),
  '  }',
  '}',
  '',
].join('\n');

const licence = readFileSync(resolve(installed, 'LICENSE'), 'utf8');
const notice = `This notice goes with ${FILE}, the file beside it: a copy of part of
the models.dev catalogue (https://models.dev), made from the npm package
${PACKAGE}. The copy is distributed under that package's licence,
which follows.

${licence.endsWith('\n') ? licence : `${licence}\n`}`;

writeOrCheck(ROOT, OUT, text, CHECK);
writeOrCheck(ROOT, NOTICE, notice, CHECK);
