/**
 * JanusGraph groups a resource's outgoing references by the resource each one
 * points at: one connection per target, carrying every reference to it.
 *
 * The driver is a fake that keeps the vertices it is asked to add and answers
 * `V()…has(…)` by filtering them. Edges are not modelled: a traversal that
 * steps along one yields nothing. `getResourceConnections` reads none — it
 * finds the references and their targets by property.
 */
import { describe, it, expect } from 'vitest';
import { annotationId, getResourceId, resourceId } from '@semiont/core';
import type { CreateAnnotationInternal, ResourceDescriptor } from '@semiont/core';
import { JanusGraphDatabase } from '../implementations/janusgraph';

const CREATOR = { '@type': 'Person' as const, id: 'did:web:example.org:users:u1', name: 'Ada' };

function resource(id: string): ResourceDescriptor {
  return {
    '@context': 'https://schema.org/',
    '@id': resourceId(id),
    name: id,
    entityTypes: [],
    representations: [{ mediaType: 'text/markdown', checksum: `sha256:${id}`, rel: 'original' }],
    archived: false,
    dateCreated: '2026-08-22T10:00:00.000Z',
    wasAttributedTo: CREATOR,
  };
}

function reference(id: string, from: string, to: string): CreateAnnotationInternal {
  return {
    id: annotationId(id),
    motivation: 'linking',
    target: { source: resourceId(from) },
    body: [{ type: 'SpecificResource', source: resourceId(to), purpose: 'linking' }],
    creator: CREATOR,
    created: '2020-03-04T05:06:07.000Z',
  };
}

/** A vertex in the `[{value}]` property shape the Gremlin drivers hand back. */
type Vertex = { label: string; properties: Record<string, Array<{ value: string }>> };

interface Traversal {
  next(): Promise<{ value: Vertex | undefined }>;
  toList(): Promise<Vertex[]>;
  [step: string]: (...args: unknown[]) => unknown;
}

const valueOf = (vertex: Vertex, key: unknown) => vertex.properties[String(key)]?.[0]?.value;

/** `has(label, key, value)`, `has(key, value)` or `has(key)`, as Gremlin reads each arity. */
function has(vertex: Vertex, args: unknown[]): boolean {
  if (args.length === 3) return vertex.label === args[0] && valueOf(vertex, args[1]) === args[2];
  if (args.length === 2) return valueOf(vertex, args[0]) === args[1];
  return String(args[0]) in vertex.properties;
}

function gremlinVertexStore() {
  const vertices: Vertex[] = [];

  const traverse = (start: Vertex[]): Traversal => {
    let current = start;
    const handler: ProxyHandler<object> = {
      get(_target, step) {
        // Not a thenable: a traversal awaited by mistake resolves to itself
        // rather than hanging the test.
        if (step === 'then') return undefined;
        if (step === 'next') return async () => ({ value: current[0] });
        if (step === 'toList') return async () => current;
        return (...args: unknown[]) => {
          if (step === 'property') {
            for (const vertex of current) vertex.properties[String(args[0])] = [{ value: String(args[1]) }];
          } else if (step === 'hasLabel') {
            current = current.filter(vertex => vertex.label === args[0]);
          } else if (step === 'has') {
            current = current.filter(vertex => has(vertex, args));
          } else if (step !== 'to') {
            current = []; // a step along an edge
          }
          return traversal;
        };
      },
    };
    const traversal = new Proxy({}, handler) as unknown as Traversal;
    return traversal;
  };

  return {
    V: (vertex?: Vertex) => traverse(vertex ? [vertex] : [...vertices]),
    addV: (label: string) => {
      const vertex: Vertex = { label, properties: {} };
      vertices.push(vertex);
      return traverse([vertex]);
    },
  };
}

function janusgraph(): JanusGraphDatabase {
  const db = new JanusGraphDatabase({});
  Object.assign(db, { g: gremlinVertexStore(), connected: true });
  return db;
}

describe('janusgraph getResourceConnections', () => {
  it('yields one connection per referenced resource', async () => {
    const db = janusgraph();
    await db.batchCreateResources([resource('res-1'), resource('res-2'), resource('res-3')]);
    await db.createAnnotations([
      reference('ann-a', 'res-1', 'res-2'),
      reference('ann-b', 'res-1', 'res-3'),
    ]);

    const connections = await db.getResourceConnections(resourceId('res-1'));

    expect(connections.map(c => getResourceId(c.targetResource))).toEqual(['res-2', 'res-3']);
    expect(connections.map(c => c.annotations.map(a => a.id))).toEqual([['ann-a'], ['ann-b']]);
  });

  it("gathers every reference to one resource into that resource's connection", async () => {
    const db = janusgraph();
    await db.batchCreateResources([resource('res-1'), resource('res-2'), resource('res-3')]);
    await db.createAnnotations([
      reference('ann-a', 'res-1', 'res-2'),
      reference('ann-b', 'res-1', 'res-3'),
      reference('ann-c', 'res-1', 'res-2'),
    ]);

    const connections = await db.getResourceConnections(resourceId('res-1'));

    expect(connections.map(c => getResourceId(c.targetResource))).toEqual(['res-2', 'res-3']);
    expect(connections.map(c => c.annotations.map(a => a.id))).toEqual([['ann-a', 'ann-c'], ['ann-b']]);
  });
});
