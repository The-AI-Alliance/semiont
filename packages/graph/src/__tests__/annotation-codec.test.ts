/**
 * The cross-store annotation codec conformance suite.
 *
 * One case table, every store's codec path, identical output required.
 * Stores that disagree — a missing selector throwing in one and becoming `{}`
 * in another, a missing motivation throwing in one and silently becoming
 * `'linking'` in another — turn one event log into three different
 * annotations.
 *
 * The codec is pure, so every case here runs with no live store.
 */
import { describe, it, expect } from 'vitest';
import { annotationId, resourceId } from '@semiont/core';
import type { Annotation, ResourceId } from '@semiont/core';
import {
  encodeAnnotation,
  intendedGraphAnnotation,
  motivationForCategory,
  storedAnnotationType,
  type AnnotationProperties,
} from '../annotation-codec';
import { parseAnnotationNode } from '../implementations/neo4j';
import { vertexToAnnotation as neptuneVertexToAnnotation } from '../implementations/neptune';
import { vertexToAnnotation as janusVertexToAnnotation } from '../implementations/janusgraph';
import { MemoryGraphDatabase } from '../implementations/memorygraph';

/** A person as the record names one: by who they are. A name is the directory's, joined on at a read. */
const CREATOR = { '@type': 'Person' as const, '@id': 'did:web:example.org:users:u1' };
const CREATED = '2026-08-21T10:00:00.000Z';

/** An annotation as the record holds one: the W3C envelope around the fields a case names. */
const annotation = (fields: Omit<Annotation, '@context' | 'type'>): Annotation => ({
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  type: 'Annotation',
  ...fields,
});

/**
 * Each store hands the codec a flat property bag, but shapes its own on the
 * way in. These adapters are those shapes: the same properties as the
 * driver would hand back, so the decode path under test is the real one.
 */
const STORES: Array<{ name: string; decode: (p: AnnotationProperties, e?: string[]) => Annotation }> = [
  {
    name: 'neo4j',
    decode: (props, entityTypes) => parseAnnotationNode({ properties: { ...props } }, entityTypes),
  },
  {
    name: 'neptune',
    decode: (props, entityTypes) =>
      neptuneVertexToAnnotation(
        { id: props.id, properties: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, [{ value: v }]])) },
        entityTypes
      ),
  },
  {
    name: 'janusgraph',
    decode: (props, entityTypes) =>
      janusVertexToAnnotation(
        { properties: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, [{ value: v }]])) },
        entityTypes
      ),
  },
];

/** A resource-level annotation: source-only target, no selector anywhere. */
const RESOURCE_LEVEL: AnnotationProperties = {
  id: 'ann-1',
  resourceId: 'res-1',
  motivation: 'linking',
  creator: JSON.stringify(CREATOR),
  created: CREATED,
};

const QUOTE_SELECTOR = { type: 'TextQuoteSelector', exact: 'Black Hawk', prefix: '', suffix: '' };

const FULLY_POPULATED: AnnotationProperties = {
  ...RESOURCE_LEVEL,
  selector: JSON.stringify(QUOTE_SELECTOR),
  source: 'res-2',
  exact: 'Black Hawk',
  type: 'SpecificResource',
};

describe.each(STORES)('$name — decode conformance', ({ decode }) => {
  it('A2: a source-only annotation decodes with NO selector key in target', () => {
    const ann = decode(RESOURCE_LEVEL);
    expect(ann.target).toEqual({ source: 'res-1' });
    expect('selector' in (ann.target as object)).toBe(false);
  });

  it("a row whose stored selector is '{}' decodes clean — no migration needed", () => {
    const ann = decode({ ...RESOURCE_LEVEL, selector: '{}' });
    expect('selector' in (ann.target as object)).toBe(false);
  });

  it('A3: a row missing motivation throws — never silently becomes linking', () => {
    const { motivation, ...withoutMotivation } = RESOURCE_LEVEL;
    expect(() => decode(withoutMotivation)).toThrow(/missing required field: motivation/);
  });

  it('a row missing created throws by name, rather than yielding an undefined timestamp', () => {
    const { created, ...withoutCreated } = RESOURCE_LEVEL;
    expect(() => decode(withoutCreated)).toThrow(/missing required field: created/);
  });

  it('preserves a real selector, and rebuilds the tagging and linking bodies', () => {
    const ann = decode(FULLY_POPULATED, ['Person', '', 'Org']);
    expect(ann.target).toEqual({ source: 'res-1', selector: QUOTE_SELECTOR });
    // Tags in the codec's one order, then the link.
    expect(ann.body).toEqual([
      { type: 'TextualBody', value: 'Org', purpose: 'tagging' },
      { type: 'TextualBody', value: 'Person', purpose: 'tagging' },
      { type: 'SpecificResource', source: resourceId('res-2'), purpose: 'linking' },
    ]);
  });
});

describe('A4: the stores agree', () => {
  it('decodes a fully-populated annotation identically in every store', () => {
    const [first, ...rest] = STORES.map((s) => s.decode(FULLY_POPULATED, ['Person']));
    for (const other of rest) expect(other).toEqual(first);
  });

  it('decodes a source-only annotation identically in every store', () => {
    const [first, ...rest] = STORES.map((s) => s.decode(RESOURCE_LEVEL));
    for (const other of rest) expect(other).toEqual(first);
  });
});

describe('encode — absence is stored as absence', () => {
  const sourceOnly = annotation({
    id: annotationId('ann-1'),
    motivation: 'linking',
    target: { source: resourceId('res-1') },
    body: [{ type: 'SpecificResource', source: resourceId('res-2'), purpose: 'linking' }],
    creator: CREATOR,
    created: CREATED,
  });

  it('emits NO selector property at all for a source-only target', () => {
    const props = encodeAnnotation(sourceOnly);
    expect('selector' in props).toBe(false);
    expect(Object.values(props)).not.toContain('{}');
  });

  it('emits no exact property when there is no selector to quote', () => {
    expect('exact' in encodeAnnotation(sourceOnly)).toBe(false);
  });

  it('round-trips through decode unchanged, in every store', () => {
    const props = encodeAnnotation(sourceOnly);
    for (const store of STORES) expect(store.decode(props)).toEqual(sourceOnly);
  });

  it('round-trips a selector-bearing annotation unchanged, in every store', () => {
    const highlight = annotation({
      id: annotationId('ann-2'),
      motivation: 'highlighting',
      target: { source: resourceId('res-1'), selector: QUOTE_SELECTOR as never },
      creator: CREATOR,
      created: CREATED,
    });
    const props = encodeAnnotation(highlight);
    expect(props.selector).toBe(JSON.stringify(QUOTE_SELECTOR));
    for (const store of STORES) expect(store.decode(props)).toEqual(highlight);
  });

  it('discriminates highlights from references in the stored type, so the category filter can match', () => {
    const highlight = annotation({
      id: annotationId('ann-3'),
      motivation: 'highlighting',
      target: { source: resourceId('res-1'), selector: QUOTE_SELECTOR as never },
      creator: CREATOR,
      created: CREATED,
    });
    expect(encodeAnnotation(highlight).type).toBe('TextualBody');
    expect(encodeAnnotation(sourceOnly).type).toBe('SpecificResource');
  });
});

describe('encode — the fields a store cannot invent for itself', () => {
  const base = annotation({
    id: annotationId('ann-4'),
    motivation: 'linking',
    target: { source: resourceId('res-1') },
    creator: CREATOR,
    created: CREATED,
  });

  it('refuses an annotation whose target has no source', () => {
    expect(() => encodeAnnotation({ ...base, target: { source: '' as ResourceId } })).toThrow(/no target source/);
  });

  it('writes a selector but no exact when the selector quotes nothing', () => {
    const positional = annotation({
      id: annotationId('ann-5'),
      motivation: 'highlighting',
      target: { source: resourceId('res-1'), selector: { type: 'TextPositionSelector', start: 10, end: 20 } },
      creator: CREATOR,
      created: CREATED,
    });
    const props = encodeAnnotation(positional);
    expect(props.selector).toBe(JSON.stringify({ type: 'TextPositionSelector', start: 10, end: 20 }));
    expect('exact' in props).toBe(false);
    for (const store of STORES) expect(store.decode(props)).toEqual(positional);
  });

  it('carries modified and generator across the round trip, in every store', () => {
    const provenance: Annotation = {
      ...base,
      modified: '2026-08-22T09:00:00.000Z',
      generator: { '@type': 'Software', name: 'semiont' },
    };
    const props = encodeAnnotation(provenance);
    for (const store of STORES) expect(store.decode(props)).toEqual(provenance);
  });

  it('survives a generator that does not parse, rather than failing the whole read', () => {
    const props = { ...encodeAnnotation(base), generator: '{ not json' };
    for (const store of STORES) {
      const decoded = store.decode(props);
      expect(decoded.generator).toBeUndefined();
      expect(decoded.id).toBe('ann-4');
    }
  });
});

describe('the category a caller filters by maps to one motivation, in one place', () => {
  it.each([
    ['highlight', 'highlighting', 'TextualBody'],
    ['reference', 'linking', 'SpecificResource'],
  ] as const)('%s → %s → stored type %s', (category, motivation, storedType) => {
    expect(motivationForCategory(category)).toBe(motivation);
    expect(storedAnnotationType(motivationForCategory(category))).toBe(storedType);
  });
});

describe('each store flattens its own driver shapes before the codec sees them', () => {
  const bag = { ...RESOURCE_LEVEL };

  it('neo4j: a null property is dropped, and a non-string is stringified', () => {
    const ann = parseAnnotationNode({
      properties: { ...bag, source: null, modified: { toString: () => '2026-08-22T00:00:00Z' } },
    });
    expect(ann.body).toBeUndefined(); // a null source is no source
    expect(ann.modified).toBe('2026-08-22T00:00:00Z');
  });

  it('neptune: unwraps [{value}], bare values, and empty lists alike', () => {
    const ann = neptuneVertexToAnnotation({
      properties: {
        id: [{ value: 'ann-1' }],
        resourceId: 'res-1', // bare, as elementMap() returns it
        motivation: { value: 'linking' },
        creator: [{ value: JSON.stringify(CREATOR) }],
        created: [{ value: CREATED }],
        source: [], // an empty property list is not a source
        modified: null,
      },
    });
    expect(ann.id).toBe('ann-1');
    expect(ann.target).toEqual({ source: 'res-1' });
    expect(ann.body).toBeUndefined();
    expect(ann.modified).toBeUndefined();
  });

  it('janusgraph: an empty property list is absent, not undefined-valued', () => {
    const ann = janusVertexToAnnotation({
      properties: { ...Object.fromEntries(Object.entries(bag).map(([k, v]) => [k, [{ value: v }]])), modified: [] },
    });
    expect('modified' in ann).toBe(false);
    expect('generator' in ann).toBe(false);
  });
});

describe('memorygraph holds an annotation as the serializing stores do: through the codec', () => {
  it('reads a source-only annotation back selector-free', async () => {
    const given = annotation({
      id: annotationId('ann-mem-1'),
      motivation: 'linking',
      target: { source: resourceId('res-1') },
      body: [{ type: 'SpecificResource', source: resourceId('res-2'), purpose: 'linking' }],
      creator: CREATOR,
      created: CREATED,
    });
    const graph = new MemoryGraphDatabase({ resources: [], annotations: [given] });

    const fetched = await graph.getAnnotation(annotationId('ann-mem-1'));
    expect(fetched).toEqual(intendedGraphAnnotation(given));
    expect('selector' in (fetched!.target as object)).toBe(false);
  });

  it('refuses a motivation-less annotation exactly as the serializing stores do', () => {
    const motivationless = {
      id: annotationId('ann-mem-2'),
      target: { source: resourceId('res-1') },
      creator: CREATOR,
    } as unknown as Annotation;
    expect(() => new MemoryGraphDatabase({ resources: [], annotations: [motivationless] })).toThrow(
      /missing required field: motivation/,
    );
  });
});

/**
 * `intendedGraphAnnotation` is what a caller asks when it wants to know whether
 * a graph is correct. It answers "what should the graph hold for this
 * annotation?" — deliberately NOT "what does the view hold?", because the graph
 * is a purpose-built projection rather than a copy of the views.
 *
 * The Weaver's conformance suite holds the graph a Weaver built to it, so
 * these are the properties that check depends on, pinned where the function
 * lives.
 */
describe('intendedGraphAnnotation — what the graph is supposed to hold', () => {
  const full: Annotation = {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id: annotationId('ann-intent'),
    motivation: 'highlighting',
    target: { source: resourceId('res-1'), selector: QUOTE_SELECTOR as never },
    creator: CREATOR,
    created: CREATED,
  };

  it('drops a field the encoder does not write, rather than reporting it as missing', () => {
    // `wasAttributedTo` is on nearly every annotation in a real log and the
    // encoder writes none of it. A comparison that expected it in the graph
    // would flag the whole corpus, which is why this scopes itself instead.
    const intended = intendedGraphAnnotation({
      ...full,
      wasAttributedTo: [{ '@type': 'Person', id: 'did:web:example.org:users:u1', name: 'Ada' }],
    } as Annotation);

    expect('wasAttributedTo' in intended).toBe(false);
  });

  it('keeps every field the encoder does write', () => {
    const intended = intendedGraphAnnotation(full);

    expect(intended.id).toBe(full.id);
    expect(intended.motivation).toBe('highlighting');
    expect(intended.created).toBe(CREATED);
    expect(intended.target).toEqual({ source: 'res-1', selector: QUOTE_SELECTOR });
    expect(intended.creator).toEqual(CREATOR);
  });

  it('is idempotent — the answer is itself a fixed point', () => {
    // Without this a comparison against it could never settle: a graph holding
    // exactly the intended content would re-derive to something else again.
    const once = intendedGraphAnnotation(full);
    expect(intendedGraphAnnotation(once)).toEqual(once);
  });

  it('carries entity tags through as tagging body items, the way the store rebuilds them', () => {
    const tagged = intendedGraphAnnotation({
      ...full,
      motivation: 'tagging',
      body: [{ type: 'TextualBody', value: 'Person', purpose: 'tagging' }],
    } as Annotation);

    expect(tagged.body).toEqual([{ type: 'TextualBody', value: 'Person', purpose: 'tagging' }]);
  });

  it('states one order for entity tags, so two answers that differ only in order are the same answer', () => {
    // Tags are edges. A store answers them as a collection with no promised
    // order (`collect()` in Cypher), and a check that compares the graph with
    // what it should hold would call a reordering a divergence.
    const tag = (value: string) => ({ type: 'TextualBody' as const, value, purpose: 'tagging' as const });
    const asWritten = intendedGraphAnnotation({ ...full, body: [tag('Place'), tag('Person')] });
    const otherwise = intendedGraphAnnotation({ ...full, body: [tag('Person'), tag('Place')] });

    expect(asWritten).toEqual(otherwise);

    const props = encodeAnnotation(asWritten);
    for (const store of STORES) {
      expect(store.decode(props, ['Place', 'Person']), store.name).toEqual(store.decode(props, ['Person', 'Place']));
      expect(store.decode(props, ['Place', 'Person']), store.name).toEqual(asWritten);
    }
  });
});
