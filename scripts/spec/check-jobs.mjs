// The job-protocol spec gate.
//
// The dispatcher's protocol is stated in three places that a second
// implementation reads instead of the code — the Job schemas, the storage
// layout (`specs/src/jobs/storage.json`) and the dispatcher's configuration
// document — and each restates a fact another owns. The check fails when they
// disagree:
//
//   - JobCancelRequest's `jobType` is not JobType, the only unit a bulk cancel
//     selects by;
//   - a job description, an announcement or a filter is not told apart by
//     exactly JobType, or a mark job's parameters by exactly Motivation, or a
//     motivation's parameters are open;
//   - an announcement carries anything but the description less the job's
//     input;
//   - a filter names a field the job description does not have, or a mark
//     filter may leave out its motivation;
//   - JobResult has a discriminant, or two of its members could be mistaken
//     for each other;
//   - a completion is not told apart by exactly JobType, or the results the
//     verbs report are not, together, exactly JobResult's;
//   - the layout's record is not a schema;
//   - Job's discriminator disagrees with its members, or a member's `status`
//     is not exactly the value that selects it;
//   - DispatcherConfig or WorkerConfig defaults anything, or leaves optional
//     a field that is not a secret's name: the dispatcher and a worker each
//     read what their document says and supply nothing of their own.
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

const storage = read(resolve(REPO, 'specs/src/jobs/storage.json'));
const jobTypes = schema('JobType').enum;
const motivations = schema('Motivation').enum;
const same = (a, b) => [...a].sort().join() === [...b].sort().join();
const refName = (ref) => ref.replace(/^\.\//, '').replace(/\.json$/, '');

if (schema('JobCancelRequest').properties.jobType.$ref !== './JobType.json') {
  fail(`JobCancelRequest.jobType is not JobType, the only unit a bulk cancel selects by`);
}

// A union told apart by a property: its mapping is its members, the property
// of each member is exactly the value that selects it, and the values are
// exactly `domain`.
function partitions(name, property, domain, domainName) {
  const union = schema(name);
  const mapping = union.discriminator?.mapping ?? {};
  if (union.discriminator?.propertyName !== property) fail(`${name} is not told apart by ${property}`);
  if (!same(union.oneOf.map((member) => member.$ref), Object.values(mapping))) {
    fail(`${name}'s discriminator maps [${Object.values(mapping)}], its members are [${union.oneOf.map((member) => member.$ref)}]`);
  }
  if (!same(Object.keys(mapping), domain)) fail(`${name} is told apart by [${Object.keys(mapping)}], ${domainName} is [${domain}]`);
  for (const [value, ref] of Object.entries(mapping)) {
    const selects = read(resolve(SCHEMAS, ref)).properties?.[property]?.enum;
    if (selects?.length !== 1 || selects[0] !== value) fail(`${name} selects ${ref} by ${property} ${value}, whose ${property} is [${selects}]`);
  }
  return Object.fromEntries(Object.entries(mapping).map(([value, ref]) => [value, read(resolve(SCHEMAS, ref))]));
}

const created = partitions('JobCreateCommand', 'jobType', jobTypes, 'JobType');
const queued = partitions('JobQueuedEvent', 'jobType', jobTypes, 'JobType');
const filters = partitions('JobFilter', 'jobType', jobTypes, 'JobType');
const completed = partitions('JobCompleteCommand', 'jobType', jobTypes, 'JobType');
const marks = partitions('MarkJobParams', 'motivation', motivations, 'Motivation');
for (const [motivation, params] of Object.entries(marks)) {
  if (params.additionalProperties !== false) fail(`a ${motivation} job's parameters are open: a parameter it does not take would be accepted`);
}

// An announcement carries the description less the job's input: a mark job's
// parameters whole, and a yield job's without the one member that is its input.
if (queued.mark?.properties.params.$ref !== created.mark?.properties.params.$ref) {
  fail(`a mark job is announced with ${queued.mark?.properties.params.$ref}, and created with ${created.mark?.properties.params.$ref}`);
}
const yieldParams = schema(refName(created.yield.properties.params.$ref));
const [asked, input] = yieldParams.allOf ?? [];
if (asked?.$ref === undefined || input === undefined || yieldParams.allOf.length !== 2) {
  fail(`a yield job's parameters are not stated as what is asked for and its input`);
} else {
  if (queued.yield?.properties.params.$ref !== asked.$ref) {
    fail(`a yield job is announced with ${queued.yield?.properties.params.$ref}, and what it is asked for is ${asked.$ref}`);
  }
  if (!same(Object.keys(input.properties), ['context']) || !same(input.required ?? [], ['context'])) {
    fail(`a yield job's input is [${Object.keys(input.properties)}], and an announcement leaves out exactly its context`);
  }
  if ('context' in schema(refName(asked.$ref)).properties) fail(`${asked.$ref} carries the context it is defined without`);
}

// A filter names fields of the job description, at the description's paths.
for (const [jobType, filter] of Object.entries(filters)) {
  if (filter.additionalProperties !== false) fail(`a ${jobType} filter is open`);
  for (const name of Object.keys(filter.properties)) {
    if (!(name in created[jobType].properties)) fail(`a ${jobType} filter names ${name}, which a ${jobType} job description does not have`);
  }
}
for (const name of Object.keys(filters.mark?.properties.params?.properties ?? {})) {
  for (const [motivation, params] of Object.entries(marks)) {
    if (!(name in params.properties)) fail(`a mark filter names params.${name}, which a ${motivation} job does not have`);
  }
}
if (!same(filters.mark?.properties.params?.required ?? [], ['motivation'])) fail(`a mark filter does not always state its motivation`);

// A result has no discriminant, so its members are told apart by what each
// alone carries: closed, with no required member in common.
const results = schema('JobResult');
if (results.discriminator !== undefined) fail(`JobResult has a discriminant of its own`);
const required = new Map();
for (const member of results.oneOf) {
  const result = read(resolve(SCHEMAS, member.$ref));
  if (result.additionalProperties !== false) fail(`${member.$ref} is open: another result would decode as it`);
  if ('kind' in result.properties) fail(`${member.$ref} states a kind`);
  for (const name of result.required ?? []) {
    if (required.has(name)) fail(`${member.$ref} and ${required.get(name)} both require ${name}`);
    required.set(name, member.$ref);
  }
}

// A completion carries its verb's result. What is stored is any verb's
// (JobResult), so the verbs' results are, together, exactly its members.
const reported = new Set();
for (const [jobType, completion] of Object.entries(completed)) {
  const ref = completion.properties.result?.$ref;
  const union = ref === undefined ? undefined : read(resolve(SCHEMAS, ref));
  if (union?.oneOf === undefined) { fail(`a ${jobType} completion's result is not a union of results`); continue; }
  if (union.discriminator !== undefined) fail(`${ref} has a discriminant of its own`);
  for (const member of union.oneOf) reported.add(member.$ref);
}
if (!same([...reported], results.oneOf.map((member) => member.$ref))) {
  fail(`the verbs report [${[...reported]}], JobResult is [${results.oneOf.map((member) => member.$ref)}]`);
}

if (!existsSync(resolve(SCHEMAS, `${storage.bucket.record}.json`))) {
  fail(`the storage layout's record ${storage.bucket.record} is not a schema`);
}

const job = schema('Job');
const members = job.oneOf.map((member) => member.$ref);
const mapping = job.discriminator.mapping;
if ([...members].sort().join() !== Object.values(mapping).sort().join()) {
  fail(`Job's discriminator maps [${Object.values(mapping)}], its members are [${members}]`);
}
for (const [status, ref] of Object.entries(mapping)) {
  const selects = read(resolve(SCHEMAS, ref)).properties?.status?.enum;
  if (selects?.length !== 1 || selects[0] !== status) {
    fail(`Job's discriminator selects ${ref} by status ${status}, whose status is [${selects}]`);
  }
}

// A document's schema, followed through what it refers to and into what it
// lists: a part stated in a file of its own is held as the rest is.
function everythingStated(document, node, path) {
  if ('$ref' in node) return everythingStated(document, read(resolve(SCHEMAS, node.$ref)), path);
  if ('default' in node) fail(`${document} defaults ${path}`);
  if (node.type === 'array') return everythingStated(document, node.items, `${path}[]`);
  if (node.type !== 'object') return;
  for (const [name, property] of Object.entries(node.properties)) {
    const at = path ? `${path}.${name}` : name;
    if (!node.required?.includes(name) && !name.endsWith('Env')) fail(`${document} leaves ${at} optional`);
    everythingStated(document, property, at);
  }
}
for (const document of ['DispatcherConfig', 'WorkerConfig']) {
  if (!existsSync(resolve(SCHEMAS, `${document}.json`))) fail(`${document} is not a schema`);
  else everythingStated(document, schema(document), '');
}

if (failures.length > 0) {
  for (const message of failures) console.error(`✗ ${message}`);
  process.exit(1);
}
console.log(`✓ the job protocol agrees with itself (${jobTypes.length} job types, ${motivations.length} motivations)`);
