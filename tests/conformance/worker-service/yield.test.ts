/**
 * A `yield` job to a text format, end to end (WORKER-SERVICE.md § Generation):
 * the one request it makes of its model, the resource it uploads, the link it
 * commits from the source to what it made, the citations it commits on what
 * it made, and its completion.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SPEC_SOURCE } from '../harness/paths';
import { WORKER_ROLE } from '../harness/roles';
import { errorsOf, spec } from '../harness/spec';
import { eachWorkerService, type RunningJob, type WorkerServiceWorld } from '../harness/worker-service-world';
import { annotationIdOf, expectGenerations, expectProgress, generation, identity, report, settled, TEXT, textAnnotation, withoutCreated } from './support';

const SOURCE = 'res-ws-yield-source';
/** The source's description, as the context a job is handed carries it. */
const SOURCE_DESCRIPTOR = {
  '@context': 'https://schema.org',
  '@id': SOURCE,
  name: 'Notes on the engine',
  representations: [{ mediaType: 'text/markdown', storageUri: `file://worker-service/${SOURCE}`, rel: 'original' }],
};

/** A `yield` job as the dispatcher hands it over, queued: its request, and the context gathered for it. */
function yieldJob(w: WorkerServiceWorld, name: string, request: Record<string, unknown>, focus: Record<string, unknown>): RunningJob {
  const params = { resourceId: SOURCE, ...request, context: { focus, graph: { nodes: [], edges: [] }, metadata: {} } };
  const validate = spec().component('GenerationJobParams');
  expect(validate(params), errorsOf(validate)).toBe(true);
  return w.queued(`job-ws-${name}`, 'yield', params);
}

/** What the first case asks for: the request whose prompt is kept as `yield-markdown`. */
const REQUEST = {
  title: 'The Analytical Engine',
  storageUri: 'file://generated/analytical-engine.md',
  prompt: 'Write three sentences.',
  entityTypes: ['Person'],
  language: 'en',
  sourceLanguage: 'en',
  temperature: 0.2,
  maxTokens: 300,
  structure: 'prose',
  cite: true,
};

// The ids the cases below work out are worked out by the table's rule: the suite's own reckoning is held to every case of it.
it('works out the id of an annotation as specs/src/annotations/id-cases.json states it, case for case', () => {
  const table = JSON.parse(readFileSync(join(SPEC_SOURCE, 'annotations/id-cases.json'), 'utf8')) as { cases: Array<{ resourceId: string; motivation: string; anchor: string; body?: unknown; id: string }> };
  expect(table.cases.length).toBeGreaterThan(0);
  for (const { resourceId, motivation, anchor, body, id } of table.cases) {
    expect(annotationIdOf(resourceId, motivation, anchor, body), JSON.stringify({ resourceId, motivation, anchor })).toBe(id);
  }
});

eachWorkerService('a yield job', (world) => {
  it('generates from the gathered context, uploads what the model wrote less its citation marks, links it from its source, and cites its sources on it', async () => {
    const w = world();
    const agent = w.agents[0]!;
    const job = yieldJob(w, 'yield', REQUEST, { kind: 'resource', resource: SOURCE_DESCRIPTOR, content: { main: TEXT, related: {} } });
    w.ollama.script({
      // Two claims cited to the source, one with a space before its mark and one without; and one cited to a resource the context never showed.
      response:
        'Ada Lovelace published the first program in 1843. [[res-ws-yield-source]] Charles Babbage designed the engine in London.[[res-ws-yield-source]] It was never built. [[res-ws-not-in-the-context]]',
    });
    const served = await w.start();
    const completion = await settled(served, job);

    // One generation, with the job's own temperature and length, and no format: the answer is the document.
    expect(w.ollama.shows).toEqual([{ model: agent.model }]);
    expectGenerations(w.ollama.generations, [generation(agent.model, 'yield-markdown', { num_predict: 300, num_ctx: 718, temperature: 0.2 })]);

    // It reads nothing of the source: what it knows of it is in the job.
    expect(served.sequence()).toEqual(['emit job:claim', 'emit job:start', 'POST /resources', 'emit mark:commit', 'emit mark:commit', 'emit job:complete', 'emit job:claim']);
    expect(w.descriptorReads).toEqual([]);

    // The upload: the text without its marks, where the job said to store it, citing the job and its source.
    const content = 'Ada Lovelace published the first program in 1843. Charles Babbage designed the engine in London. It was never built.';
    expect(w.world.archivist.uploads).toHaveLength(1);
    const upload = w.world.archivist.uploads[0]!;
    expect(upload.file.toString('utf8')).toBe(content);
    const { generator, entityTypes, ...fields } = upload.fields;
    expect(fields).toEqual({
      name: 'The Analytical Engine',
      format: 'text/markdown',
      storageUri: 'file://generated/analytical-engine.md',
      language: 'en',
      sourceResourceId: SOURCE,
      generationPrompt: 'Write three sentences.',
      jobId: job.metadata.id,
    });
    expect(JSON.parse(generator!)).toEqual(w.generator());
    expect(JSON.parse(entityTypes!)).toEqual(['Person']);
    expect(upload.principal).toBe(agent.did);
    expect(upload.roles).toBe(WORKER_ROLE);
    const yielded = upload.resourceId;

    const commits = served.payloads('mark:commit');
    // First, on the source: a link to what was made of it, an annotation of the resource as a whole, and so anchored nowhere on it.
    const linked = { type: 'SpecificResource', source: yielded, purpose: 'linking' };
    expect({ ...commits[0], annotations: withoutCreated(commits[0]!['annotations']) }).toEqual({
      resourceId: SOURCE,
      jobId: job.metadata.id,
      annotations: [
        {
          '@context': 'http://www.w3.org/ns/anno.jsonld',
          type: 'Annotation',
          id: annotationIdOf(SOURCE, 'linking', '', linked),
          motivation: 'linking',
          generator: w.generator(),
          target: { source: SOURCE },
          body: { type: 'SpecificResource', source: yielded, purpose: 'linking' },
        },
      ],
    });
    // Then, on what was made: each cited claim, linked to the resource it cites. The claim is the sentence before the mark,
    // and its annotation is a span's as a detection's is: a position and a quote of its words, with no context.
    const cited = { type: 'SpecificResource', source: SOURCE, purpose: 'linking' };
    const citation = (start: number, end: number, exact: string) =>
      textAnnotation(w.generator(), yielded, 'linking', annotationIdOf(yielded, 'linking', `${start}:${end}:${exact}`, cited), { start, end, exact }, cited);
    expect({ ...commits[1], annotations: withoutCreated(commits[1]!['annotations']) }).toEqual({
      resourceId: yielded,
      jobId: job.metadata.id,
      annotations: [citation(0, 49, 'Ada Lovelace published the first program in 1843.'), citation(50, 96, 'Charles Babbage designed the engine in London.')],
    });
    expect(commits).toHaveLength(2);
    expect(content.slice(50, 96)).toBe('Charles Babbage designed the engine in London.');

    expectProgress(served, job, [
      report(job, 5, { code: 'generating-resource' }),
      report(job, 95, { code: 'creating-resource' }),
      report(job, 100, { code: 'complete-generated', truncated: false }),
    ]);
    expect(completion).toEqual({ ...identity(job), result: { resourceId: yielded, resourceName: 'The Analytical Engine', truncated: false }, durability: 'acknowledged' });
  });

  it('names the annotation a job is anchored to on everything it says of the job, binds what it made to that annotation, and says when the model was cut off', async () => {
    const w = world();
    const agent = w.agents[0]!;
    const annotationId = 'ann-ws-focus';
    const job = yieldJob(
      w,
      'yield-annotation',
      { title: 'Charles Babbage', storageUri: 'file://generated/babbage.txt', language: 'de', outputMediaType: 'text/plain' },
      {
        kind: 'annotation',
        annotation: {
          '@context': 'http://www.w3.org/ns/anno.jsonld',
          type: 'Annotation',
          id: annotationId,
          motivation: 'linking',
          target: { source: SOURCE, selector: [{ type: 'TextPositionSelector', start: 119, end: 134 }, { type: 'TextQuoteSelector', exact: 'Charles Babbage' }] },
          body: [{ type: 'TextualBody', value: 'Person', purpose: 'tagging' }],
          created: '2026-01-01T00:00:00.000Z',
        },
        sourceResource: SOURCE_DESCRIPTOR,
        selected: { before: 'on the Analytical Engine.\n\n', text: 'Charles Babbage', after: ' designed the engine in London' },
        userHint: 'the mathematician, not the banker',
      },
    );
    w.ollama.script({ response: 'Charles Babbage\nCharles Babbage war ein englischer Mathematiker', doneReason: 'length' });
    const served = await w.start();
    const completion = await settled(served, job);

    // Asked with no temperature or length, the job takes 0.7 and 500 tokens.
    expectGenerations(w.ollama.generations, [generation(agent.model, 'yield-annotation', { num_predict: 500, num_ctx: 762, temperature: 0.7 })]);

    const anchored = { ...identity(job), annotationId };
    expect(served.payloads('job:start')).toEqual([anchored]);
    // The annotation asked for the resource, so no other link is made, and with nothing cited nothing is committed.
    expect(served.sequence()).toEqual(['emit job:claim', 'emit job:start', 'POST /resources', 'emit job:complete', 'emit job:claim']);
    expect(w.commits).toEqual([]);

    const upload = w.world.archivist.uploads[0]!;
    expect(upload.file.toString('utf8')).toBe('Charles Babbage\nCharles Babbage war ein englischer Mathematiker');
    const { generator, ...fields } = upload.fields;
    expect(fields).toEqual({ name: 'Charles Babbage', format: 'text/plain', storageUri: 'file://generated/babbage.txt', language: 'de', sourceResourceId: SOURCE, sourceAnnotationId: annotationId, jobId: job.metadata.id });
    expect(JSON.parse(generator!)).toEqual(w.generator());

    const said = (percentage: number, message: Record<string, unknown>) => ({ ...anchored, percentage, progress: { percentage, message, annotationId } });
    expectProgress(served, job, [said(5, { code: 'generating-resource' }), said(95, { code: 'creating-resource' }), said(100, { code: 'complete-generated', truncated: true })]);
    expect(completion).toEqual({ ...anchored, result: { resourceId: upload.resourceId, resourceName: 'Charles Babbage', truncated: true } });
  });

  it('fails as deterministic, having asked its model nothing and uploaded nothing, a job for a format it does not generate', async () => {
    const w = world();
    const job = yieldJob(w, 'yield-html', { title: 'A page', storageUri: 'file://generated/page.html', outputMediaType: 'text/html' }, { kind: 'resource', resource: SOURCE_DESCRIPTOR });
    const served = await w.start();
    const failure = await settled(served, job, 'job:fail');

    const { error, ...rest } = failure;
    expect(String(error)).toContain('text/html');
    // No attempt changes what the service generates: none is spent on it again.
    expect(rest).toEqual({ ...identity(job), failureClass: 'deterministic', willRetry: false });
    expect(w.ollama.shows).toEqual([]);
    expect(w.ollama.generations).toEqual([]);
    expect(w.world.archivist.uploads).toEqual([]);
    expect(served.sequence()).toEqual(['emit job:claim', 'emit job:start', 'emit job:fail', 'emit job:claim']);
  });

  it('fails as deterministic, having asked for no generation, a job whose prompt and length are together over its model\'s window', async () => {
    const w = world();
    // The prompt kept as `yield-markdown` is 295 tokens, and the job asks for 300 more: 595, one over this window.
    w.ollama.show = { contextLength: 594 };
    const job = yieldJob(w, 'yield-over-the-window', REQUEST, { kind: 'resource', resource: SOURCE_DESCRIPTOR, content: { main: TEXT, related: {} } });
    const served = await w.start();
    const failure = await settled(served, job, 'job:fail');

    const { error, ...rest } = failure;
    expect(rest).toEqual({ ...identity(job), failureClass: 'deterministic', willRetry: false });
    expect(String(error)).toContain('594');
    expect(w.ollama.shows).toEqual([{ model: w.agents[0]!.model }]);
    expect(w.ollama.generations).toEqual([]);
    expect(w.world.archivist.uploads).toEqual([]);
    expect(served.sequence()).toEqual(['emit job:claim', 'emit job:start', 'emit job:fail', 'emit job:claim']);
  });

  it('asks for the generation of a job whose prompt and length exactly fill its model\'s window', async () => {
    const w = world();
    const agent = w.agents[0]!;
    w.ollama.show = { contextLength: 595 };
    const job = yieldJob(w, 'yield-fills-the-window', REQUEST, { kind: 'resource', resource: SOURCE_DESCRIPTOR, content: { main: TEXT, related: {} } });
    w.ollama.script({ response: 'It was never built.' });
    const served = await w.start();
    await settled(served, job);
    expectGenerations(w.ollama.generations, [generation(agent.model, 'yield-markdown', { num_predict: 300, num_ctx: 595, temperature: 0.2 })]);
  });
});
