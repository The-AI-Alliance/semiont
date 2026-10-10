/**
 * What the worker-service cases share: the text their jobs are about, the
 * prompts kept beside them, the shape of a request to the provider, and the
 * reading of a job's messages off a worker's transcript.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import type { RecordedMessage } from '../harness/anthropic';
import type { RecordedGeneration } from '../harness/ollama';
import { sortedProgress, type RunningJob, type Served, type WorkerServiceWorld } from '../harness/worker-service-world';

/** The members of every object in order of their names by code point, at every depth; arrays in their own order; no white space. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const byCodePoint = (a: string, b: string): number => {
      const [x, y] = [Array.from(a), Array.from(b)];
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const difference = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
        if (difference !== 0) return difference;
      }
      return x.length - y.length;
    };
    const members = Object.entries(value).sort(([a], [b]) => byCodePoint(a, b));
    return `{${members.map(([name, member]) => `${JSON.stringify(name)}:${canonical(member)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The id of an annotation, derived from what it is as
 * specs/src/annotations/id-cases.json states: for an annotation whose resource
 * a case learns only as it runs, and so cannot state its id beforehand. `body`
 * is left out for an annotation that has none. worker-service/yield.test.ts
 * holds this to every case of that table.
 */
export function annotationIdOf(resourceId: string, motivation: string, anchor: string, body?: unknown): string {
  const identity = { resourceId, motivation, anchor, ...(body === undefined ? {} : { body }) };
  return createHash('sha256').update(canonical(identity), 'utf8').digest('base64url').slice(0, 21);
}

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The text the short jobs are about: three paragraphs, 391 characters, every
 * one of the Basic Multilingual Plane. It has a dash and an accented letter
 * ahead of most of its spans, so an offset counted in bytes is not an offset
 * counted in code points; one name three times, so a span must be told from
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

/**
 * What a detection asks of a model the stand-in Anthropic describes as it does
 * unless a case says otherwise (`ANTHROPIC_MODEL`): 10666 tokens of answer, of
 * a piece of 5333.
 */
export const ANTHROPIC_OUTPUT = 10666;
export const ANTHROPIC_PIECE = 5333;

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

/**
 * The request a worker makes of Anthropic for one generation: nothing more,
 * and nothing less. `schema` is what the answer is to be an array of, for a
 * generation that asks for one.
 */
export function message(model: string, promptName: string, options: { max_tokens: number; temperature?: number; stream?: true }, schema?: unknown): Record<string, unknown> {
  return { model, ...options, messages: [{ role: 'user', content: prompt(promptName) }], ...(schema === undefined ? {} : { output_config: { format: { type: 'json_schema', schema } } }) };
}

/**
 * Hold what Anthropic was asked to `expected`, request by request. What was
 * said to the model is compared first and apart, so a difference reads as
 * text.
 */
export function expectMessages(asked: RecordedMessage[], expected: Array<Record<string, unknown>>): void {
  expect(asked.map((g) => g.body['messages'])).toEqual(expected.map((e) => e['messages']));
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

/**
 * Ask for `job` to be cancelled, as the gateway relays a cancellation to
 * every worker, and wait until the worker has had it. Its stream carries
 * frames in the order they were sent, so the worker's answer to a request
 * sent after the cancellation (its limits, which its first agent answers)
 * says the cancellation has arrived.
 */
export async function cancelRequested(world: WorkerServiceWorld, job: RunningJob): Promise<void> {
  const listener = await world.listen(['job:limits-result', 'job:limits-failed']);
  await world.emit('job:cancel-requested', { jobId: job.metadata.id });
  const correlationId = randomUUID();
  const reply = await world.world.emit(listener.token, { channel: 'job:limits-requested', payload: {}, correlationId, clientId: listener.clientId });
  expect(reply.status).toBe(202);
  await listener.stream.next('the answer that follows the cancellation', (m) => m.frame?.correlationId === correlationId, 15_000);
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
