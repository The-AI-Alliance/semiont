/**
 * How a failure becomes a `job:fail` (WORKER-SERVICE.md § Failures): a
 * provider that refuses, a connection that ends, an answer that cannot be
 * read, an answer cut off, and a commit the record refuses; the class each is
 * given, whether the job says it will be retried, and the checkpoint it
 * carries.
 */
import { expect, it } from 'vitest';
import type { ScriptedGeneration } from '../harness/ollama';
import { eachWorkerService, type RunningJob, type WorkerServiceWorld } from '../harness/worker-service-world';
import { expectGenerations, expectProgress, FORMATS, generation, identity, LONG_TEXT, markJob, report, settled, SMALL_CONTEXT_LENGTH } from './support';

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

/** A failure of no class, of a job that made nothing: its identity, its error, and whether it will be retried. */
function unclassed(job: RunningJob, failure: Record<string, unknown>, willRetry: boolean): string {
  const { error, ...rest } = failure;
  expect(rest).toEqual({ ...identity(job), willRetry });
  expect(typeof error).toBe('string');
  return String(error);
}

eachWorkerService('a job that fails', (world) => {
  it('fails, with no class, and says it will be retried, when its provider refuses the request', async () => {
    const w = world();
    const { job, failure, sequence } = await failed(w, 'refused', [{ status: 500, body: '{"error":"the model is still loading"}' }]);
    const error = unclassed(job, failure, true);
    // The error says what the provider said: its status and its body.
    expect(error).toContain('500');
    expect(error).toContain('the model is still loading');
    // One request: a refusal is not asked again within the attempt.
    expect(w.ollama.generations).toHaveLength(1);
    expect(sequence).toEqual(['emit job:claim', 'emit job:start', 'emit browse:resource-requested', `GET /resources/${String(job.params.resourceId)}`, 'emit job:fail', 'emit job:claim']);
  });

  it('gives no other class to a refusal the provider says is the request\'s own fault', async () => {
    const w = world();
    const { job, failure } = await failed(w, 'refused-400', [{ status: 400, body: '{"error":"invalid options"}' }]);
    expect(unclassed(job, failure, true)).toContain('400');
  });

  it('says a failure will not be retried when the job has no attempt left', async () => {
    const w = world();
    const { job, failure } = await failed(w, 'spent', [{ status: 500, body: '{"error":"overloaded"}' }], { retryCount: 3, maxRetries: 3 });
    expect(job.metadata.retryCount + 1).toBe(4);
    unclassed(job, failure, false);
  });

  it('fails, with no class, when the connection to its provider ends unanswered', async () => {
    const w = world();
    const { job, failure } = await failed(w, 'dropped', [{ drop: true }]);
    unclassed(job, failure, true);
    expect(w.ollama.generations).toHaveLength(1);
  });

  it('fails, with no class, when it cannot learn its model\'s limits, and asks for no generation', async () => {
    const w = world();
    w.ollama.show = { status: 500 };
    const { job, failure } = await failed(w, 'no-limits', []);
    expect(unclassed(job, failure, true)).toContain('/api/show');
    expect(w.ollama.generations).toEqual([]);
  });

  it.each([
    ['is not JSON', 'I found three passages worth highlighting.'],
    ['is JSON and not an array', '{"highlights":[{"exact":"the first program"}]}'],
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
    expect(rest).toEqual({ ...identity(job), unitCursors: { highlighting: { next: 704, size: 311, found: 2, emitted: 2, errors: 0 } }, willRetry: true });
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

  it('carries on its failure the units it had finished', async () => {
    const w = world();
    const job = markJob(w, 'failed-unit', { motivation: 'linking', entityTypes: ['Person', 'Place'] });
    w.ollama.script({ response: JSON.stringify([{ exact: 'Ada Lovelace', entityType: 'Person' }]) }, { response: '1' }, { status: 500, body: '{"error":"overloaded"}' });
    const served = await w.start();
    const failure = await settled(served, job, 'job:fail');

    expect(w.commits).toHaveLength(1);
    const { error, ...rest } = failure;
    expect(rest).toEqual({ ...identity(job), completedUnits: ['Person'], willRetry: true });
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
