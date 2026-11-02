/**
 * The telemetry a worker exports (WORKER-SERVICE.md § Telemetry): everything
 * specs/src/service-telemetry/telemetry.json lists for it, and the rows of
 * specs/src/sdk-telemetry/telemetry.json it names there, exported over OTLP
 * to the endpoint the standard OpenTelemetry environment names; and nothing
 * else. What it records of a job names the knowledge base that handed the
 * job over.
 */
import { randomUUID } from 'node:crypto';
import { kbDid } from '@semiont/core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { marks } from '../harness/dispatcher-world';
import { eventually } from '../harness/net';
import { startOtlp, type OtlpReceiver } from '../harness/otlp';
import { metricName, spanName, spec, telemetry, type TelemetryRow } from '../harness/spec';
import { outsideTheTable, received, SPAN_KIND } from '../harness/telemetry';
import { eachWorkerService, type RunningJob, type Served, type WorkerServiceWorld } from '../harness/worker-service-world';
import { counting, markJob, settled, TEXT } from './support';

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

/** Where the worker exports, and how soon it does. */
const exporting = () => ({ OTEL_EXPORTER_OTLP_ENDPOINT: otlp().endpoint, OTEL_METRIC_EXPORT_INTERVAL: '500', OTEL_BSP_SCHEDULE_DELAY: '100' });

const SCHEMA = {
  id: 'argument',
  name: 'Argument',
  description: 'What a text claims and what it offers in support',
  domain: 'rhetoric',
  tags: [{ name: 'Claim', description: 'What the text asserts', examples: ['What is being asserted?'] }],
};

const SOURCE = 'res-ws-telemetry-source';

/** A `yield` job focused on a resource, queued. */
function yieldJob(w: WorkerServiceWorld): RunningJob {
  const resource = { '@context': 'https://schema.org', '@id': SOURCE, name: 'Notes on the engine', representations: [{ mediaType: 'text/markdown', storageUri: `file://worker-service/${SOURCE}`, rel: 'original' }] };
  return w.queued('job-ws-telemetry-yield', 'yield', {
    resourceId: SOURCE,
    title: 'The Analytical Engine',
    storageUri: 'file://generated/telemetry.md',
    context: { focus: { kind: 'resource', resource, content: { main: TEXT, related: {} } }, graph: { nodes: [], edges: [] }, metadata: {} },
  });
}

const PDF = 'res-ws-telemetry-pdf';

/** A `mark` job on a PDF the Smelter declined, queued: its text is asked of the gateway, and nothing is asked of the model. */
function pdfJob(w: WorkerServiceWorld): RunningJob {
  w.describe(PDF, 'application/pdf');
  w.world.archivist.anchoredTexts.set(PDF, { kind: 'declined', declined: 'no-text-layer' });
  return w.queued('job-ws-telemetry-pdf', 'mark', { resourceId: PDF, motivation: 'highlighting' });
}

/**
 * One job of each motivation, a generation, a job on a PDF, and each way a
 * job ends that a case can make: failed by its provider, declined, cut off
 * twice, kept though its count says it missed mentions, and cancelled. They
 * are queued in this order and run one at a time.
 */
async function traffic(w: WorkerServiceWorld): Promise<{ served: Served; jobs: Record<string, RunningJob> }> {
  const jobs: Record<string, RunningJob> = {
    highlighting: markJob(w, 'telemetry-highlighting', { motivation: 'highlighting' }),
    commenting: markJob(w, 'telemetry-commenting', { motivation: 'commenting' }),
    assessing: markJob(w, 'telemetry-assessing', { motivation: 'assessing' }),
    linking: markJob(w, 'telemetry-linking', { motivation: 'linking', entityTypes: ['Person'] }),
    tagging: markJob(w, 'telemetry-tagging', { motivation: 'tagging', schemaId: SCHEMA.id, categories: ['Claim'], schema: SCHEMA }),
    yield: yieldJob(w),
    pdf: pdfJob(w),
    failed: markJob(w, 'telemetry-failed', { motivation: 'highlighting' }),
    declined: markJob(w, 'telemetry-declined', { motivation: 'highlighting' }, {}, ' \n'),
    cutOff: markJob(w, 'telemetry-cut-off', { motivation: 'highlighting' }),
    underReported: markJob(w, 'telemetry-under-reported', { motivation: 'linking', entityTypes: ['Place'] }),
    cancelled: markJob(w, 'telemetry-cancelled', { motivation: 'linking', entityTypes: ['Person', 'Place'] }),
  };
  // The last job is cancelled while its first entity type's batch is being committed.
  w.hooks.commit = async (commit) => {
    if (commit.jobId === jobs['cancelled']!.metadata.id) await w.emit('job:cancel-requested', { jobId: jobs['cancelled']!.metadata.id });
    return undefined;
  };
  const cutOff = { response: JSON.stringify([{ exact: 'the first program' }]), doneReason: 'length' };
  w.ollama.script(
    // Highlighting: the provider reports its token usage, and the four spans are found the four ways a span can be.
    {
      response: JSON.stringify([
        { exact: 'the first program' },
        { exact: 'London', prefix: 'standards, and ', suffix: ' ignored it' },
        { exact: 'London' },
        { exact: 'CHARLES BABBAGE' },
      ]),
      usage: { prompt: 412, output: 57 },
    },
    { response: JSON.stringify([{ exact: 'Ada Lovelace', comment: 'She wrote the notes.' }]) },
    { response: JSON.stringify([{ exact: 'nobody tested that claim for a century', assessment: 'No source is given.' }]) },
    { response: JSON.stringify([{ exact: 'Ada Lovelace', entityType: 'Person' }]) },
    counting(1),
    { response: JSON.stringify([{ exact: 'London was wrong.' }]) },
    { response: 'The engine was designed in London and never built.' },
    { status: 500, body: '{"error":"overloaded"}' },
    cutOff,
    cutOff,
    // One place found where the count says nine: the piece cannot be cut smaller, so what was found is kept.
    { response: JSON.stringify([{ exact: 'London', entityType: 'Place', prefix: 'engine in ' }]) },
    counting(9),
    // The cancelled job's first entity type: its second is never asked for.
    { response: JSON.stringify([{ exact: 'Charles Babbage', entityType: 'Person' }]) },
    counting(1),
  );
  const served = await w.start({ env: exporting() });
  for (const name of ['highlighting', 'commenting', 'assessing', 'linking', 'tagging', 'yield', 'pdf']) await settled(served, jobs[name]!);
  await settled(served, jobs['failed']!, 'job:fail');
  await settled(served, jobs['declined']!);
  await settled(served, jobs['cutOff']!, 'job:fail');
  await settled(served, jobs['underReported']!);
  await settled(served, jobs['cancelled']!, 'job:cancel');

  // And one request it answers.
  const listener = await w.listen(['job:limits-result', 'job:limits-failed']);
  const correlationId = randomUUID();
  await w.world.emit(listener.token, { channel: 'job:limits-requested', payload: {}, correlationId, clientId: listener.clientId });
  await listener.stream.next('the limits', (m) => m.frame?.correlationId === correlationId, 15_000);
  return { served, jobs };
}

const valuesOf = (row: TelemetryRow | undefined, key: string): string[] | undefined => row?.attributes.find((a) => a.key === key)?.values;

eachWorkerService('what a worker exports', (world) => {
  it("names jobs and providers in its rows as the spec names them", () => {
    const rows = telemetry('worker');
    const schemas = spec().doc['components'] as { schemas: Record<string, { enum?: string[]; discriminator?: { mapping: Record<string, string> }; properties?: Record<string, { enum?: string[] }> }> };
    const motivations = Object.keys(schemas.schemas['MarkJobParams']!.discriminator!.mapping);
    const providers = schemas.schemas['Engine']!.properties!['provider']!.enum;
    for (const row of [rows.spans.find((r) => r.name === 'job:{jobType}'), rows.metrics.find((r) => r.name === 'semiont.job.outcome'), rows.metrics.find((r) => r.name === 'semiont.job.duration')]) {
      expect(valuesOf(row, 'job.type')).toEqual(schemas.schemas['JobType']!.enum);
      expect(valuesOf(row, 'job.motivation')).toEqual(motivations);
    }
    for (const row of [...rows.spans, ...rows.metrics].filter((r) => r.attributes.some((a) => a.key === 'inference.provider'))) {
      expect(valuesOf(row, 'inference.provider'), row.name).toEqual(providers);
    }
  });

  // One case, and judged before the worker is stopped: everything it exported for the traffic above, held to the table in both directions.
  it("exports, under the worker's name, exactly the telemetry the spec lists: every row it can, and nothing else", async () => {
    const w = world();
    const { jobs } = await traffic(w);

    // A span for each job it held, of the kind and with the attributes its row lists.
    const row = telemetry('worker').spans.find((r) => r.name === 'job:{jobType}')!;
    for (const [name, attributes] of [
      ['highlighting', { 'job.type': 'mark', 'job.motivation': 'highlighting' }],
      ['failed', { 'job.type': 'mark', 'job.motivation': 'highlighting' }],
      ['linking', { 'job.type': 'mark', 'job.motivation': 'linking' }],
      ['yield', { 'job.type': 'yield' }],
    ] as const) {
      const job = jobs[name]!;
      const span = await eventually(`the span of ${job.metadata.id}`, 15_000, () => otlp().spans.find((s) => s.name === spanName('job:{jobType}', { jobType: job.metadata.type }) && s.attributes['job.id'] === job.metadata.id));
      expect(span.kind).toBe(SPAN_KIND[row.kind]);
      expect(span.resource['service.name']).toBe('semiont-worker');
      expect(span.attributes).toEqual({ ...attributes, 'job.id': job.metadata.id, 'resource.id': job.params.resourceId, 'semiont.kb': kbDid(w.domain) });
    }

    // Its jobs counted and timed by how they ended: nine completed, the two declined among them, two failed, and one cancelled.
    for (const metric of ['semiont.job.outcome', 'semiont.job.duration']) {
      const seen = await eventually(`${metric} with every outcome and every motivation`, 15_000, () => {
        const got = otlp().metrics.get(metricName(metric));
        return got && got.attributes.get('job.outcome')?.size === 3 && got.attributes.get('job.motivation')?.size === 5 && got.attributes.get('job.type')?.size === 2 ? got : undefined;
      });
      expect([...seen.attributes.get('job.outcome')!].sort()).toEqual(['cancelled', 'completed', 'failed']);
      expect([...seen.attributes.get('semiont.kb')!]).toEqual([kbDid(w.domain)]);
    }

    // What the provider said it read and wrote, counted as it said it.
    await eventually('the tokens of the generation that reported them', 15_000, () => {
      const directions = otlp().metrics.get(metricName('semiont.inference.tokens'))?.attributes.get('inference.direction');
      return directions?.size === 2 ? true : undefined;
    });

    expect(await outsideTheTable(otlp(), 'worker', null), received(otlp())).toEqual([]);
  });

  it('names, on what it records of each job, the knowledge base of the two it serves that handed the job over', async () => {
    const w = world();
    const second = await w.second();
    const [here, there] = w.engines;
    const jobs = [markJob(w, 'telemetry-here', { motivation: 'highlighting' }), markJob(second, 'telemetry-there', { motivation: 'highlighting' })];
    // The two knowledge bases' engines work at once, so the provider answers by which model asked.
    w.ollama.choose = (body) => ({ response: JSON.stringify([{ exact: body['model'] === here!.model ? 'the first program' : 'Charles Babbage' }]) });
    const served = await w.start({
      engines: [w.entry(here!, [marks('highlighting')])],
      serving: [{ kb: second, engines: [w.entry(there!, [marks('highlighting')])] }],
      env: exporting(),
    });
    for (const [kb, job] of [[w, jobs[0]!], [second, jobs[1]!]] as const) {
      await settled(served.at(kb), job);
      const span = await eventually(`the span of ${job.metadata.id}`, 15_000, () => otlp().spans.find((s) => s.name === spanName('job:{jobType}', { jobType: 'mark' }) && s.attributes['job.id'] === job.metadata.id));
      expect(span.attributes['semiont.kb'], kb.domain).toBe(kbDid(kb.domain));
    }
    // Each job's count names its own knowledge base: between them, the two.
    for (const metric of ['semiont.job.outcome', 'semiont.job.duration']) {
      const seen = await eventually(`${metric} of the second knowledge base`, 15_000, () => {
        const got = otlp().metrics.get(metricName(metric));
        return got?.attributes.get('semiont.kb')?.has(kbDid(second.domain)) ? got : undefined;
      });
      expect([...seen.attributes.get('semiont.kb')!].sort(), metric).toEqual([kbDid(w.domain), kbDid(second.domain)].sort());
    }
  });
});
