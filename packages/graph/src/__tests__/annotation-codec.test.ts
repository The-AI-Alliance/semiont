/**
 * The cross-store annotation codec conformance suite.
 *
 * One case table, every store's codec path, identical output required. The
 * three serializing stores used to carry near-verbatim copies of this codec
 * that disagreed in four places — a missing selector threw in neo4j, became
 * `{}` in janusgraph and neptune; a missing motivation threw in neo4j and
 * silently became `'linking'` in the other two. One event log, three
 * different annotations. See .plans/GRAPH-ANNOTATION-CODEC.md.
 *
 * The codec is pure, so every case here runs with no live store.
 */
import { describe, it, expect } from 'vitest';
import { annotationId, resourceId } from '@semiont/core';
import type { Annotation, CreateAnnotationInternal } from '@semiont/core';
import { buildAnnotation, encodeAnnotation, type AnnotationProperties } from '../annotation-codec';
import { parseAnnotationNode } from '../implementations/neo4j';
import { vertexToAnnotation as neptuneVertexToAnnotation } from '../implementations/neptune';
import { vertexToAnnotation as janusVertexToAnnotation } from '../implementations/janusgraph';
import { MemoryGraphDatabase } from '../implementations/memorygraph';

const CREATOR = { '@type': 'Person' as const, id: 'did:semiont:user:u1', name: 'Ada' };
const CREATED = '2026-08-21T10:00:00.000Z';

/**
 * Each store hands the codec a flat property bag, but shapes its own on the
 * way in (D3). These adapters are those shapes: the same properties as the
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

  it("D6: a legacy row whose stored selector is '{}' decodes clean — no migration needed", () => {
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
    expect(ann.body).toEqual([
      { type: 'TextualBody', value: 'Person', purpose: 'tagging' },
      { type: 'TextualBody', value: 'Org', purpose: 'tagging' },
      { type: 'SpecificResource', source: 'res-2', purpose: 'linking' },
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

describe('encode — absence is stored as absence (D4)', () => {
  const sourceOnly = buildAnnotation(
    {
      id: annotationId('ann-1'),
      motivation: 'linking',
      target: { source: 'res-1' },
      body: [{ type: 'SpecificResource', source: 'res-2', purpose: 'linking' }],
      creator: CREATOR,
    } as CreateAnnotationInternal,
    CREATED
  );

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
    const highlight = buildAnnotation(
      {
        id: annotationId('ann-2'),
        motivation: 'highlighting',
        target: { source: 'res-1', selector: QUOTE_SELECTOR },
        creator: CREATOR,
      } as CreateAnnotationInternal,
      CREATED
    );
    const props = encodeAnnotation(highlight);
    expect(props.selector).toBe(JSON.stringify(QUOTE_SELECTOR));
    for (const store of STORES) expect(store.decode(props)).toEqual(highlight);
  });

  it('discriminates highlights from references in the stored type, so the category filter can match', () => {
    const highlight = buildAnnotation(
      {
        id: annotationId('ann-3'),
        motivation: 'highlighting',
        target: { source: 'res-1', selector: QUOTE_SELECTOR },
        creator: CREATOR,
      } as CreateAnnotationInternal,
      CREATED
    );
    expect(encodeAnnotation(highlight).type).toBe('TextualBody');
    expect(encodeAnnotation(sourceOnly).type).toBe('SpecificResource');
  });
});

describe('D7: memorygraph is a faithful reference, not a store where the bug is impossible', () => {
  it('round-trips a source-only annotation through the codec, selector-free', async () => {
    const graph = new MemoryGraphDatabase();
    await graph.connect();
    const created = await graph.createAnnotation({
      id: annotationId('ann-mem-1'),
      motivation: 'linking',
      target: { source: 'res-1' },
      body: [{ type: 'SpecificResource', source: 'res-2', purpose: 'linking' }],
      creator: CREATOR,
    } as CreateAnnotationInternal);

    expect('selector' in (created.target as object)).toBe(false);

    const fetched = await graph.getAnnotation(annotationId('ann-mem-1'));
    expect(fetched).toEqual(created);
    expect('selector' in (fetched!.target as object)).toBe(false);
  });

  it('rejects a motivation-less annotation exactly as the serializing stores do', async () => {
    const graph = new MemoryGraphDatabase();
    await graph.connect();
    await expect(
      graph.createAnnotation({
        id: annotationId('ann-mem-2'),
        target: { source: resourceId('res-1') },
        creator: CREATOR,
      } as unknown as CreateAnnotationInternal)
    ).rejects.toThrow(/missing required field: motivation/);
  });
});
