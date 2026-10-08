/**
 * What the worker-service cases share: the text their jobs are about, the
 * prompts kept beside them, the shape of a request to the provider, and the
 * reading of a job's messages off a worker's transcript.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import type { RecordedGeneration } from '../harness/ollama';
import { sortedProgress, type RunningJob, type Served, type WorkerServiceWorld } from '../harness/worker-service-world';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The text the short jobs are about: three paragraphs, 391 characters, every
 * one of the Basic Multilingual Plane. It has a dash and an accented letter
 * ahead of most of its spans, so an offset counted in bytes is not an offset
 * counted in characters; one name three times, so a span must be told from
 * its repeats; and a final line end, which a prompt does not carry.
 */
export const TEXT =
  'Ada Lovelace published the first program in 1843 — a method for computing Bernoulli numbers on the Analytical Engine.\n' +
  '\n' +
  'Charles Babbage designed the engine in London, but it was never built. Lovelace argued that the engine could manipulate symbols as well as numbers; nobody tested that claim for a century.\n' +
  '\n' +
  'The program was naïve by later standards, and London ignored it. London was wrong.\n';

/**
 * A text too long for one request of a model with a small window: eight
 * paragraphs of six sentences, 3847 characters, each sentence naming a marker
 * no other names.
 */
export const LONG_TEXT =
  Array.from({ length: 8 }, (_, p) =>
    Array.from({ length: 6 }, (_, s) => `Paragraph ${p + 1}, sentence ${s + 1}: the survey party recorded marker ${(p + 1) * 100 + s + 1} beside the Rh\u00f4ne.`).join(' '),
  ).join('\n\n') + '\n';

/** A context length small enough that `LONG_TEXT` is cut into pieces. */
export const SMALL_CONTEXT_LENGTH = 1200;

/** The context length the stand-in Ollama reports unless a case sets another. */
export const CONTEXT_LENGTH = 8192;

/** A prompt kept in `prompts/`: the file's text, less its one final line end. */
export function prompt(name: string): string {
  return readFileSync(join(HERE, 'prompts', `${name}.txt`), 'utf8').replace(/\n$/, '');
}

/** What a detection asks the model to answer in: an array of these, for each kind of span. */
const span = (extra: Record<string, { type: 'string' }>, required: string[]) => ({
  type: 'array',
  items: {
    type: 'object',
    properties: { exact: { type: 'string' }, ...extra, prefix: { type: 'string' }, suffix: { type: 'string' } },
    required,
    additionalProperties: false,
  },
});
export const FORMATS = {
  highlighting: span({}, ['exact']),
  commenting: span({ comment: { type: 'string' } }, ['exact', 'comment']),
  assessing: span({ assessment: { type: 'string' } }, ['exact', 'assessment']),
  tagging: span({}, ['exact']),
  linking: span({ entityType: { type: 'string' } }, ['exact', 'entityType']),
} as const;

/** The request a worker makes of its Ollama for one generation: nothing more, and nothing less. */
export function generation(model: string, promptName: string, options: { num_predict: number; num_ctx: number; temperature: number }, format?: unknown): Record<string, unknown> {
  return { model, prompt: prompt(promptName), stream: false, think: false, options, ...(format === undefined ? {} : { format }) };
}

/**
 * Hold what the provider was asked to `expected`, request by request. The
 * prompt is compared first and apart, so a difference reads as text.
 */
export function expectGenerations(asked: RecordedGeneration[], expected: Array<Record<string, unknown>>): void {
  expect(asked.map((g) => g.body['prompt'])).toEqual(expected.map((e) => e['prompt']));
  expect(asked.map((g) => g.body)).toEqual(expected);
}

/** The annotations of a batch, each with a `created` that is an instant, and that member taken away: when is the worker's own. */
export function withoutCreated(annotations: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(annotations)) throw new Error(`not a batch of annotations: ${JSON.stringify(annotations)}`);
  return (annotations as Array<Record<string, unknown>>).map((annotation) => {
    const { created, ...rest } = annotation;
    expect(typeof created === 'string' && new Date(created).toISOString() === created, `created: ${String(created)}`).toBe(true);
    return rest;
  });
}

/** An annotation on a span of text, as a worker commits one: without `created`. */
export function textAnnotation(
  generator: Record<string, unknown>,
  resourceId: string,
  motivation: string,
  id: string,
  at: { start: number; end: number; exact: string; prefix?: string; suffix?: string },
  body?: unknown,
): Record<string, unknown> {
  const { start, end, ...quote } = at;
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id,
    motivation,
    generator,
    target: { type: 'SpecificResource', source: resourceId, selector: [{ type: 'TextPositionSelector', start, end }, { type: 'TextQuoteSelector', ...quote }] },
    ...(body === undefined ? {} : { body }),
  };
}

/** What every lifecycle message of `job` but a cancel carries. */
export function identity(job: RunningJob): Record<string, unknown> {
  return { resourceId: job.params.resourceId, jobId: job.metadata.id, jobType: job.metadata.type, attempt: job.metadata.retryCount + 1 };
}

/** A progress report of `job`. */
export function report(job: RunningJob, percentage: number, message: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...identity(job), percentage, progress: { percentage, message, ...extra } };
}

/** Hold the progress reports of `job` to `expected`: every one, each as often as it was said, in no order. */
export function expectProgress(served: Served, job: RunningJob, expected: Array<Record<string, unknown>>): void {
  expect(served.progress(job.metadata.id)).toEqual(sortedProgress(expected));
}

/**
 * Wait until `job` is settled, by `channel`, and the worker has claimed again:
 * the settle is a worker's last word on a job, and the claim after it is what
 * shows the worker went on.
 */
export async function settled(served: Served, job: RunningJob, channel: 'job:complete' | 'job:fail' | 'job:cancel' = 'job:complete'): Promise<Record<string, unknown>> {
  const settle = await served.emitted(channel, (e) => e.payload['jobId'] === job.metadata.id);
  const claimsBefore = served.emits().findIndex((e) => e.channel === channel && e.payload['jobId'] === job.metadata.id);
  await served.proxy.until('the claim after the settle', () => (served.emits().slice(claimsBefore + 1).some((e) => e.channel === 'job:claim' && e.status !== undefined) ? true : undefined), 20_000);
  return settle.payload;
}

/** A text resource about `text`, and a `mark` job on it, queued for the worker's next claim that takes it. */
export function markJob(world: WorkerServiceWorld, name: string, params: Record<string, unknown>, metadata: Partial<RunningJob['metadata']> = {}, text = TEXT): RunningJob {
  const resourceId = `res-ws-${name}`;
  world.resource(resourceId, text);
  return world.queued(`job-ws-${name}`, 'mark', { resourceId, ...params }, metadata);
}

/**
 * The highlight of `marker <n>` in `LONG_TEXT`, at `start`. What stands before
 * and after a marker is the same for every sentence but a paragraph's first,
 * which follows a paragraph break; none of the markers the cases use is in a
 * paragraph's last sentence.
 */
export function markerHighlight(generator: Record<string, unknown>, resourceId: string, id: string, n: number, start: number): Record<string, unknown> {
  const exact = `marker ${n}`;
  const paragraph = Math.floor(n / 100);
  const sentence = n % 100;
  const before = sentence === 1 ? 'beside the Rh\u00f4ne.\n\n' : 'beside the Rh\u00f4ne. ';
  return textAnnotation(generator, resourceId, 'highlighting', id, {
    start,
    end: start + exact.length,
    exact,
    prefix: `${before}Paragraph ${paragraph}, sentence ${sentence}: the survey party recorded `,
    suffix: ` beside the Rh\u00f4ne. Paragraph ${paragraph}, sentence ${sentence + 1}: the survey party recorded`,
  });
}
