/**
 * How a failure becomes a `job:fail` (WORKER-SERVICE.md § Failures): a
 * provider that refuses, a connection that ends, an answer that cannot be
 * read, an answer cut off, and a commit the record refuses; the class each is
 * given, whether the job says it will be retried, and the checkpoint it
 * carries.
 */
import { expect, it } from 'vitest';
import type { ScriptedGeneration } from '../harness/ollama';
import { eachWorkerService, type FailureClass, type RunningJob, type WorkerServiceWorld } from '../harness/worker-service-world';
import { expectGenerations, expectProgress, FORMATS, generation, identity, LONG_TEXT, markJob, report, settled, SMALL_CONTEXT_LENGTH, TEXT } from './support';

const HIGHLIGHT_REQUEST = { num_predict: 5284, num_ctx: 5785, temperature: 0 };

/** Run a highlighting job over the short text against `replies`, and return its failure. */
async function failed(w: WorkerServiceWorld, name: string, replies: ScriptedGeneration[], metadata: Partial<RunningJob['metadata']> = {}): Promise<{ job: RunningJob; failure: Record<string, unknown>; sequence: string[] }> {
  const job = markJob(w, name, { motivation: 'highlighting' }, metadata);
  w.ollama.script(...replies);
  const served = await w.start();
  const failure = await settled(served, job, 'job:fail');
  // A job that failed before it made anything says it loaded and began, and no more.
  expectProgress(served, job, [report(job, 10, { code: 'loading' }), report(job, 30, { code: 'analyzing' })]);
  expect(served.emits('job:complete')).toEqual([]);
  return { job, failure, sequence: served.sequence() };
}

/** A failure of the class given, of a job that made nothing: its identity, its class, its error, and whether it will be retried. */
function classed(job: RunningJob, failure: Record<string, unknown>, failureClass: FailureClass, willRetry: boolean): string {
  const { error, ...rest } = failure;
  expect(rest).toEqual({ ...identity(job), failureClass, willRetry });
  expect(typeof error).toBe('string');
  return String(error);
}

/** A failure of no class, of a job that made nothing: its identity, its error, and whether it will be retried. */
function unclassed(job: RunningJob, failure: Record<string, unknown>, willRetry: boolean): string {
  const { error, ...rest } = failure;
  expect(rest).toEqual({ ...identity(job), willRetry });
  expect(typeof error).toBe('string');
  return String(error);
}

eachWorkerService('a job that fails', (world) => {
  it('fails as transient, and says it will be retried, when its provider refuses the request with a status the job rule retries', async () => {
    const w = world();
    const { job, failure, sequence } = await failed(w, 'refused', [{ status: 500, body: '{"error":"the model is still loading"}' }]);
    const error = classed(job, failure, 'transient', true);
    // The error says what the provider said: its status and its body.
    expect(error).toContain('500');
    expect(error).toContain('the model is still loading');
    // One request: a refusal is not asked again within the attempt.
    expect(w.ollama.generations).toHaveLength(1);
    expect(sequence).toEqual(['emit job:claim', 'emit job:start', 'emit browse:resource-requested', `GET /resources/${String(job.params.resourceId)}`, 'emit job:fail', 'emit job:claim']);
  });

  it('fails as deterministic, and says it will not be retried, when its provider refuses the request as the request\'s own fault', async () => {
    const w = world();
    const { job, failure } = await failed(w, 'refused-400', [{ status: 400, body: '{"error":"invalid options"}' }]);
    const error = classed(job, failure, 'deterministic', false);
    expect(error).toContain('400');
    expect(error).toContain('invalid options');
    // Asked once: a request refused as its own fault is not sent again.
    expect(w.ollama.generations).toHaveLength(1);
  });

  it('says a failure will not be retried when the job has no attempt left', async () => {
    const w = world();
    const { job, failure } = await failed(w, 'spent', [{ status: 500, body: '{"error":"overloaded"}' }], { retryCount: 3, maxRetries: 3 });
    expect(job.metadata.retryCount + 1).toBe(4);
    classed(job, failure, 'transient', false);
  });

  it('fails, with no class, when the connection to its provider ends unanswered', async () => {
    const w = world();
    const { job, failure } = await failed(w, 'dropped', [{ drop: true }]);
    unclassed(job, failure, true);
    expect(w.ollama.generations).toHaveLength(1);
  });

  it.each([
    // A wrong key, for one: refused again however often it is asked.
    [401, 'deterministic', false],
    [503, 'transient', true],
  ] as const)('fails in the class of the status, when its provider refuses with %i to say its model\'s limits, and asks for no generation', async (status, failureClass, willRetry) => {
    const w = world();
    w.ollama.show = { status };
    const { job, failure } = await failed(w, `no-limits-${status}`, []);
    const error = classed(job, failure, failureClass, willRetry);
    // The error says what was being learned, and the status it was refused with.
    expect(error).toContain('/api/show');
    expect(error).toContain(String(status));
    expect(w.ollama.generations).toEqual([]);
  });

  it('fails, with no class, when its provider answers and states no limits for its model, and asks for no generation', async () => {
    const w = world();
    // An answer, and no refusal: there is no status to class it by.
    w.ollama.show = { contextLength: 0 };
    const { job, failure } = await failed(w, 'no-limits-stated', []);
    expect(unclassed(job, failure, true)).toContain('/api/show');
    expect(w.ollama.generations).toEqual([]);
  });

  it('fails, with no class, when the connection to its provider ends unanswered as it asks its model\'s limits, and asks for no generation', async () => {
    const w = world();
    w.ollama.show = { drop: true };
    const { job, failure } = await failed(w, 'no-limits-dropped', []);
    unclassed(job, failure, true);
    expect(w.ollama.shows).toHaveLength(1);
    expect(w.ollama.generations).toEqual([]);
  });

  it('fails as deterministic, having asked for no generation, when its model\'s window leaves a piece 64 tokens or fewer', async () => {
    const w = world();
    // 461 tokens, less the 267 of the prompt around the text, leave 194: a third is 64, one overlap, and a piece of it reads nothing new.
    w.ollama.show = { contextLength: 461 };
    const { job, failure, sequence } = await failed(w, 'window-too-small', []);
    const { error, ...rest } = failure;
    expect(rest).toEqual({ ...identity(job), failureClass: 'deterministic', willRetry: false });
    expect(String(error)).toContain('461');
    // It learned its model's window, and asked the model nothing.
    expect(w.ollama.shows).toEqual([{ model: w.agents[0]!.model }]);
    expect(w.ollama.generations).toEqual([]);
    expect(sequence).toEqual(['emit job:claim', 'emit job:start', 'emit browse:resource-requested', `GET /resources/${String(job.params.resourceId)}`, 'emit job:fail', 'emit job:claim']);
  });

  it.each([
    ['is not JSON', 'I found three passages worth highlighting.'],
    ['is JSON and not an array', '{"highlights":[{"exact":"the first program"}]}'],
    ['has nothing in it', ''],
  ])('fails, with no class, on an answer that %s, having asked once', async (_what, response) => {
    const w = world();
    const agent = w.agents[0]!;
    const { job, failure } = await failed(w, 'unreadable', [{ response }]);
    unclassed(job, failure, true);
    // The text fits one piece, so there is no smaller piece to ask for instead.
    expectGenerations(w.ollama.generations, [generation(agent.model, 'highlighting', HIGHLIGHT_REQUEST, FORMATS.highlighting)]);
    expect(w.commits).toEqual([]);
  });

  it('fails as deterministic, and says it will not be retried, when an answer over the smallest piece is cut off twice', async () => {
    const w = world();
    const agent = w.agents[0]!;
    const cutOff: ScriptedGeneration = { response: JSON.stringify([{ exact: 'the first program' }]), doneReason: 'length' };
    const job = markJob(w, 'truncated', { motivation: 'highlighting' });
    w.ollama.script(cutOff, cutOff);
    const served = await w.start();
    const failure = await settled(served, job, 'job:fail');

    // Asked a second time, the same: once, and no more.
    const request = generation(agent.model, 'highlighting', HIGHLIGHT_REQUEST, FORMATS.highlighting);
    expectGenerations(w.ollama.generations, [request, request]);
    const { error, ...rest } = failure;
    expect(rest).toEqual({ ...identity(job), failureClass: 'deterministic', willRetry: false });
    expect(typeof error).toBe('string');
    // What a cut-off answer did carry is not committed.
    expect(w.commits).toEqual([]);
  });

  it('completes when the second asking of a cut-off piece is answered whole', async () => {
    const w = world();
    const job = markJob(w, 'truncated-once', { motivation: 'highlighting' });
    w.ollama.script({ response: JSON.stringify([{ exact: 'the first program' }]), doneReason: 'length' }, { response: JSON.stringify([{ exact: 'the first program' }, { exact: 'Charles Babbage' }]) });
    const served = await w.start();
    const completion = await settled(served, job);
    expect(w.ollama.generations).toHaveLength(2);
    expect(completion).toEqual({ ...identity(job), result: { found: 2, persisted: 2 }, durability: 'acknowledged' });
  });

  it('carries on its failure the cursor of what it had committed', async () => {
    const w = world();
    w.ollama.show = { contextLength: SMALL_CONTEXT_LENGTH };
    const job = markJob(w, 'failed-partway', { motivation: 'highlighting' }, {}, LONG_TEXT);
    w.ollama.script({ response: JSON.stringify([{ exact: 'marker 103' }, { exact: 'marker 205' }]) }, { status: 500, body: '{"error":"overloaded"}' });
    const served = await w.start();
    const failure = await settled(served, job, 'job:fail');

    expect(w.commits).toHaveLength(1);
    const { error, ...rest } = failure;
    // The first piece is on the record, and a later attempt begins after it.
    expect(rest).toEqual({ ...identity(job), unitCursors: { highlighting: { next: 704, size: 311, found: 2, emitted: 2, errors: 0 } }, failureClass: 'transient', willRetry: true });
    expect(String(error)).toContain('500');
    expect(served.sequence()).toEqual([
      'emit job:claim',
      'emit job:start',
      'emit browse:resource-requested',
      `GET /resources/${String(job.params.resourceId)}`,
      'emit mark:commit',
      'emit job:checkpoint',
      'emit job:fail',
      'emit job:claim',
    ]);
  });

  it('carries on its failure the units it had finished, each with the cursor it ended at', async () => {
    const w = world();
    const job = markJob(w, 'failed-unit', { motivation: 'linking', entityTypes: ['Person', 'Place'] });
    w.ollama.script({ response: JSON.stringify([{ exact: 'Ada Lovelace', entityType: 'Person' }]) }, { response: '1' }, { status: 500, body: '{"error":"overloaded"}' });
    const served = await w.start();
    const failure = await settled(served, job, 'job:fail');

    expect(w.commits).toHaveLength(1);
    const { error, ...rest } = failure;
    expect(rest).toEqual({ ...identity(job), completedUnits: ['Person'], unitCursors: { Person: { next: TEXT.length, size: 2658, found: 1, emitted: 1, errors: 0 } }, failureClass: 'transient', willRetry: true });
    expect(String(error)).toContain('500');
  });

  it('fails with the record\'s reason when the record refuses a commit, and says nothing of how its commits were established', async () => {
    const w = world();
    const job = markJob(w, 'commit-refused', { motivation: 'highlighting' });
    w.ollama.script({ response: JSON.stringify([{ exact: 'the first program' }]) });
    w.hooks.commit = () => ({ refuse: 'the record refuses this batch' });
    const served = await w.start();
    const failure = await settled(served, job, 'job:fail');

    expect(failure).toEqual({ ...identity(job), error: 'the record refuses this batch', willRetry: true });
    // The batch was not established, so its unit's cursor was not said.
    expect(served.emits('job:checkpoint')).toEqual([]);
  });
});
