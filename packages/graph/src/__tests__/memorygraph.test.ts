/**
 * The graph a test of a reader is given. It holds what it is made with, and
 * answers each read as a store that had been written that would: other
 * packages' tests read the graph through it, so what it answers is held here.
 */
import { describe, it, expect } from 'vitest';
import { annotationId, getResourceId, resourceId } from '@semiont/core';
import type { Annotation, ResourceDescriptor } from '@semiont/core';
import { MemoryGraphDatabase } from '../implementations/memorygraph';

/** A person as the record names one: by who they are. A name is the directory's, joined on at a read. */
const CREATOR = { '@type': 'Person' as const, '@id': 'did:web:example.org:users:u1' };

/** A resource as the Weaver gives one to the graph. */
function resource(id: string, entityTypes: string[]): ResourceDescriptor {
  return {
    '@context': 'https://schema.org/',
    '@id': resourceId(id),
    name: id,
    entityTypes,
    representations: [{ mediaType: 'text/markdown', checksum: `sha256:${id}`, rel: 'original' }],
    archived: false,
    dateCreated: '2026-08-22T10:00:00.000Z',
    wasAttributedTo: CREATOR,
  };
}

/** A reference on `from` that links to `to`, as the record holds one. */
function reference(id: string, from: string, to: string): Annotation {
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id: annotationId(id),
    motivation: 'linking',
    target: { source: resourceId(from) },
    body: [{ type: 'SpecificResource', source: resourceId(to), purpose: 'linking' }],
    creator: CREATOR,
    created: '2020-03-04T05:06:07.000Z',
  };
}

function highlight(id: string, on: string): Annotation {
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id: annotationId(id),
    motivation: 'highlighting',
    target: { source: resourceId(on), selector: { type: 'TextPositionSelector', start: 0, end: 4 } },
    creator: CREATOR,
    created: '2020-03-04T05:06:07.000Z',
  };
}

/** res-1 and res-2 link to each other; res-1 has a highlight too; res-3 stands alone. */
const graph = () =>
  new MemoryGraphDatabase({
    resources: [resource('res-1', ['Place']), resource('res-2', ['Place', 'County']), resource('res-3', [])],
    annotations: [reference('ann-a', 'res-1', 'res-2'), reference('ann-b', 'res-2', 'res-1'), highlight('ann-h', 'res-1')],
  });

const ids = (annotations: Annotation[]) => annotations.map((annotation) => String(annotation.id)).sort();

describe('MemoryGraphDatabase', () => {
  it('holds the resources it is made with, by id, and none it was not', async () => {
    expect(await graph().getResource(resourceId('res-1'))).toEqual(resource('res-1', ['Place']));
    expect(await graph().getResource(resourceId('res-9'))).toBeNull();
  });

  it('refuses to be made with a resource that has no id', () => {
    const { '@id': _none, ...unnamed } = resource('res-1', []);
    expect(() => new MemoryGraphDatabase({ resources: [unnamed as ResourceDescriptor], annotations: [] })).toThrow(
      'Resource must have an id',
    );
  });

  it('lists the resources of an entity type, and counts the whole match', async () => {
    const { resources, total } = await graph().listResources({ entityTypes: ['County'] });
    expect(resources.map((found) => getResourceId(found))).toEqual(['res-2']);
    expect(total).toBe(1);
  });

  it('reads an annotation by id, the annotations on a resource, and the ones that link to it', async () => {
    const held = graph();
    expect((await held.getAnnotation(annotationId('ann-h')))?.motivation).toBe('highlighting');
    expect(ids(await held.getResourceAnnotations(resourceId('res-1')))).toEqual(['ann-a', 'ann-h']);
    expect(ids(await held.getResourceReferencedBy(resourceId('res-1')))).toEqual(['ann-b']);
  });

  it('connects a resource to each resource it links to, and says when the link is returned', async () => {
    const connections = await graph().getResourceConnections(resourceId('res-1'));
    expect(connections.map((connection) => getResourceId(connection.targetResource))).toEqual(['res-2']);
    expect(ids(connections[0]!.annotations)).toEqual(['ann-a']);
    expect(connections[0]!.bidirectional).toBe(true);
    expect(await graph().getResourceConnections(resourceId('res-3'))).toEqual([]);
  });

  it('counts its resources by entity type', async () => {
    const byType = (a: { type: string }, b: { type: string }) => a.type.localeCompare(b.type);
    expect((await graph().getEntityTypeStats()).sort(byType)).toEqual([
      { type: 'County', count: 1 },
      { type: 'Place', count: 2 },
    ]);
  });
});
