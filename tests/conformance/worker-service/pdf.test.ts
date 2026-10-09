/**
 * A `mark` job on a PDF (WORKER-SERVICE.md § What a job reads, § Anchoring,
 * § Declines): the text is the Smelter's, asked for on the bus, and the
 * worker reads no bytes; a span is anchored by where its text is on the page;
 * and each answer the Smelter can give that is not a text ends the job its
 * own way.
 */
import { expect, it } from 'vitest';
import { eachWorkerService, type RunningJob, type WorkerServiceWorld } from '../harness/worker-service-world';
import { FORMATS, identity, settled, withoutCreated } from './support';

/** The text the Smelter read out of the PDF, and each run of it on the page: two lines of one page. */
const PDF_TEXT = 'Ada Lovelace published the first program. Charles Babbage designed the engine.';
const ITEMS = [
  // "Ada Lovelace published the first program." and the space after it, on the upper line.
  { start: 0, end: 42, page: 1, x: 72, y: 700, width: 420, height: 12 },
  // "Charles Babbage designed the engine." on the lower.
  { start: 42, end: 78, page: 1, x: 72, y: 680, width: 360, height: 12 },
];

function pdfJob(w: WorkerServiceWorld, name: string, answer: Record<string, unknown> | undefined): RunningJob {
  const resourceId = `res-ws-${name}`;
  w.describe(resourceId, 'application/pdf');
  if (answer) w.anchoredText.set(resourceId, answer);
  return w.queued(`job-ws-${name}`, 'mark', { resourceId, motivation: 'highlighting' });
}

const READS_NO_BYTES = ['emit job:claim', 'emit job:start', 'emit browse:resource-requested', 'emit browse:anchored-text-requested'];

eachWorkerService('a job on a PDF', (world) => {
  it('asks the Smelter for the text, reads no bytes, and anchors each span by its place on the page', async () => {
    const w = world();
    const job = pdfJob(w, 'pdf', { kind: 'extracted', method: 'pdf-text-layer', text: PDF_TEXT, items: ITEMS });
    const resourceId = String(job.params.resourceId);
    w.ollama.script({ response: JSON.stringify([{ exact: 'Ada Lovelace' }, { exact: 'the first program. Charles Babbage' }]) });
    const served = await w.start();
    const completion = await settled(served, job);

    expect(served.sequence()).toEqual([...READS_NO_BYTES, 'emit mark:commit', 'emit job:checkpoint', 'emit job:complete', 'emit job:claim']);
    expect(w.anchoredTextReads).toEqual([resourceId]);
    expect(w.world.archivist.calls.filter((c) => c.path.includes('/content'))).toEqual([]);

    // The model is asked about the Smelter's text.
    expect(w.ollama.generations).toHaveLength(1);
    expect(String(w.ollama.generations[0]!.body['prompt'])).toContain(`---\n${PDF_TEXT}\n---`);
    expect(w.ollama.generations[0]!.body['format']).toEqual(FORMATS.highlighting);

    const fragment = (value: string) => ({ type: 'FragmentSelector', conformsTo: 'http://tools.ietf.org/rfc/rfc3778', value });
    const annotation = (id: string, selector: unknown[]) => ({
      '@context': 'http://www.w3.org/ns/anno.jsonld',
      type: 'Annotation',
      id,
      motivation: 'highlighting',
      generator: w.generator(),
      target: { type: 'SpecificResource', source: resourceId, selector },
    });
    expect(served.payloads('mark:commit').map((p) => withoutCreated(p['annotations']))).toEqual([
      [
        // Twelve of the upper line's forty-two characters, from its left edge: two sevenths of its width.
        annotation('QtseQcczJ22XiMGSSc8ub', [
          fragment('page=1&viewrect=72,700,120,12'),
          { type: 'TextQuoteSelector', exact: 'Ada Lovelace', suffix: ' published the first program. Charles Babbage designed the engine' },
        ]),
        // A span over both lines has a rectangle for each, the upper first: the end of one, and the start of the other.
        annotation('WAvvU5B-Pz7qbEVUMgqe4', [
          fragment('page=1&viewrect=302,700,190,12'),
          fragment('page=1&viewrect=72,680,150,12'),
          { type: 'TextQuoteSelector', exact: 'the first program. Charles Babbage', prefix: 'Ada Lovelace published ', suffix: ' designed the engine.' },
        ]),
      ],
    ]);
    expect(completion).toEqual({ ...identity(job), result: { found: 2, persisted: 2 }, durability: 'acknowledged' });
  });

  it.each([
    ['encrypted', { kind: 'declined', declined: 'encrypted' }, 'encrypted'],
    ['corrupt', { kind: 'declined', declined: 'corrupt' }, 'corrupt'],
    ['without a text layer', { kind: 'declined', declined: 'no-text-layer' }, 'no-text-layer'],
    ['too large', { kind: 'declined', declined: 'too-large' }, 'too-large'],
    ['read, and empty', { kind: 'extracted', method: 'pdf-text-layer', text: '  \n ', items: [] }, 'empty'],
  ])('completes, declined, a job on a PDF the Smelter says is %s', async (_what, answer, reason) => {
    const w = world();
    const job = pdfJob(w, 'pdf-declined', answer);
    const served = await w.start();
    const completion = await settled(served, job);

    expect(completion).toEqual({ ...identity(job), result: { declined: true, reason } });
    expect(served.sequence()).toEqual([...READS_NO_BYTES, 'emit job:complete', 'emit job:claim']);
    expect(w.ollama.generations).toEqual([]);
    expect(w.commits).toEqual([]);
  });

  it('fails, with no class, a job on a PDF whose text the Smelter has not settled yet: a later attempt may find it', async () => {
    const w = world();
    const job = pdfJob(w, 'pdf-not-yet', { kind: 'not-yet' });
    const served = await w.start();
    const failure = await settled(served, job, 'job:fail');

    const { error, ...rest } = failure;
    expect(rest).toEqual({ ...identity(job), willRetry: true });
    expect(error).toContain(String(job.params.resourceId));
    expect(served.sequence()).toEqual([...READS_NO_BYTES, 'emit job:fail', 'emit job:claim']);
    // It is asked once: the worker does not wait for the text within the attempt.
    expect(w.anchoredTextReads).toHaveLength(1);
    expect(w.ollama.generations).toEqual([]);
  });

  it.each([
    ['has no map of', { kind: 'no-map' }, 'no-map'],
    ['does not know', undefined, 'unknown'],
  ])('fails as deterministic a job on a PDF the Smelter %s', async (_what, answer, kind) => {
    const w = world();
    const job = pdfJob(w, 'pdf-absent', answer);
    const served = await w.start();
    const failure = await settled(served, job, 'job:fail');

    const { error, ...rest } = failure;
    expect(rest).toEqual({ ...identity(job), failureClass: 'deterministic', willRetry: false });
    expect(error).toContain(kind);
    expect(w.ollama.generations).toEqual([]);
  });
});
