// The job-protocol spec gate.
//
// The dispatcher's protocol is stated in three places that a second
// implementation reads instead of the code — the Job schemas, the storage
// layout (`specs/src/jobs/storage.json`) and the dispatcher's configuration
// document — and each restates a fact another owns. The check fails when they
// disagree:
//
//   - the layout's categories do not partition JobType: a type in no category
//     has no subject to be published on, and a type in two has two;
//   - JobCancelRequest's `jobType` names something other than the categories,
//     the only unit a bulk cancel selects by;
//   - the layout's record is not a schema;
//   - Job's discriminator disagrees with its members, or a member's `status`
//     is not exactly the value that selects it;
//   - DispatcherConfig defaults anything, or leaves optional a field that is
//     not a secret's name: the dispatcher reads what its document says and
//     supplies nothing of its own.
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
const categories = Object.keys(storage.categories);

const placed = new Map();
for (const [category, types] of Object.entries(storage.categories)) {
  for (const type of types) {
    if (placed.has(type)) fail(`job type ${type} is in two categories: ${placed.get(type)} and ${category}`);
    placed.set(type, category);
  }
}
const jobTypes = schema('JobType').enum;
for (const type of jobTypes) {
  if (!placed.has(type)) fail(`job type ${type} is in no category of specs/src/jobs/storage.json`);
}
for (const type of placed.keys()) {
  if (!jobTypes.includes(type)) fail(`specs/src/jobs/storage.json places ${type}, which is not a JobType`);
}

const cancelSelects = schema('JobCancelRequest').properties.jobType.enum;
if ([...cancelSelects].sort().join() !== [...categories].sort().join()) {
  fail(`JobCancelRequest.jobType is [${cancelSelects}], the storage layout's categories are [${categories}]`);
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

function everythingStated(node, path) {
  if ('default' in node) fail(`DispatcherConfig defaults ${path}`);
  if (node.type !== 'object') return;
  for (const [name, property] of Object.entries(node.properties)) {
    const at = path ? `${path}.${name}` : name;
    if (!node.required?.includes(name) && !name.endsWith('Env')) fail(`DispatcherConfig leaves ${at} optional`);
    everythingStated(property, at);
  }
}
everythingStated(schema('DispatcherConfig'), '');

if (failures.length > 0) {
  for (const message of failures) console.error(`✗ ${message}`);
  process.exit(1);
}
console.log(`✓ the job protocol agrees with itself (${jobTypes.length} job types in ${categories.length} categories)`);
