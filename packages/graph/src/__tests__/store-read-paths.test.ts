/**
 * What each store does with a row its driver hands back: it flattens the
 * driver's shape and gives the properties to the codec, and decides nothing
 * about them itself.
 *
 * The drivers are fakes that hold the rows a case gives them, so what is
 * under test is the store's own code and not a database. A fake cannot say
 * what a query finds: what neo4j answers to these stores' Cypher is held by
 * the Weaver's conformance suite, against a graph a Weaver wrote.
 */
import { describe, it, expect } from 'vitest';
import { annotationId, getResourceId, resourceId } from '@semiont/core';
import type { Annotation, ResourceDescriptor } from '@semiont/core';
import { encodeAnnotation } from '../annotation-codec';
import type { GraphDatabase } from '../interface';
import { Neo4jGraphDatabase } from '../implementations/neo4j';
import { NeptuneGraphDatabase } from '../implementations/neptune';
import { JanusGraphDatabase } from '../implementations/janusgraph';

/** A person as the record names one: by who they are. A name is the directory's, joined on at a read. */
const CREATOR = { '@type': 'Person' as const, '@id': 'did:web:example.org:users:u1' };
const CREATED = '2026-08-22T10:00:00.000Z';

/** A resource as a reader is to read it back. */
function resource(id: string, entityTypes: string[]): ResourceDescriptor {
  return {
    '@context': 'https://schema.org/',
    '@id': resourceId(id),
    name: id,
    entityTypes,
    representations: [{ mediaType: 'text/markdown', checksum: `sha256:${id}`, rel: 'original' }],
    archived: false,
    dateCreated: CREATED,
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

// ---------------------------------------------------------------------------
// neo4j: a session that answers every query with the one node it holds.
// ---------------------------------------------------------------------------

/** A resource's node as neo4j holds it: a list is a list, and a flag a boolean. */
const node = (id: string, entityTypes: string[]) => ({
  properties: {
    id,
    name: id,
    entityTypes,
    format: 'text/markdown',
    archived: false,
    created: CREATED,
    creator: JSON.stringify(CREATOR),
    contentChecksum: `sha256:${id}`,
  },
});

function neo4jHolding(held: ReturnType<typeof node> | undefined): Neo4jGraphDatabase {
  const db = new Neo4jGraphDatabase({ database: 'neo4j' });
  const session = {
    run: async () => ({ records: held ? [{ get: () => held }] : [] }),
    close: async () => {},
  };
  Object.assign(db, { driver: { session: () => session }, connected: true });
  return db;
}

describe('neo4j read path', () => {
  it('reads a resource node through the resource codec', async () => {
    const db = neo4jHolding(node('res-1', ['Place']));
    expect(await db.getResource(resourceId('res-1'))).toEqual(resource('res-1', ['Place']));
  });

  it('answers none for a resource the database does not hold', async () => {
    const db = neo4jHolding(undefined);
    expect(await db.getResource(resourceId('res-1'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The Gremlin stores: a traversal source that holds vertices in the
// `[{value}]` property shape the drivers hand back, and answers `V()…has(…)`
// by filtering them. Edges are not modelled: a traversal that steps along one
// yields nothing.
// ---------------------------------------------------------------------------

type Vertex = { label: string; properties: Record<string, Array<{ value: string }>> };

interface Traversal {
  next(): Promise<{ value: Vertex | undefined }>;
  toList(): Promise<Vertex[]>;
  [step: string]: (...args: unknown[]) => unknown;
}

const vertex = (label: string, stored: Record<string, string>): Vertex => ({
  label,
  properties: Object.fromEntries(Object.entries(stored).map(([key, value]) => [key, [{ value }]])),
});

/** A resource's vertex as a Gremlin store holds it: a list rides as JSON, and a flag as its word. */
const resourceVertex = (id: string, entityTypes: string[]): Vertex =>
  vertex('Resource', {
    id,
    name: id,
    entityTypes: JSON.stringify(entityTypes),
    format: 'text/markdown',
    archived: 'false',
    created: CREATED,
    creator: JSON.stringify(CREATOR),
    contentChecksum: `sha256:${id}`,
  });

/** An annotation's vertex: the annotation codec's properties, each as the driver hands one back. */
const annotationVertex = (annotation: Annotation): Vertex => vertex('Annotation', encodeAnnotation(annotation));

const valueOf = (held: Vertex, key: unknown) => held.properties[String(key)]?.[0]?.value;

/** `has(label, key, value)`, `has(key, value)` or `has(key)`, as Gremlin reads each arity. */
function has(held: Vertex, args: unknown[]): boolean {
  if (args.length === 3) return held.label === args[0] && valueOf(held, args[1]) === args[2];
  if (args.length === 2) return valueOf(held, args[0]) === args[1];
  return String(args[0]) in held.properties;
}

function gremlinHolding(vertices: Vertex[]) {
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
          if (step === 'hasLabel') {
            current = current.filter((held) => held.label === args[0]);
          } else if (step === 'has') {
            current = current.filter((held) => has(held, args));
          } else if (step !== 'elementMap') {
            current = []; // a step along an edge
          }
          return traversal;
        };
      },
    };
    const traversal = new Proxy({}, handler) as unknown as Traversal;
    return traversal;
  };

  return { V: () => traverse([...vertices]) };
}

function janusgraphHolding(vertices: Vertex[]): JanusGraphDatabase {
  const db = new JanusGraphDatabase({});
  Object.assign(db, { g: gremlinHolding(vertices), connected: true });
  return db;
}

function neptuneHolding(vertices: Vertex[]): NeptuneGraphDatabase {
  const db = new NeptuneGraphDatabase({ endpoint: 'neptune.example.org' });
  Object.assign(db, { g: gremlinHolding(vertices), connected: true });
  return db;
}

const GREMLIN_STORES: Array<[string, (vertices: Vertex[]) => GraphDatabase]> = [
  ['janusgraph', janusgraphHolding],
  ['neptune', neptuneHolding],
];

describe.each(GREMLIN_STORES)('%s read path', (_name, holding) => {
  it('reads a resource vertex through the resource codec: its list parsed, its flag a boolean', async () => {
    const db = holding([resourceVertex('res-1', ['Place', 'County']), resourceVertex('res-2', [])]);
    expect(await db.getResource(resourceId('res-1'))).toEqual(resource('res-1', ['Place', 'County']));
  });

  it('answers none for a resource it does not hold', async () => {
    const db = holding([resourceVertex('res-1', [])]);
    expect(await db.getResource(resourceId('res-9'))).toBeNull();
  });

  it('lists the resources of an entity type', async () => {
    const db = holding([resourceVertex('res-1', ['Place']), resourceVertex('res-2', ['Person'])]);
    const { resources, total } = await db.listResources({ entityTypes: ['Person'] });
    expect(resources.map((found) => getResourceId(found))).toEqual(['res-2']);
    expect(total).toBe(1);
  });
});

/**
 * JanusGraph groups a resource's outgoing references by the resource each one
 * points at: one connection per target, carrying every reference to it.
 * `getResourceConnections` reads no edge: it finds the references and their
 * targets by property.
 */
describe('janusgraph getResourceConnections', () => {
  const resources = [resourceVertex('res-1', []), resourceVertex('res-2', []), resourceVertex('res-3', [])];
  const targets = (db: JanusGraphDatabase) => db.getResourceConnections(resourceId('res-1'));

  it('yields one connection per referenced resource', async () => {
    const connections = await targets(
      janusgraphHolding([
        ...resources,
        annotationVertex(reference('ann-a', 'res-1', 'res-2')),
        annotationVertex(reference('ann-b', 'res-1', 'res-3')),
      ]),
    );

    expect(connections.map((c) => getResourceId(c.targetResource))).toEqual(['res-2', 'res-3']);
    expect(connections.map((c) => c.annotations.map((a) => a.id))).toEqual([['ann-a'], ['ann-b']]);
  });

  it("gathers every reference to one resource into that resource's connection", async () => {
    const connections = await targets(
      janusgraphHolding([
        ...resources,
        annotationVertex(reference('ann-a', 'res-1', 'res-2')),
        annotationVertex(reference('ann-b', 'res-1', 'res-3')),
        annotationVertex(reference('ann-c', 'res-1', 'res-2')),
      ]),
    );

    expect(connections.map((c) => getResourceId(c.targetResource))).toEqual(['res-2', 'res-3']);
    expect(connections.map((c) => c.annotations.map((a) => a.id))).toEqual([['ann-a', 'ann-c'], ['ann-b']]);
  });
});
