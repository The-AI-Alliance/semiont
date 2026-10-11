/**
 * Each store writes exactly the property bag the codec produced — and reads
 * its own write back unchanged.
 *
 * The conformance suite pins the codec's two halves against each store's
 * decode path. This pins the seam between them: that a store applies the bag
 * verbatim in its own dialect and adds nothing of its own. A hand-written
 * write path that decides for itself what a selector is called and what it
 * defaults to is where a `selector: '{}'` gets minted — outside the codec.
 *
 * The drivers are fakes, so what is under test is the store's own code, not a
 * database. Edge creation (BELONGS_TO/REFERENCES/TAGGED_AS) and connection
 * management need a live store and are not covered here.
 */
import { describe, it, expect } from 'vitest';
import { annotationId, getStorageUri, resourceId } from '@semiont/core';
import type {
  Annotation,
  AnnotationId,
  CreateAnnotationInternal,
  ResourceDescriptor,
  ResourceId,
} from '@semiont/core';
import { Neo4jGraphDatabase } from '../implementations/neo4j';
import { NeptuneGraphDatabase } from '../implementations/neptune';
import { JanusGraphDatabase } from '../implementations/janusgraph';

/** A person as the record names one: by who they are. A name is the directory's, joined on at a read. */
const CREATOR = { '@type': 'Person' as const, '@id': 'did:web:example.org:users:u1' };

/**
 * The AUTHORING moment, deliberately long past. A store that stamps its own
 * clock instead of persisting this cannot be caught by a value near `now` —
 * and `rebuildResource` deletes before it replays, so a restamping store
 * collapses every annotation to the rebuild moment on each reconcile heal.
 */
const AUTHORED = '2020-03-04T05:06:07.000Z';

/** A resource-level reference: source-only target, resolved to another resource. */
const SOURCE_ONLY: CreateAnnotationInternal = {
  id: annotationId('ann-source-only'),
  motivation: 'linking',
  target: { source: resourceId('res-1') },
  body: [{ type: 'SpecificResource', source: resourceId('res-2'), purpose: 'linking' }],
  creator: CREATOR,
  created: AUTHORED,
};

const QUOTE_SELECTOR = { type: 'TextQuoteSelector' as const, exact: 'Black Hawk', prefix: '', suffix: '' };

const HIGHLIGHT: CreateAnnotationInternal = {
  id: annotationId('ann-highlight'),
  motivation: 'highlighting',
  target: { source: resourceId('res-1'), selector: QUOTE_SELECTOR },
  creator: CREATOR,
  created: AUTHORED,
};

const STORAGE_URI = 'file:///kb/res-1.md';

/** The storage URI belongs to the representation, not to the resource. */
const RESOURCE: ResourceDescriptor = {
  '@context': 'https://schema.org/',
  '@id': resourceId('res-1'),
  name: 'Cedar County, Iowa',
  entityTypes: ['Place'],
  representations: [
    { mediaType: 'text/markdown', checksum: 'sha256:abc', rel: 'original', storageUri: STORAGE_URI },
  ],
  archived: false,
  dateCreated: '2026-08-22T10:00:00.000Z',
  wasAttributedTo: CREATOR,
};

/** The same resource whose representation was never stored anywhere. */
const RESOURCE_WITHOUT_STORAGE: ResourceDescriptor = {
  ...RESOURCE,
  representations: [{ mediaType: 'text/markdown', checksum: 'sha256:abc', rel: 'original' }],
};

// ---------------------------------------------------------------------------
// neo4j — a fake session that stores the bag and hands it back the way the
// driver would, `created` included: as a native temporal, not a string.
// ---------------------------------------------------------------------------

type Recorded = { cypher: string; params: Record<string, unknown>; props: Record<string, unknown> };

function neo4jStore(): { db: Neo4jGraphDatabase; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  const db = new Neo4jGraphDatabase({ database: 'neo4j' });

  let annotation: Record<string, unknown> | undefined;

  const run = async (cypher: string, params: Record<string, unknown>) => {
      const props = { ...(params.props as Record<string, unknown> | undefined) };
      recorded.push({ cypher, params, props });

      // A resource write is `SET d = $props` with the resource codec's bag,
      // so the bag IS the stored node. `created` included: it is stored as
      // the string it arrived as, not coerced to a temporal.
      if (cypher.includes('UNWIND $resources')) {
        const batch = params.resources as Array<Record<string, unknown>>;
        return {
          records: batch.map(r => ({
            get: (key: string) =>
              key === 'd' ? { properties: r } : [],
          })),
        };
      }

      if (cypher.includes('MERGE (d:Resource')) {
        return { records: [{ get: (key: string) => (key === 'd' ? { properties: props } : []) }] };
      }

      // Only an annotation write carries a property bag. A read of the
      // annotation by id is answered with the last bag written, as the
      // database would; any other read gets an empty result, which is enough
      // to see the query it asked for.
      if (!params.props) {
        if (annotation && cypher.includes('MATCH (a:Annotation {id: $id})') && params.id === annotation.id) {
          const held = annotation;
          return { records: [{ get: (key: string) => (key === 'a' ? { properties: held } : []) }] };
        }
        return { records: [] };
      }
      annotation = props;

      // The annotation write is `SET a = $props` — the codec's string, stored as
      // written and read back verbatim. Re-setting `created` as a native
      // temporal would reformat the value on the way out, via its toString().
      return { records: [{ get: (key: string) => (key === 'a' ? { properties: props } : []) }] };
  };
  const session = {
    run,
    // A transaction is its work, run once, against the same fake.
    executeWrite: <T>(work: (tx: { run: typeof run }) => Promise<T>) => work({ run }),
    close: async () => {},
  };

  Object.assign(db, { driver: { session: () => session }, connected: true });
  return { db, recorded };
}

describe('neo4j write path', () => {
  it('writes no selector property at all for a source-only target', async () => {
    const { db, recorded } = neo4jStore();
    await db.createAnnotation(SOURCE_ONLY);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.props.id).toBe('ann-source-only'); // the bag is real, not empty
    expect('selector' in recorded[0]!.props).toBe(false);
    expect('exact' in recorded[0]!.props).toBe(false);
    expect(Object.values(recorded[0]!.props)).not.toContain('{}');
  });

  it('applies the codec bag verbatim, with no re-set of created', async () => {
    const { db, recorded } = neo4jStore();
    await db.createAnnotation(HIGHLIGHT);

    expect(recorded[0]!.cypher).toContain('SET a = $props');
    expect(recorded[0]!.cypher).not.toContain('datetime(');
    expect(recorded[0]!.props.selector).toBe(JSON.stringify(QUOTE_SELECTOR));
    expect(recorded[0]!.props.exact).toBe('Black Hawk');
    expect(recorded[0]!.props.type).toBe('TextualBody');
  });

  it('persists the AUTHORED created, not its own clock', async () => {
    const { db, recorded } = neo4jStore();
    await db.createAnnotation(SOURCE_ONLY);

    expect(recorded[0]!.props.created).toBe(AUTHORED);
  });

  it('reads its own write back as the annotation it wrote, created byte-for-byte', async () => {
    const { db } = neo4jStore();
    const written = await db.createAnnotation(SOURCE_ONLY);

    expect(written.target).toEqual({ source: 'res-1' });
    expect(written.motivation).toBe('linking');
    expect(written.created).toBe(AUTHORED);
    expect(written.body).toEqual([{ type: 'SpecificResource', source: 'res-2', purpose: 'linking' }]);
  });

  it("carries the representation's storage URI through the write and back out of the read", async () => {
    const { db, recorded } = neo4jStore();
    const stored = await db.createResource(RESOURCE);

    expect(recorded[0]!.props.storageUri).toBe(STORAGE_URI);
    expect(getStorageUri(stored)).toBe(STORAGE_URI);
  });

  it('writes no storage URI property at all when the representation has none', async () => {
    const { db, recorded } = neo4jStore();
    const stored = await db.createResource(RESOURCE_WITHOUT_STORAGE);

    expect('storageUri' in recorded[0]!.props).toBe(false);
    expect(getStorageUri(stored)).toBeUndefined();
  });

  it('writes a resource as exactly the codec\'s bag, and reads its own write back unchanged', async () => {
    const { db, recorded } = neo4jStore();
    const stored = await db.createResource(RESOURCE);

    expect(recorded[0]!.cypher).toContain('SET d = $props');
    expect(recorded[0]!.props).toEqual({
      id: 'res-1',
      name: 'Cedar County, Iowa',
      entityTypes: ['Place'],
      format: 'text/markdown',
      archived: false,
      created: '2026-08-22T10:00:00.000Z',
      creator: JSON.stringify(CREATOR),
      contentChecksum: 'sha256:abc',
      storageUri: STORAGE_URI,
    });
    expect(stored).toEqual(RESOURCE);
  });

  it('carries the storage URI through the batch write too, one resource per row', async () => {
    const { db, recorded } = neo4jStore();
    const stored = await db.batchCreateResources([RESOURCE, RESOURCE_WITHOUT_STORAGE]);

    const rows = recorded[0]!.params.resources as Array<Record<string, unknown>>;
    expect(rows.map(r => r.storageUri)).toEqual([STORAGE_URI, undefined]);
    expect(stored.map(getStorageUri)).toEqual([STORAGE_URI, undefined]);
  });

  it('replaces the row with the codec\'s bag on an update, and says which tags and link it has', async () => {
    const { db, recorded } = neo4jStore();
    await db.createAnnotation(HIGHLIGHT);

    const updated = await db.updateAnnotation(annotationId('ann-highlight'), {
      body: [
        { type: 'TextualBody', value: 'Person', purpose: 'tagging' },
        { type: 'SpecificResource', source: resourceId('res-2'), purpose: 'linking' },
      ],
    });

    const write = recorded[recorded.length - 1]!;
    expect(write.cypher).toContain('SET a = $props');
    expect(write.props.source).toBe('res-2');
    expect(write.params.entityTypes).toEqual(['Person']);
    expect(write.params.linked).toEqual(['res-2']);
    // Nothing of the store's own: no body property, no clock.
    expect(Object.keys(write.props).sort()).toEqual(
      ['created', 'creator', 'exact', 'id', 'motivation', 'resourceId', 'selector', 'source', 'type'],
    );
    expect(write.cypher).not.toMatch(/datetime\(\)|updatedAt/);
    expect(updated.created).toBe(AUTHORED);
  });

  it('takes the link and the tags away when an update leaves the body empty', async () => {
    const { db, recorded } = neo4jStore();
    await db.createAnnotation(SOURCE_ONLY);

    const updated = await db.updateAnnotation(annotationId('ann-source-only'), { body: [] });

    const write = recorded[recorded.length - 1]!;
    expect('source' in write.props).toBe(false);
    expect(write.params.entityTypes).toEqual([]);
    expect(write.params.linked).toEqual([]);
    expect(write.cypher).toContain('DELETE stale');
    expect(updated.body).toBeUndefined();
  });

  it('refuses to update an annotation that is not there', async () => {
    const { db } = neo4jStore();
    await expect(db.updateAnnotation(annotationId('nobody'), { body: [] })).rejects.toThrow('Annotation not found');
  });

  it('fails loudly when the resource the annotation belongs to is not in the graph', async () => {
    const db = new Neo4jGraphDatabase({ database: 'neo4j' });
    const session = { run: async () => ({ records: [] }), close: async () => {} };
    Object.assign(db, { driver: { session: () => session }, connected: true });

    await expect(db.createAnnotation(SOURCE_ONLY)).rejects.toThrow(/Resource res-1 not found/);
  });
});

// ---------------------------------------------------------------------------
// The Gremlin stores — one recorder serves both, because their write paths are
// the same chain. Entity-type edges are skipped (no tagging bodies here), so
// no anonymous-traversal helper from the gremlin peer dependency is reached.
// ---------------------------------------------------------------------------

interface Chain {
  next(): Promise<{ value: string }>;
  toList(): Promise<unknown[]>;
  [method: string]: (...args: unknown[]) => unknown;
}

function gremlinRecorder(): { g: Chain; written: Record<string, string>; filtered: Record<string, string> } {
  const written: Record<string, string> = {};
  const filtered: Record<string, string> = {};
  // The recorder is a tiny store: what it hands back is what was written to
  // it, in the `[{value}]` shape the Gremlin drivers use.
  const vertex = () => ({
    properties: Object.fromEntries(Object.entries(written).map(([k, v]) => [k, [{ value: v }]])),
  });
  const handler: ProxyHandler<object> = {
    get(_target, method) {
      if (method === 'next') return async () => ({ value: vertex() });
      if (method === 'toList') return async () => (Object.keys(written).length > 0 ? [vertex()] : []);
      return (...args: unknown[]) => {
        if (method === 'property') written[String(args[0])] = String(args[1]);
        if (method === 'has' && args.length === 2) filtered[String(args[0])] = String(args[1]);
        return chain;
      };
    },
  };
  const chain = new Proxy({}, handler) as unknown as Chain;
  return { g: chain, written, filtered };
}

interface GremlinStore {
  db: {
    createAnnotation(input: CreateAnnotationInternal): Promise<unknown>;
    updateAnnotation(id: AnnotationId, updates: Partial<Annotation>): Promise<unknown>;
    createResource(resource: ResourceDescriptor): Promise<unknown>;
    getResource(id: ResourceId): Promise<ResourceDescriptor | null>;
  };
  written: Record<string, string>;
  filtered: Record<string, string>;
}

const GREMLIN_STORES: Array<[string, () => GremlinStore]> = [
  [
    'neptune',
    () => {
      const { g, written, filtered } = gremlinRecorder();
      const db = new NeptuneGraphDatabase({});
      Object.assign(db, { g, connected: true });
      return { db, written, filtered };
    },
  ],
  [
    'janusgraph',
    () => {
      const { g, written, filtered } = gremlinRecorder();
      const db = new JanusGraphDatabase({});
      Object.assign(db, { g, connected: true });
      return { db, written, filtered };
    },
  ],
];

describe.each(GREMLIN_STORES)('%s write path', (_name, makeStore) => {
  it('writes no selector property at all for a source-only target', async () => {
    const { db, written } = makeStore();
    await db.createAnnotation(SOURCE_ONLY);

    expect(written.id).toBe('ann-source-only'); // the bag is real, not empty
    expect('selector' in written).toBe(false);
    expect('exact' in written).toBe(false);
    expect('text' in written).toBe(false);
    expect(Object.values(written)).not.toContain('{}');
  });

  it('persists the AUTHORED created, not its own clock', async () => {
    const { db, written } = makeStore();
    await db.createAnnotation(SOURCE_ONLY);

    expect(written.created).toBe(AUTHORED);
  });

  it('writes the same bag the other stores write', async () => {
    const { db, written } = makeStore();
    await db.createAnnotation(HIGHLIGHT);

    expect(written.selector).toBe(JSON.stringify(QUOTE_SELECTOR));
    expect(written.exact).toBe('Black Hawk');
    expect(written.type).toBe('TextualBody');
    expect(written.motivation).toBe('highlighting');
    expect(written.resourceId).toBe('res-1');
    expect(written.id).toBe('ann-highlight');
  });

  it("carries the representation's storage URI through its own write/read seam", async () => {
    const { db, written } = makeStore();
    await db.createResource(RESOURCE);
    expect(written.storageUri).toBe(STORAGE_URI);

    const read = await db.getResource(resourceId('res-1'));
    expect(getStorageUri(read!)).toBe(STORAGE_URI);
  });

  it('writes no storage URI property at all when the representation has none', async () => {
    const { db, written } = makeStore();
    await db.createResource(RESOURCE_WITHOUT_STORAGE);
    expect('storageUri' in written).toBe(false);

    const read = await db.getResource(resourceId('res-1'));
    expect(getStorageUri(read!)).toBeUndefined();
  });

  it('persists BOTH properties of a selector update — the selector and its quoted text', async () => {
    const { db, written } = makeStore();
    await db.createAnnotation(SOURCE_ONLY);

    const moved = { type: 'TextQuoteSelector' as const, exact: 'Cedar County', prefix: '', suffix: '' };
    await db.updateAnnotation(annotationId('ann-source-only'), { target: { source: resourceId('res-1'), selector: moved } });

    expect(written.selector).toBe(JSON.stringify(moved));
    expect(written.exact).toBe('Cedar County');
  });
});

describe('janusgraph read path', () => {
  it('finds a resource\'s references by the type it wrote for one', async () => {
    const write = gremlinRecorder();
    const writer = new JanusGraphDatabase({});
    Object.assign(writer, { g: write.g, connected: true });
    await writer.createAnnotation(SOURCE_ONLY);

    // A filter asking for one value while the write stores another matches
    // no reference. Both sides read the same derivation.
    const read = gremlinRecorder();
    const reader = new JanusGraphDatabase({});
    Object.assign(reader, { g: read.g, connected: true });
    await reader.getResourceConnections(resourceId('res-1'));

    expect(read.filtered.type).toBe(write.written.type);
  });
});
