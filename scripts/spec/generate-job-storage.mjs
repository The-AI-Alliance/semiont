// Generate the job storage layout from specs/src/jobs/storage.json: the names
// and subjects every implementation of the job queue uses on the broker, so
// work queued by one survives a switch to another. The JetStream queue builds
// every name and subject from these; nothing restates them. The job types are
// JobType's. Output is gitignored and rebuilt by core's `prebuild`,
// like the limits beside it.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const SPEC = resolve(ROOT, 'specs/src/jobs/storage.json');
const JOB_TYPE = resolve(ROOT, 'specs/src/components/schemas/JobType.json');
const MARK_PARAMS = resolve(ROOT, 'specs/src/components/schemas/MarkJobParams.json');
const OUT_DIR = resolve(ROOT, 'packages/core/src/generated');
const OUT = resolve(OUT_DIR, 'job-storage.ts');

const { stream, consumer, bucket } = JSON.parse(readFileSync(SPEC, 'utf8'));
const jobTypes = JSON.parse(readFileSync(JOB_TYPE, 'utf8')).enum;
const markMotivations = Object.keys(JSON.parse(readFileSync(MARK_PARAMS, 'utf8')).discriminator.mapping);

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  OUT,
  `// ⚠ GENERATED FILE — do not edit.
// Source: specs/src/jobs/storage.json, specs/src/components/schemas/JobType.json,
//   specs/src/components/schemas/MarkJobParams.json
//   → scripts/spec/generate-job-storage.mjs
// Rebuilt by \`npm run prebuild\` in @semiont/core; gitignored on purpose.

/** The work-queue stream every job is published into. */
export const JOBS_STREAM = ${JSON.stringify(stream.name)};

/** The root of every job subject: a job is published on \`<root>.<jobType>\`. */
export const JOBS_SUBJECT_ROOT = ${JSON.stringify(stream.subjectRoot)};

/** The stream's capture filter: every subject under the root. */
export const JOBS_STREAM_SUBJECTS = [${JSON.stringify(`${stream.subjectRoot}.>`)}] as const;

/** The durable consumer that holds each job's message as its lease. */
export const JOBS_CONSUMER = ${JSON.stringify(consumer.durableName)};

/** The KV bucket holding one JobRecord per job, keyed by the job's id. */
export const JOBS_BUCKET = ${JSON.stringify(bucket.name)};

/** Every job type. */
export const JOB_TYPES = ${JSON.stringify(jobTypes)} as const;

/** Every motivation a \`mark\` job has: the ones MarkJobParams is told apart by. */
export const MARK_MOTIVATIONS = ${JSON.stringify(markMotivations)} as const;

/** The subject a job of this type is published on. */
export function jobSubject(type: string): string {
  return \`\${JOBS_SUBJECT_ROOT}.\${type}\`;
}
`,
);

console.log(`generated the job storage layout (${jobTypes.length} job types) → packages/core/src/generated/job-storage.ts`);
