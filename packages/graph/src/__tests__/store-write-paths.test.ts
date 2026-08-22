/**
 * Each store writes exactly the property bag the codec produced — and reads
 * its own write back unchanged.
 *
 * The conformance suite pins the codec's two halves against each store's
 * decode path. This pins the seam between them: that a store applies the bag
 * verbatim in its own dialect and adds nothing of its own. That is where the
 * `selector: '{}'` was minted — not in the codec, but in three hand-written
 * write paths that each decided what a selector was called and what it
 * defaulted to.
 *
 * The drivers are fakes, so what is under test is the store's own code, not a
 * database. Edge creation (BELONGS_TO/REFERENCES/TAGGED_AS) and connection
 * management need a live store and are not covered here.
 */
import { describe, it, expect } from 'vitest';
import { annotationId } from '@semiont/core';
import type { Annotation, AnnotationId, CreateAnnotationInternal } from '@semiont/core';
import { Neo4jGraphDatabase } from '../implementations/neo4j';
import { NeptuneGraphDatabase } from '../implementations/neptune';
import { JanusGraphDatabase } from '../implementations/janusgraph';

const CREATOR = { '@type': 'Person' as const, id: 'did:semiont:user:u1', name: 'Ada' };

/** A resource-level reference: source-only target, resolved to another resource. */
const SOURCE_ONLY: CreateAnnotationInternal = {
  id: annotationId('ann-source-only'),
  motivation: 'linking',
  target: { source: 'res-1' },
  body: [{ type: 'SpecificResource', source: 'res-2', purpose: 'linking' }],
  creator: CREATOR,
};

const QUOTE_SELECTOR = { type: 'TextQuoteSelector' as const, exact: 'Black Hawk', prefix: '', suffix: '' };

const HIGHLIGHT: CreateAnnotationInternal = {
  id: annotationId('ann-highlight'),
  motivation: 'highlighting',
  target: { source: 'res-1', selector: QUOTE_SELECTOR },
  creator: CREATOR,
};

// ---------------------------------------------------------------------------
// neo4j — a fake session that stores the bag and hands it back the way the
// driver would, `created` included: as a native temporal, not a string.
// ---------------------------------------------------------------------------

type Recorded = { cypher: string; params: Record<string, unknown>; props: Record<string, string> };

function neo4jStore(): { db: Neo4jGraphDatabase; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  const db = new Neo4jGraphDatabase({ database: 'neo4j' });

  const session = {
    run: async (cypher: string, params: Record<string, unknown>) => {
      const props = { ...(params.props as Record<string, string> | undefined) };
      recorded.push({ cypher, params, props });

      // Only a write carries a property bag; a read gets an empty result, which
      // is enough to see the query it asked for.
      if (!params.props) return { records: [] };

      // `SET a.created = datetime($created)` — what comes back out is a
      // temporal object whose toString() is the ISO form.
      const stored = { ...props, created: { toString: () => props.created } };
      return { records: [{ get: (key: string) => (key === 'a' ? { properties: stored } : []) }] };
    },
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

  it('applies the codec bag verbatim and re-sets created as a temporal', async () => {
    const { db, recorded } = neo4jStore();
    await db.createAnnotation(HIGHLIGHT);

    expect(recorded[0]!.cypher).toContain('SET a = $props, a.created = datetime($created)');
    expect(recorded[0]!.props.selector).toBe(JSON.stringify(QUOTE_SELECTOR));
    expect(recorded[0]!.props.exact).toBe('Black Hawk');
    expect(recorded[0]!.props.type).toBe('TextualBody');
  });

  it('reads its own write back as the annotation it wrote, temporal and all', async () => {
    const { db } = neo4jStore();
    const written = await db.createAnnotation(SOURCE_ONLY);

    expect(written.target).toEqual({ source: 'res-1' });
    expect(written.motivation).toBe('linking');
    expect(typeof written.created).toBe('string');
    expect(written.body).toEqual([{ type: 'SpecificResource', source: 'res-2', purpose: 'linking' }]);
  });

  it('filters highlights on the value it actually wrote for one', async () => {
    const { db, recorded } = neo4jStore();
    await db.createAnnotation(HIGHLIGHT);
    await db.listAnnotations({ type: 'highlight' });

    // The bug this closes: every store's filter asked for 'TextualBody' while
    // every store wrote 'SpecificResource', so the highlight filter matched
    // nothing. Both sides read the same derivation now.
    const query = recorded[1]!;
    expect(query.cypher).toContain('a.type = $type');
    expect(query.params.type).toBe(recorded[0]!.props.type);
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
    listAnnotations(filter: { type?: 'highlight' | 'reference' }): Promise<unknown>;
    updateAnnotation(id: AnnotationId, updates: Partial<Annotation>): Promise<unknown>;
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

  it('filters highlights on the value it actually wrote for one', async () => {
    const write = makeStore();
    await write.db.createAnnotation(HIGHLIGHT);

    const read = makeStore();
    await read.db.listAnnotations({ type: 'highlight' });

    expect(read.filtered.type).toBe(write.written.type);
  });

  it('persists BOTH properties of a selector update — neptune used to write only the quoted text', async () => {
    const { db, written } = makeStore();
    await db.createAnnotation(SOURCE_ONLY);

    const moved = { type: 'TextQuoteSelector' as const, exact: 'Cedar County', prefix: '', suffix: '' };
    await db.updateAnnotation(annotationId('ann-source-only'), { target: { source: 'res-1', selector: moved } });

    expect(written.selector).toBe(JSON.stringify(moved));
    expect(written.exact).toBe('Cedar County');
  });
});
