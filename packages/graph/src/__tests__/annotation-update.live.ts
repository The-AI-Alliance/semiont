/**
 * An annotation's body, updated, against a real neo4j.
 *
 * The Weaver folds `mark:body-updated` by reading the annotation, changing its
 * body and calling `updateAnnotation(id, { body })`. What the graph then holds
 * is what the Librarian reads: a link is followed by its `REFERENCES` edge and
 * read back from `source`; a tag is a `TAGGED_AS` edge.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnnotationId, ResourceId } from '@semiont/core';
import { AUTHORED, CREATOR, openLiveNeo4j, type LiveNeo4j } from './helpers/live-neo4j';

describe('neo4j: an annotation body, updated', () => {
  let live: LiveNeo4j;
  let on: ResourceId;
  let target: ResourceId;
  let id: AnnotationId;
  let person: string;

  const link = () => [{ type: 'SpecificResource' as const, source: target, purpose: 'linking' as const }];
  const tag = () => [{ type: 'TextualBody' as const, value: person, purpose: 'tagging' as const }];

  const edges = async () => {
    const [row] = await live.rows(
      `MATCH (a:Annotation {id: $id})
       OPTIONAL MATCH (a)-[:REFERENCES]->(to:Resource)
       OPTIONAL MATCH (a)-[:TAGGED_AS]->(et:EntityType)
       RETURN collect(DISTINCT to.id) AS references, collect(DISTINCT et.name) AS tags, keys(a) AS keys`,
      { id },
    );
    return row as { references: string[]; tags: string[]; keys: string[] };
  };

  beforeAll(async () => {
    live = await openLiveNeo4j('update');
    on = live.resource('on');
    target = live.resource('target');
    id = live.annotation('a');
    person = live.tag('Person');
    await live.db.createResource(live.descriptor(on));
    await live.db.createResource(live.descriptor(target));
    await live.db.createAnnotation({
      id,
      motivation: 'linking',
      target: { source: on, selector: { type: 'TextQuoteSelector', exact: 'hello' } },
      creator: CREATOR,
      created: AUTHORED,
    });
  });

  afterAll(async () => {
    await live.close();
  });

  it('reads a link back once the body is updated with one', async () => {
    await live.db.updateAnnotation(id, { body: link() });

    expect((await live.db.getAnnotation(id))?.body).toEqual(link());
    expect((await live.db.getResourceAnnotations(on)).find((a) => a.id === id)?.body).toEqual(link());
    expect((await edges()).references).toEqual([target]);
    expect((await live.db.getResourceReferencedBy(target)).map((a) => a.id)).toEqual([id]);
  });

  it('reads a tag back, as an edge, once the body is updated with one', async () => {
    await live.db.updateAnnotation(id, { body: [...tag(), ...link()] });

    expect((await live.db.getAnnotation(id))?.body).toEqual([...tag(), ...link()]);
    expect((await edges()).tags).toEqual([person]);
  });

  it('no longer follows a link, or keeps a tag, the body has lost', async () => {
    await live.db.updateAnnotation(id, { body: [] });

    expect((await live.db.getAnnotation(id))?.body).toBeUndefined();
    expect(await edges()).toMatchObject({ references: [], tags: [] });
    expect(await live.db.getResourceReferencedBy(target)).toEqual([]);
  });

  it('stores nothing the codec does not write: no body property, no clock of its own', async () => {
    await live.db.updateAnnotation(id, { body: link() });

    const { keys } = await edges();
    expect(keys).not.toContain('body');
    expect(keys).not.toContain('updatedAt');
  });

  it('keeps the authored moment through an update, and takes the moment of the change it is given', async () => {
    const changed = '2021-06-07T08:09:10.000Z';
    await live.db.updateAnnotation(id, { body: link(), modified: changed });

    expect(await live.db.getAnnotation(id)).toMatchObject({ created: AUTHORED, modified: changed });
  });

  it('resolves a reference as an update: the link replaced, the tags kept, nothing stamped', async () => {
    const other = live.resource('other');
    await live.db.createResource(live.descriptor(other));
    await live.db.updateAnnotation(id, { body: [...tag(), ...link()] });

    const resolved = await live.db.resolveReference(id, other);

    const relinked = [...tag(), { type: 'SpecificResource', source: other, purpose: 'linking' }];
    expect(resolved.body).toEqual(relinked);
    expect((await live.db.getAnnotation(id))?.body).toEqual(relinked);
    const { references, tags, keys } = await edges();
    expect(references).toEqual([other]);
    expect(tags).toEqual([person]);
    expect(keys).not.toContain('resolvedAt');
    expect(keys).not.toContain('resolvedResourceName');
  });

  it('links to a resource the graph has not seen yet, and the resource fills the stub in when it arrives', async () => {
    const late = live.resource('late');

    await live.db.updateAnnotation(id, { body: [{ type: 'SpecificResource', source: late, purpose: 'linking' }] });
    expect((await edges()).references).toEqual([late]);
    expect(await live.db.listResources({ search: String(late) })).toMatchObject({ total: 0 });

    await live.db.createResource(live.descriptor(late));
    expect((await live.db.getResourceReferencedBy(late)).map((a) => a.id)).toEqual([id]);
    expect((await live.db.getResource(late))?.name).toBe(String(late));
  });
});
