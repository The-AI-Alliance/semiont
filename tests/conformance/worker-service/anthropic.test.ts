/**
 * A worker whose agent is an Anthropic one (WORKER-SERVICE.md § Limits,
 * § The request, § The five kinds of mark job, § Failures, § Cancellation,
 * § Generation, § Telemetry, § Stopping): what it asks its provider before
 * its first generation, the request each kind of generation is, how many
 * times a request the provider refuses or drops is made, what a job fails as
 * then, the answer it takes as a stream, the tokens it counts, and what a
 * cancellation and a stop do to a request that is under way.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ScriptedMessage } from '../harness/anthropic';
import { everyJob } from '../harness/dispatcher-world';
import { eventually } from '../harness/net';
import { startOtlp, type OtlpReceiver } from '../harness/otlp';
import { errorsOf, metricName, spanName, spec } from '../harness/spec';
import { ANTHROPIC_MODEL, eachWorkerService, type RunningJob, type Served, type WorkerAgent, type WorkerServiceWorld } from '../harness/worker-service-world';
import {
  annotationIdOf,
  ANTHROPIC_OUTPUT,
  ANTHROPIC_PIECE,
  cancelRequested,
  expectMessages,
  expectProgress,
  FORMATS,
  identity,
  markJob,
  message,
  prompt,
  report,
  settled,
  TEXT,
  textAnnotation,
  withoutCreated,
} from './support';

let receiver: OtlpReceiver | undefined;
beforeAll(async () => {
  receiver = await startOtlp();
});
afterAll(async () => {
  await receiver?.close();
});
const otlp = (): OtlpReceiver => {
  if (!receiver) throw new Error('no OTLP receiver');
  return receiver;
};

/** The agent the worker of these cases works as: the first Anthropic pair. */
const claude = (w: WorkerServiceWorld): WorkerAgent => w.anthropicAgents[0]!;

/** Start a worker with one agent, the Anthropic one, serving every job. */
const started = (w: WorkerServiceWorld): Promise<Served> => w.start({ agents: [w.entry(claude(w), everyJob())] });

/** An answer of the model: its text, and the tokens the provider says it read and wrote. */
const answer = (text: string, stopReason?: string): ScriptedMessage => ({ text, usage: { input: 412, output: 57 }, ...(stopReason === undefined ? {} : { stopReason }) });

/** A refusal, as the provider words one. */
const refused = (status: number, type: string, said: string, headers?: Record<string, string>): ScriptedMessage => ({
  status,
  body: JSON.stringify({ type: 'error', error: { type, message: said } }),
  ...(headers === undefined ? {} : { headers }),
});

/** The request a highlighting job over the short text makes of a model the stand-in describes as it does unless told otherwise. */
const highlighting = (agent: WorkerAgent): Record<string, unknown> => message(agent.model, 'highlighting', { max_tokens: ANTHROPIC_OUTPUT, temperature: 0 }, FORMATS.highlighting);

/** What a `mark` job that made nothing asked of the gateway, in order. */
const madeNothing = (job: RunningJob): string[] => ['emit job:claim', 'emit job:start', 'emit browse:resource-requested', `GET /resources/${String(job.params.resourceId)}`, 'emit job:fail', 'emit job:claim'];

const SOURCE = 'res-ws-yield-source';
const SOURCE_DESCRIPTOR = {
  '@context': 'https://schema.org',
  '@id': SOURCE,
  name: 'Notes on the engine',
  representations: [{ mediaType: 'text/markdown', storageUri: `file://worker-service/${SOURCE}`, rel: 'original' }],
};

/**
 * A `yield` job focused on a resource, queued: the request whose prompt is
 * kept as `yield-markdown`, but for its length and its temperature, which
 * `asked` states.
 */
function yieldJob(w: WorkerServiceWorld, name: string, asked: { maxTokens: number; temperature?: number }): RunningJob {
  const params = {
    resourceId: SOURCE,
    title: 'The Analytical Engine',
    storageUri: `file://generated/${name}.md`,
    prompt: 'Write three sentences.',
    entityTypes: ['Person'],
    language: 'en',
    sourceLanguage: 'en',
    structure: 'prose',
    cite: true,
    ...asked,
    context: { focus: { kind: 'resource', resource: SOURCE_DESCRIPTOR, content: { main: TEXT, related: {} } }, graph: { nodes: [], edges: [] }, metadata: {} },
  };
  const validate = spec().component('GenerationJobParams');
  expect(validate(params), errorsOf(validate)).toBe(true);
  return w.queued(`job-ws-${name}`, 'yield', params);
}

/** What a `yield` job that cited nothing asked of the gateway, in order: its upload, and the link from its source. */
const YIELDED = ['emit job:claim', 'emit job:start', 'POST /resources', 'emit mark:commit', 'emit job:complete', 'emit job:claim'];

/** The highlight of `the first program` in the short text, on `resourceId`. */
const firstProgram = (generator: Record<string, unknown>, resourceId: string): Record<string, unknown> =>
  textAnnotation(generator, resourceId, 'highlighting', annotationIdOf(resourceId, 'highlighting', '23:40:the first program'), {
    start: 23,
    end: 40,
    exact: 'the first program',
    prefix: 'Ada Lovelace published ',
    suffix: ' in 1843 — a method for computing Bernoulli numbers on the Analytical',
  });

/** An unresolved reference's body: the entity type, as a tag. */
const entity = (type: string) => [{ type: 'TextualBody', value: type, purpose: 'tagging', format: 'text/plain', language: 'en' }];

eachWorkerService('a worker on Anthropic', (world) => {
  it("asks of its model once, its ceilings and then whether it takes a temperature, and then for each generation, every request carrying its agent's key", async () => {
    const w = world();
    const agent = claude(w);
    const first = markJob(w, 'anthropic-highlighting', { motivation: 'highlighting' });
    const second = markJob(w, 'anthropic-highlighting-again', { motivation: 'highlighting' });
    const resourceId = String(first.params.resourceId);
    w.anthropic.script(
      answer(
        JSON.stringify([
          { exact: 'the first program', prefix: 'Ada Lovelace published ', suffix: ' in 1843' },
          // Three times in the text: what the model says is around it tells which.
          { exact: 'London', prefix: 'standards, and ', suffix: ' ignored it' },
          // Nowhere in the text.
          { exact: 'a steam locomotive crossing the Alps' },
        ]),
      ),
      answer('[]'),
    );
    const served = await started(w);
    const completion = await settled(served, first);
    await settled(served, second);

    // The model's ceilings, then the probe, then a generation for each job: the first two are asked once, and kept.
    expect(w.anthropic.requests.map((r) => `${r.method} ${r.path}`)).toEqual([`GET /v1/models/${agent.model}`, 'POST /v1/messages', 'POST /v1/messages', 'POST /v1/messages']);
    expect(w.anthropic.described.map((r) => r.body)).toEqual([undefined]);
    // The probe: one token of answer, to a request that carries a temperature.
    expect(w.anthropic.probes.map((p) => p.body)).toEqual([{ model: agent.model, max_tokens: 1, temperature: 0.7, messages: [{ role: 'user', content: 'ok' }] }]);
    // A generation: the model, the budget, the detection's temperature, the prompt as the one message, and the schema of the answer.
    expectMessages(w.anthropic.generations, [highlighting(agent), highlighting(agent)]);
    // Every request carries the key the variable holds, and the version of the API it speaks.
    expect(w.anthropic.requests.map((r) => r.headers['x-api-key'])).toEqual(Array.from({ length: 4 }, () => w.anthropic.apiKey));
    expect(w.anthropic.requests.map((r) => r.headers['anthropic-version'])).toEqual(Array.from({ length: 4 }, () => '2023-06-01'));
    // And nothing the worker wrote carries the key.
    expect(served.process.output.join('\n')).not.toContain(w.anthropic.apiKey);

    // What it made of the answer: the two spans that are in the text, as the agent that asked.
    expect(served.payloads('mark:commit').map((p) => ({ ...p, annotations: withoutCreated(p['annotations']) }))).toEqual([
      {
        resourceId,
        jobId: first.metadata.id,
        annotations: [
          firstProgram(w.generator(agent), resourceId),
          textAnnotation(w.generator(agent), resourceId, 'highlighting', annotationIdOf(resourceId, 'highlighting', '354:360:London'), {
            start: 354,
            end: 360,
            exact: 'London',
            prefix: 'claim for a century.\n\nThe program was naïve by later standards, and ',
            suffix: ' ignored it. London was wrong.\n',
          }),
        ],
      },
    ]);
    expect(w.commits.map((c) => c.by)).toEqual([agent.did]);
    expect(served.payloads('job:checkpoint')[0]).toEqual({
      jobId: first.metadata.id,
      completedUnits: [],
      unitCursors: { highlighting: { next: TEXT.length, size: ANTHROPIC_PIECE, found: 3, emitted: 2, errors: 1 } },
    });
    expect(completion).toEqual({ ...identity(first), result: { found: 3, persisted: 2, errors: 1 }, durability: 'acknowledged' });
  });

  it.each([
    // What it writes is under the bound of a generation's time: all of it is asked for, and a piece is half of it.
    ['a model that writes little', { maxInputTokens: 200_000, maxOutputTokens: 4096 }, { max_tokens: 4096, size: 2048 }],
    // What is left of the window beside what it writes is less than half of that: a piece is what is left.
    ['a model whose window is mostly what it writes', { maxInputTokens: 8192, maxOutputTokens: 6000 }, { max_tokens: 6000, size: 1925 }],
    // What it writes is over the bound: 10666 is asked for, and what is left of the window is cut by as much.
    ['a model that writes more than a generation has time for', { maxInputTokens: 30_000, maxOutputTokens: 20_000 }, { max_tokens: ANTHROPIC_OUTPUT, size: 5190 }],
  ])('asks %s for the budget its two ceilings make', async (_what, ceilings, asked) => {
    const w = world();
    const agent = claude(w);
    w.anthropic.models.set(agent.model, { ...ANTHROPIC_MODEL, ...ceilings });
    const job = markJob(w, 'anthropic-budget', { motivation: 'highlighting' });
    w.anthropic.script(answer('[]'));
    const served = await started(w);
    await settled(served, job);

    expectMessages(w.anthropic.generations, [message(agent.model, 'highlighting', { max_tokens: asked.max_tokens, temperature: 0 }, FORMATS.highlighting)]);
    expect(served.payloads('job:checkpoint')).toEqual([{ jobId: job.metadata.id, completedUnits: [], unitCursors: { highlighting: { next: TEXT.length, size: asked.size, found: 0, emitted: 0, errors: 0 } } }]);
  });

  it('sends no temperature to a model that refuses one: not the detection\'s, and not the one a yield job asks for', async () => {
    const w = world();
    const agent = claude(w);
    w.anthropic.models.set(agent.model, { ...ANTHROPIC_MODEL, acceptsTemperature: false });
    const mark = markJob(w, 'anthropic-no-temperature', { motivation: 'highlighting' });
    const made = yieldJob(w, 'anthropic-no-temperature-yield', { maxTokens: 300, temperature: 0.2 });
    w.anthropic.script(answer(JSON.stringify([{ exact: 'the first program' }])), answer('It was never built.'));
    const served = await started(w);
    await settled(served, mark);
    await settled(served, made);

    // The probe was refused, once, and what it learned is kept.
    expect(w.anthropic.probes.map((p) => p.body)).toEqual([{ model: agent.model, max_tokens: 1, temperature: 0.7, messages: [{ role: 'user', content: 'ok' }] }]);
    expectMessages(w.anthropic.generations, [message(agent.model, 'highlighting', { max_tokens: ANTHROPIC_OUTPUT }, FORMATS.highlighting), message(agent.model, 'yield-markdown', { max_tokens: 300 })]);
    expect(served.emits('job:fail')).toEqual([]);
  });

  it('fails a mark job, having asked for no generation, on a model that does not answer in a schema, and does a yield job on it all the same', async () => {
    const w = world();
    const agent = claude(w);
    w.anthropic.models.set(agent.model, { ...ANTHROPIC_MODEL, structuredOutputs: false });
    const mark = markJob(w, 'anthropic-no-schema', { motivation: 'highlighting' });
    const made = yieldJob(w, 'anthropic-no-schema-yield', { maxTokens: 300, temperature: 0.2 });
    w.anthropic.script(answer('It was never built.'));
    const served = await started(w);
    // The class of this failure, and whether it says it will be retried, are not held: see the suite's README.
    const { error, failureClass: _failureClass, willRetry: _willRetry, ...failure } = await settled(served, mark, 'job:fail');
    await settled(served, made);

    expect(failure).toEqual(identity(mark));
    expect(String(error)).toContain(agent.model);
    expectProgress(served, mark, [report(mark, 10, { code: 'loading' }), report(mark, 30, { code: 'analyzing' })]);
    // It learned of the model once, and asked it for the one generation that wants no schema.
    expect(w.anthropic.described).toHaveLength(1);
    expect(w.anthropic.probes).toHaveLength(1);
    expectMessages(w.anthropic.generations, [message(agent.model, 'yield-markdown', { max_tokens: 300, temperature: 0.2 })]);
    expect(served.sequence()).toEqual([...madeNothing(mark).slice(0, -1), ...YIELDED]);
    expect(w.commits.map((c) => c.resourceId)).toEqual([SOURCE]);
  });

  it("takes four of the entity types of a linking job at once, in the job's order, each an extraction and then a count", async () => {
    const w = world();
    const agent = claude(w);
    const types = ['Person', 'Place', 'Date', 'Machine', 'Number'];
    const job = markJob(w, 'anthropic-linking', { motivation: 'linking', entityTypes: types });
    const resourceId = String(job.params.resourceId);
    // What is asked of a type is what is kept as asked of Person, with the type's own name.
    const extraction = (type: string) => ({
      ...message(agent.model, 'linking-person', { max_tokens: ANTHROPIC_OUTPUT, temperature: 0 }, FORMATS.linking),
      messages: [{ role: 'user', content: prompt('linking-person').replace('mentions of: Person.', `mentions of: ${type}.`) }],
    });
    const count = (type: string) => ({
      ...message(agent.model, 'linking-person-count', { max_tokens: 16, temperature: 0 }),
      messages: [{ role: 'user', content: prompt('linking-person-count').replace('mention of: Person in', `mention of: ${type} in`) }],
    });
    expect([extraction('Place'), count('Place')]).toEqual([message(agent.model, 'linking-place', { max_tokens: ANTHROPIC_OUTPUT, temperature: 0 }, FORMATS.linking), message(agent.model, 'linking-place-count', { max_tokens: 16, temperature: 0 })]);
    const said = (body: Record<string, unknown>) => JSON.stringify(body['messages']);
    const sorted = (bodies: Array<Record<string, unknown>>) => [...bodies].sort((a, b) => (said(a) < said(b) ? -1 : 1));
    const asked = () => w.anthropic.generations.map((g) => g.body);
    // Each extraction is held until the case lets it go; each count is answered as it is asked, with what its extraction is to find.
    const found: Record<string, Array<Record<string, string>>> = {
      Person: [{ exact: 'Charles Babbage', entityType: 'Person' }],
      Place: [{ exact: 'London', entityType: 'Place', prefix: 'engine in ', suffix: ', but' }],
      Date: [],
      Machine: [],
      Number: [],
    };
    const typeOf = (body: Record<string, unknown>, request: (type: string) => Record<string, unknown>) => types.find((type) => said(body) === said(request(type)));
    w.anthropic.choose = (body) => ('output_config' in body ? { hold: true } : answer(String(found[typeOf(body, count) ?? '']?.length)));
    const extracted = (body: Record<string, unknown>) => answer(JSON.stringify(found[typeOf(body, extraction) ?? '']));
    const served = await started(w);
    await w.anthropic.asked(4);
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Four types are with the model, the job's first four, and none has been answered: the fifth is not asked about while they are.
    expect(sorted(asked())).toEqual(sorted(types.slice(0, 4).map(extraction)));
    expect(w.commits).toEqual([]);
    w.anthropic.release(extracted);
    // Once one of the four is done, the fifth is asked about.
    await eventually('the fifth type to be asked about', 15_000, () => (asked().some((body) => said(body) === said(extraction('Number'))) ? true : undefined));
    w.anthropic.release(extracted);
    const completion = await settled(served, job);

    // Ten requests, in no fixed order across the types: an extraction and a count for each.
    expect(sorted(asked())).toEqual(sorted([...types.map(extraction), ...types.map(count)]));
    const reference = (type: string, at: { start: number; end: number; exact: string; prefix: string; suffix: string }) =>
      textAnnotation(w.generator(agent), resourceId, 'linking', annotationIdOf(resourceId, 'linking', `${at.start}:${at.end}:${at.exact}`, entity(type)), at, entity(type));
    const batches = served.payloads('mark:commit').map((p) => withoutCreated(p['annotations']));
    const byText = (a: unknown, b: unknown) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
    expect(batches.sort(byText)).toEqual(
      [
        [
          reference('Person', {
            start: 119,
            end: 134,
            exact: 'Charles Babbage',
            prefix: 'method for computing Bernoulli numbers on the Analytical Engine.\n\n',
            suffix: ' designed the engine in London, but it was never built. Lovelace',
          }),
        ],
        [
          reference('Place', {
            start: 158,
            end: 164,
            exact: 'London',
            prefix: 'on the Analytical Engine.\n\nCharles Babbage designed the engine in ',
            suffix: ', but it was never built. Lovelace argued that the engine could manipulate',
          }),
        ],
      ].sort(byText),
    );
    expect(completion).toEqual({ ...identity(job), result: { found: 2, persisted: 2 }, durability: 'acknowledged' });
  });

  it.each([
    ['429', refused(429, 'rate_limit_error', 'the account is over its rate'), 'the account is over its rate'],
    ['500', refused(500, 'api_error', 'the provider failed'), 'the provider failed'],
    ['529', refused(529, 'overloaded_error', 'the provider is overloaded'), 'the provider is overloaded'],
  ])('asks three times in all for a generation refused with %s, and then fails the job as transient', async (status, refusal, said) => {
    const w = world();
    const agent = claude(w);
    const job = markJob(w, `anthropic-refused-${status}`, { motivation: 'highlighting' });
    w.anthropic.script(refusal, refusal, refusal);
    const served = await started(w);
    const { error, ...failure } = await settled(served, job, 'job:fail');

    // The same request, three times: the first asking, and two more.
    expectMessages(w.anthropic.generations, [highlighting(agent), highlighting(agent), highlighting(agent)]);
    // It waited before each: three eighths of a second at the least, and then twice that, less the grain of a timer.
    const [first, second, third] = w.anthropic.generations.map((g) => g.at);
    expect(second! - first!).toBeGreaterThanOrEqual(370);
    expect(third! - second!).toBeGreaterThanOrEqual(745);
    expect(failure).toEqual({ ...identity(job), failureClass: 'transient', willRetry: true });
    // The error says what the provider said the last time: its status and its body.
    expect(String(error)).toContain(status);
    expect(String(error)).toContain(said);
    expectProgress(served, job, [report(job, 10, { code: 'loading' }), report(job, 30, { code: 'analyzing' })]);
    expect(served.sequence()).toEqual(madeNothing(job));
  });

  it('asks once for a generation refused as the request\'s own fault, and fails the job as deterministic', async () => {
    const w = world();
    const agent = claude(w);
    const job = markJob(w, 'anthropic-refused-400', { motivation: 'highlighting' });
    w.anthropic.script(refused(400, 'invalid_request_error', 'max_tokens: the model writes fewer'));
    const served = await started(w);
    const { error, ...failure } = await settled(served, job, 'job:fail');

    expectMessages(w.anthropic.generations, [highlighting(agent)]);
    expect(failure).toEqual({ ...identity(job), failureClass: 'deterministic', willRetry: false });
    expect(String(error)).toContain('400');
    expect(String(error)).toContain('max_tokens: the model writes fewer');
    expect(served.sequence()).toEqual(madeNothing(job));
  });

  it('completes a job whose generation is refused and then, asked again, answered: having waited as long as the provider said to', async () => {
    const w = world();
    const agent = claude(w);
    const job = markJob(w, 'anthropic-refused-once', { motivation: 'highlighting' });
    w.anthropic.script(refused(429, 'rate_limit_error', 'the account is over its rate', { 'retry-after': '2' }), answer(JSON.stringify([{ exact: 'the first program' }])));
    const served = await started(w);
    const completion = await settled(served, job);

    expectMessages(w.anthropic.generations, [highlighting(agent), highlighting(agent)]);
    // Two seconds, less the grain of a timer: far over the second it waits when it is told nothing.
    expect(w.anthropic.generations[1]!.at - w.anthropic.generations[0]!.at).toBeGreaterThanOrEqual(1990);
    expect(completion).toEqual({ ...identity(job), result: { found: 1, persisted: 1 }, durability: 'acknowledged' });
    expect(served.emits('job:fail')).toEqual([]);
  });

  it('asks three times in all for a generation whose connection ends unanswered, and then fails the job with no class', async () => {
    const w = world();
    const agent = claude(w);
    const job = markJob(w, 'anthropic-dropped', { motivation: 'highlighting' });
    w.anthropic.script({ drop: true }, { drop: true }, { drop: true });
    const served = await started(w);
    const { error, ...failure } = await settled(served, job, 'job:fail');

    expectMessages(w.anthropic.generations, [highlighting(agent), highlighting(agent), highlighting(agent)]);
    expect(failure).toEqual({ ...identity(job), willRetry: true });
    expect(typeof error).toBe('string');
    expect(served.sequence()).toEqual(madeNothing(job));
  });

  it.each([
    ['its ceilings', (w: WorkerServiceWorld) => (w.anthropic.modelsRefusal = 500), { described: 3, probes: 0 }],
    ['whether it takes a temperature', (w: WorkerServiceWorld) => (w.anthropic.probeRefusal = 500), { described: 1, probes: 3 }],
  ])('fails a job, with no class, when it cannot learn of its model %s, having asked three times and for no generation; and asks again for the next job', async (_what, refuse, askedFor) => {
    const w = world();
    const agent = claude(w);
    refuse(w);
    const job = markJob(w, 'anthropic-unlearned', { motivation: 'highlighting' });
    const served = await started(w);
    const { error, ...failure } = await settled(served, job, 'job:fail');

    expect(failure).toEqual({ ...identity(job), willRetry: true });
    expect(String(error)).toContain(agent.model);
    expect({ described: w.anthropic.described.length, probes: w.anthropic.probes.length }).toEqual(askedFor);
    expect(w.anthropic.generations).toEqual([]);
    expect(served.sequence()).toEqual(madeNothing(job));

    // What it could not learn it did not keep: the next job asks again, from the start.
    w.anthropic.modelsRefusal = undefined;
    w.anthropic.probeRefusal = undefined;
    const next = markJob(w, 'anthropic-learned', { motivation: 'highlighting' });
    w.anthropic.script(answer('[]'));
    await w.announce(next);
    await settled(served, next);
    expect({ described: w.anthropic.described.length, probes: w.anthropic.probes.length }).toEqual({ described: askedFor.described + 1, probes: askedFor.probes + 1 });
    expectMessages(w.anthropic.generations, [highlighting(agent)]);
  });

  it('asks a second time, and no more, for an answer the model was cut off in, and fails the job as deterministic', async () => {
    const w = world();
    const agent = claude(w);
    const job = markJob(w, 'anthropic-cut-off', { motivation: 'highlighting' });
    const cutOff = answer(JSON.stringify([{ exact: 'the first program' }]), 'max_tokens');
    w.anthropic.script(cutOff, cutOff);
    const served = await started(w);
    const { error, ...failure } = await settled(served, job, 'job:fail');

    expectMessages(w.anthropic.generations, [highlighting(agent), highlighting(agent)]);
    expect(failure).toEqual({ ...identity(job), failureClass: 'deterministic', willRetry: false });
    expect(typeof error).toBe('string');
    // What a cut-off answer did carry is not committed.
    expect(w.commits).toEqual([]);
  });

  it('asks for a generation with the job\'s own length and temperature and no schema, uploads the answer, and says when the model was cut off', async () => {
    const w = world();
    const agent = claude(w);
    // The model reads 400 tokens: the prompt, 295 of them, and the 300 asked for are together over that, and the generation is asked for all the same.
    w.anthropic.models.set(agent.model, { ...ANTHROPIC_MODEL, maxInputTokens: 400, maxOutputTokens: 300 });
    const whole = yieldJob(w, 'anthropic-yield', { maxTokens: 300, temperature: 0.2 });
    const cutOff = yieldJob(w, 'anthropic-yield-cut-off', { maxTokens: 300, temperature: 0.2 });
    w.anthropic.script(answer('Charles Babbage designed the engine in London. It was never built.'), answer('Charles Babbage designed the engine in', 'max_tokens'));
    const served = await started(w);
    const completion = await settled(served, whole);
    const truncated = await settled(served, cutOff);

    const request = message(agent.model, 'yield-markdown', { max_tokens: 300, temperature: 0.2 });
    expectMessages(w.anthropic.generations, [request, request]);
    const [first, second] = w.world.archivist.uploads;
    expect(first!.file.toString('utf8')).toBe('Charles Babbage designed the engine in London. It was never built.');
    expect(second!.file.toString('utf8')).toBe('Charles Babbage designed the engine in');
    expect(JSON.parse(first!.fields['generator']!)).toEqual(w.generator(agent));
    expect(completion).toEqual({ ...identity(whole), result: { resourceId: first!.resourceId, resourceName: 'The Analytical Engine', truncated: false }, durability: 'acknowledged' });
    expect(truncated).toEqual({ ...identity(cutOff), result: { resourceId: second!.resourceId, resourceName: 'The Analytical Engine', truncated: true }, durability: 'acknowledged' });
    expect(served.sequence()).toEqual([...YIELDED.slice(0, -1), ...YIELDED]);
  });

  it('fails a yield job whose model answers nothing, with no class, and uploads nothing', async () => {
    const w = world();
    const agent = claude(w);
    const job = yieldJob(w, 'anthropic-yield-empty', { maxTokens: 300, temperature: 0.2 });
    w.anthropic.script(answer(''));
    const served = await started(w);
    const { error, ...failure } = await settled(served, job, 'job:fail');

    expectMessages(w.anthropic.generations, [message(agent.model, 'yield-markdown', { max_tokens: 300, temperature: 0.2 })]);
    expect(failure).toEqual({ ...identity(job), willRetry: true });
    expect(String(error)).toContain('response is empty');
    expect(w.world.archivist.uploads).toEqual([]);
    expect(served.emits('job:complete')).toEqual([]);
  });

  it('fails a job as withheld, having asked once, when the provider withholds its answer, and uses nothing the answer carried', async () => {
    const w = world();
    const agent = claude(w);
    const mark = markJob(w, 'anthropic-withheld', { motivation: 'highlighting' });
    const generation = yieldJob(w, 'anthropic-yield-withheld', { maxTokens: 300, temperature: 0.2 });
    // Each refusal carries what would have been an answer: a passage to highlight, and the start of a document.
    w.anthropic.script(answer(JSON.stringify([{ exact: 'the first program' }]), 'refusal'), answer('Charles Babbage designed the engine in', 'refusal'));
    const served = await started(w);
    const { error: markError, ...markFailure } = await settled(served, mark, 'job:fail');
    const { error: yieldError, ...yieldFailure } = await settled(served, generation, 'job:fail');

    expectMessages(w.anthropic.generations, [highlighting(agent), message(agent.model, 'yield-markdown', { max_tokens: 300, temperature: 0.2 })]);
    expect(markFailure).toEqual({ ...identity(mark), failureClass: 'withheld', willRetry: false });
    expect(yieldFailure).toEqual({ ...identity(generation), failureClass: 'withheld', willRetry: false });
    for (const error of [markError, yieldError]) expect(String(error)).toContain('withheld its answer: refusal');
    expect(w.commits).toEqual([]);
    expect(w.world.archivist.uploads).toEqual([]);
    expect(served.emits('job:complete')).toEqual([]);
  });

  it('asks for a generation of more than 21333 tokens as a stream, and for one of 21333 as one answer; and makes the same of either, cut off as each says it was', async () => {
    const w = world();
    const agent = claude(w);
    const text = 'Ada Lovelace published the first program in 1843 — a method for computing Bernoulli numbers. Charles Babbage designed the engine in London. It was naïve by later standards, and it was never built.';
    const whole = yieldJob(w, 'anthropic-yield-whole', { maxTokens: 21_333 });
    const streamed = yieldJob(w, 'anthropic-yield-streamed', { maxTokens: 21_334 });
    // Each answer says the model was cut off: the one message in its `stop_reason`, the stream in its last event but one.
    w.anthropic.script(answer(text, 'max_tokens'), answer(text, 'max_tokens'));
    const served = await started(w);
    const first = await settled(served, whole);
    const second = await settled(served, streamed);

    // Asked with no temperature, each takes 0.7. The second asks for its answer as a stream of events.
    expectMessages(w.anthropic.generations, [
      message(agent.model, 'yield-21333', { max_tokens: 21_333, temperature: 0.7 }),
      message(agent.model, 'yield-21334', { max_tokens: 21_334, temperature: 0.7, stream: true }),
    ]);
    const uploads = w.world.archivist.uploads;
    expect(uploads.map((u) => u.file.toString('utf8'))).toEqual([text, text]);
    expect(first).toEqual({ ...identity(whole), result: { resourceId: uploads[0]!.resourceId, resourceName: 'The Analytical Engine', truncated: true }, durability: 'acknowledged' });
    expect(second).toEqual({ ...identity(streamed), result: { resourceId: uploads[1]!.resourceId, resourceName: 'The Analytical Engine', truncated: true }, durability: 'acknowledged' });
    expect(served.sequence()).toEqual([...YIELDED.slice(0, -1), ...YIELDED]);
  });

  it('counts a generation once, however many times it was asked for, and the tokens its provider reported for it, under its provider and its model', async () => {
    const w = world();
    const agent = claude(w);
    const job = markJob(w, 'anthropic-telemetry', { motivation: 'highlighting' });
    // The generation is refused once and then answered: it is one generation all the same.
    w.anthropic.script(refused(429, 'rate_limit_error', 'the account is over its rate'), { text: JSON.stringify([{ exact: 'the first program' }]), usage: { input: 4127, output: 571 } });
    const served = await w.start({ agents: [w.entry(agent, everyJob())], env: { OTEL_EXPORTER_OTLP_ENDPOINT: otlp().endpoint, OTEL_METRIC_EXPORT_INTERVAL: '500', OTEL_BSP_SCHEDULE_DELAY: '100' } });
    await settled(served, job);

    // The generation's span names who was asked, and for how much.
    const span = await eventually('the span of the generation', 15_000, () => otlp().spans.find((s) => s.name === spanName('inference:structured')));
    expect(span.attributes).toEqual({ 'inference.provider': 'anthropic', 'inference.model': agent.model, 'inference.max_tokens': ANTHROPIC_OUTPUT });

    // The two counts the provider stated, and no other: the probe's are not a generation's.
    const tokens = await eventually('the tokens of the generation, read and written', 15_000, () => {
      const seen = otlp().metrics.get(metricName('semiont.inference.tokens'));
      return seen?.attributes.get('inference.direction')?.size === 2 ? seen : undefined;
    });
    expect([...tokens.attributes.get('inference.provider')!]).toEqual(['anthropic']);
    expect([...tokens.attributes.get('inference.model')!]).toEqual([agent.model]);
    expect([...tokens.attributes.get('inference.direction')!].sort()).toEqual(['input', 'output']);
    expect([...new Set(tokens.values)].sort((a, b) => a - b)).toEqual([571, 4127]);

    expect(w.anthropic.generations).toHaveLength(2);
    // One generation was asked for, and it succeeded: its two askings are counted as one.
    const ended = { 'inference.provider': ['anthropic'], 'inference.model': [agent.model], 'inference.outcome': ['success'] };
    const carried = (metric: { attributes: Map<string, Set<string>> }) => Object.fromEntries([...metric.attributes].map(([key, values]) => [key, [...values]]));
    const calls = await eventually('the count of generations', 15_000, () => otlp().metrics.get(metricName('semiont.inference.calls')));
    expect(carried(calls)).toEqual(ended);
    expect([...new Set(calls.values)]).toEqual([1]);
    const durations = await eventually('the time the generation took', 15_000, () => otlp().metrics.get(metricName('semiont.inference.duration')));
    expect(carried(durations)).toEqual(ended);
  });

  it('does not end a generation that is under way when its job is cancelled: the request stays open until the model answers', async () => {
    const w = world();
    const agent = claude(w);
    const job = markJob(w, 'anthropic-cancelled', { motivation: 'highlighting' });
    const resourceId = String(job.params.resourceId);
    w.anthropic.script({ hold: true });
    const served = await started(w);
    await w.anthropic.asked(1);
    await cancelRequested(w, job);
    // The worker has the cancellation, and still waits on its provider.
    expect(w.anthropic.generations[0]!.abandoned).toBe(false);
    expect(served.emits('job:cancel')).toEqual([]);
    w.anthropic.release(answer(JSON.stringify([{ exact: 'the first program' }])));
    const cancel = await settled(served, job, 'job:cancel');

    expectMessages(w.anthropic.generations, [highlighting(agent)]);
    expect(w.anthropic.generations[0]!.abandoned).toBe(false);
    // The piece it was on is committed, and the job is settled as cancelled.
    expect(served.payloads('mark:commit').map((p) => withoutCreated(p['annotations']))).toEqual([[firstProgram(w.generator(agent), resourceId)]]);
    expect(cancel).toEqual({ resourceId, jobId: job.metadata.id, jobType: 'mark', completedUnits: ['highlighting'] });
    expect(served.emits('job:complete')).toEqual([]);
  });

  it('fails the job it holds and exits 0 on SIGTERM, and its request to the provider ends with it', async () => {
    const w = world();
    const job = markJob(w, 'anthropic-stopped', { motivation: 'highlighting' });
    // The model never answers: the worker holds the job when it is told to stop.
    w.anthropic.script({ hold: true });
    const served = await started(w);
    await w.anthropic.asked(1);
    expect(w.anthropic.generations[0]!.abandoned).toBe(false);

    expect(await served.process.stop()).toBe(0);
    const failures = served.emits('job:fail');
    expect(failures.map((f) => f.status)).toEqual([202]);
    const { error, ...rest } = failures[0]!.payload;
    expect(rest).toEqual({ ...identity(job), willRetry: true });
    expect(error).toMatch(/stopped/);
    // The provider saw the connection close with no answer sent.
    await eventually('the provider to see the request ended', 5_000, () => (w.anthropic.generations[0]!.abandoned ? true : undefined));
    expect(w.anthropic.generations).toHaveLength(1);
  });
});
