/**
 * What the weaver cases share: content to annotate, and the ways a knowledge
 * base comes to hold a resource and an annotation, each through the Archivist,
 * as a person, a service or a worker records.
 */
import { randomUUID } from 'node:crypto';
import { highlight, type Annotation, type BusClient } from '../harness/archivist-world';
import { eventually } from '../harness/net';
import type { WeaverWorld } from '../harness/weaver-world';

export const TEXT = 'The quick brown fox jumps over the lazy dog.\n';

/** Upload a resource as a person, and answer its id. */
export function uploaded(world: WeaverWorld, name: string, by = 'ada'): Promise<string> {
  return world.kb.created(world.kb.world.personDid(by), { name, storageUri: `file://weaver/${randomUUID()}.md`, content: TEXT });
}

/** A highlight of `exact`, asked for by `who`: its id. */
export async function highlighted(who: BusClient, resourceId: string, exact: string): Promise<string> {
  const answer = await who.ask('mark:create-request', { resourceId, request: highlight(resourceId, exact, TEXT.indexOf(exact)) });
  return String(answer['annotationId']);
}

/** A reference on `exact` that links nowhere yet, asked for by `who`: its id. */
export async function referenced(who: BusClient, resourceId: string, exact: string): Promise<string> {
  const answer = await who.ask('mark:create-request', {
    resourceId,
    request: { ...highlight(resourceId, exact, TEXT.indexOf(exact)), motivation: 'linking' },
  });
  return String(answer['annotationId']);
}

export const tag = (value: string) => ({ type: 'TextualBody' as const, value, purpose: 'tagging' as const });
export const link = (source: string) => ({ type: 'SpecificResource' as const, source, purpose: 'linking' as const });

/** An annotation as a worker sends one whole. */
export function whole(resourceId: string, exact: string): Annotation {
  const start = TEXT.indexOf(exact);
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id: randomUUID().replaceAll('-', '') as Annotation['id'],
    motivation: 'highlighting',
    target: { source: resourceId as Annotation['id'] & string, selector: [{ type: 'TextPositionSelector', start, end: start + exact.length }, { type: 'TextQuoteSelector', exact }] },
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
  } as unknown as Annotation;
}

/**
 * Work `requester` asked a worker for: the dispatcher records the job as the
 * worker's, and the worker commits `annotation` citing it. The worker sends
 * the write; the record says who asked.
 */
export async function delegated(world: WeaverWorld, requester: BusClient, worker: BusClient, resourceId: string, annotation: Annotation): Promise<void> {
  const jobId = `job-${randomUUID()}`;
  const dispatcher = await world.kb.sidecar('dispatcher');
  await dispatcher.emit('job:assign', { jobId, jobType: 'mark', resourceId, holder: worker.did, requester: requester.did });
  await eventually('the assignment to be recorded', 10_000, () => world.kb.stored(resourceId).find((event) => event.type === 'job:assigned' && event.payload['jobId'] === jobId));
  await worker.ask('mark:commit', { resourceId, jobId, annotations: [annotation] });
}
