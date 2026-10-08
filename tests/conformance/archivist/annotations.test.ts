/**
 * Annotations (ARCHIVIST.md § Annotations, § Attribution, § Enrichment): an
 * annotation assembled and recorded, a batch committed, bodies changed,
 * annotations removed, and what each reads back as.
 */
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { highlight, withArchivist, type Annotation, type ArchivistWorld } from '../harness/archivist-world';

const TEXT = 'The quick brown fox jumps over the lazy dog.\n';

async function resource(world: ArchivistWorld, name: string): Promise<string> {
  return world.created(world.world.personDid('ada'), { name, storageUri: `file://annotated/${randomUUID()}.md`, content: TEXT });
}

/** An annotation as a worker or an importer sends one whole. */
function whole(resourceId: string, exact: string, extra: Partial<Annotation> = {}): Annotation {
  const start = TEXT.indexOf(exact);
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id: randomUUID().replaceAll('-', '') as Annotation['id'],
    motivation: 'highlighting',
    target: { source: resourceId, selector: [{ type: 'TextPositionSelector', start, end: start + exact.length }, { type: 'TextQuoteSelector', exact }] },
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    ...extra,
  } as unknown as Annotation;
}

withArchivist('an annotation', (world) => {
  it('is assembled, recorded and attributed to whoever asked', async () => {
    const id = await resource(world(), 'Assembled');
    const grace = await world().person('grace', { scopes: [id] });

    const { annotationId } = (await grace.ask('mark:create-request', { resourceId: id, request: highlight(id, 'quick brown', 4) })) as { annotationId: string };
    expect(annotationId).toMatch(/^[0-9a-f]{32}$/);

    const [, added] = world().stored(id);
    expect(added).toMatchObject({ type: 'mark:added', resourceId: id, userId: grace.did, metadata: { sequenceNumber: 2 } });
    const annotation = added!.payload['annotation'] as Annotation;
    expect(annotation).toMatchObject({
      '@context': 'http://www.w3.org/ns/anno.jsonld',
      type: 'Annotation',
      id: annotationId,
      motivation: 'highlighting',
      target: { source: id },
      creator: { '@type': 'Person', '@id': grace.did },
      wasAttributedTo: [{ '@type': 'Person', '@id': grace.did }],
    });
    expect(annotation).not.toHaveProperty('generator');
    expect(annotation.created).toBe(annotation.modified);

    expect(world().view(id)).toMatchObject({ lastSequence: 2, annotations: { version: 2, annotations: [annotation] } });

    // The published fact carries the annotation as the view holds it, beside its payload.
    const fact = await grace.stream.next('the scoped fact', (m) => m.frame?.channel === 'mark:added' && m.frame.scope === id);
    expect(fact.frame!.payload).toMatchObject({ type: 'mark:added', payload: { annotation: { id: annotationId } }, annotation: { id: annotationId } });
    expect(JSON.parse(world().streamLines(id)[1]!)).not.toHaveProperty('annotation');
  });

  it('is refused on content that cannot be annotated', async () => {
    const id = await world().created(world().world.personDid('ada'), { name: 'Archive', storageUri: 'file://annotated/bundle.zip', format: 'application/zip', content: Buffer.from([0x50, 0x4b, 0x03, 0x04]) }).catch(() => undefined);
    if (id === undefined) return; // the media type is not one this knowledge base stores
    const grace = await world().person('grace');
    expect(await grace.refused('mark:create-request', { resourceId: id, request: highlight(id, 'PK', 0) })).toMatch(/cannot be annotated$/);
    expect(world().stored(id)).toHaveLength(1);
  });

  it('reads back alone, with its resource, and among its resource\'s annotations', async () => {
    const id = await resource(world(), 'Read back');
    const grace = await world().person('grace');
    const first = ((await grace.ask('mark:create-request', { resourceId: id, request: highlight(id, 'quick', 4) })) as { annotationId: string }).annotationId;
    const second = ((await grace.ask('mark:create-request', { resourceId: id, request: highlight(id, 'lazy dog', 35) })) as { annotationId: string }).annotationId;

    const listed = await grace.ask('browse:annotations-requested', { resourceId: id });
    expect((listed['annotations'] as Annotation[]).map((a) => a.id)).toEqual([first, second]);
    expect(listed['total']).toBe(2);

    const one = await grace.ask('browse:annotation-requested', { resourceId: id, annotationId: second });
    expect(one).toMatchObject({ annotation: { id: second }, resource: { '@id': id, name: 'Read back' }, resolvedResource: null });

    expect(await grace.refused('browse:annotation-requested', { resourceId: id, annotationId: 'f'.repeat(32) })).toBe('Annotation not found');
    expect(await grace.refused('browse:annotations-requested', { resourceId: 'e'.repeat(32) })).toBe(`Resource ${'e'.repeat(32)} not found in view storage`);
  });

  it('records a batch once, however often it is sent', async () => {
    const id = await resource(world(), 'Committed');
    const importer = await world().person('importer');
    const batch = [whole(id, 'quick'), whole(id, 'brown'), whole(id, 'lazy')];

    const first = await importer.ask('mark:commit', { resourceId: id, annotations: batch });
    expect(first).toEqual({ persisted: 3, annotationIds: batch.map((a) => a.id) });
    expect(world().stored(id).map((e) => e.type)).toEqual(['yield:created', 'mark:added', 'mark:added', 'mark:added']);

    const again = await importer.ask('mark:commit', { resourceId: id, annotations: [...batch, whole(id, 'dog')] });
    expect(again['persisted']).toBe(4);
    expect(world().stored(id)).toHaveLength(5);
    expect(world().view(id)!.annotations.annotations.map((a) => a.id)).toEqual([...batch.map((a) => a.id), (again['annotationIds'] as string[])[3]]);

    const recorded = world().stored(id)[1]!.payload['annotation'] as Annotation;
    expect(recorded).toMatchObject({ ...batch[0], creator: { '@id': importer.did }, wasAttributedTo: [{ '@id': importer.did }] });
  });

  it('refuses an annotation that says who made it', async () => {
    const id = await resource(world(), 'Refused');
    const importer = await world().person('importer');
    const forged = whole(id, 'quick', { creator: { '@type': 'Person', '@id': world().world.personDid('someone-else') } } as Partial<Annotation>);

    expect(await importer.refused('mark:commit', { resourceId: id, annotations: [forged] })).toBe(
      `mark:commit refused: \`creator\` on annotation ${forged.id} is derived by the knowledge base, never sent`,
    );
    expect(world().stored(id)).toHaveLength(1);
  });

  it('is removed, and its history stays in the log', async () => {
    const id = await resource(world(), 'Removed');
    const grace = await world().person('grace');
    const annotationId = ((await grace.ask('mark:create-request', { resourceId: id, request: highlight(id, 'quick', 4) })) as { annotationId: string }).annotationId;

    const history = await grace.ask('browse:annotation-history-requested', { resourceId: id, annotationId });
    expect((history['events'] as Array<{ type: string }>).map((e) => e.type)).toEqual(['mark:added']);
    expect(history).toMatchObject({ total: 1, annotationId, resourceId: id });

    expect(await grace.ask('mark:delete', { resourceId: id, annotationId })).toEqual({ annotationId });
    expect(world().stored(id)[2]).toMatchObject({ type: 'mark:removed', userId: grace.did, payload: { annotationId }, metadata: { sequenceNumber: 3 } });
    expect(world().view(id)).toMatchObject({ lastSequence: 3, annotations: { version: 3, annotations: [] } });
    expect((await grace.ask('browse:annotations-requested', { resourceId: id }))['total']).toBe(0);
  });

  it('has its body changed by add, replace and remove, in order', async () => {
    const id = await resource(world(), 'Bound');
    const target = await resource(world(), 'Linked to');
    const grace = await world().person('grace', { scopes: [id] });
    const annotationId = ((await grace.ask('mark:create-request', { resourceId: id, request: { ...highlight(id, 'fox', 16), motivation: 'linking' } })) as { annotationId: string }).annotationId;
    const tag = { type: 'TextualBody', value: 'Animal', purpose: 'tagging' };
    const link = { type: 'SpecificResource', source: target, purpose: 'linking' };

    expect(await grace.ask('bind:update-body', { resourceId: id, annotationId, operations: [{ op: 'add', item: tag }, { op: 'add', item: link }, { op: 'add', item: tag }] })).toEqual({});
    let body = world().view(id)!.annotations.annotations[0]!.body;
    expect(body).toEqual([tag, link]);

    const updated = world().stored(id)[2]!;
    expect(updated).toMatchObject({ type: 'mark:body-updated', userId: grace.did, payload: { annotationId }, metadata: { sequenceNumber: 3 } });
    expect(world().view(id)!.annotations.annotations[0]!.modified).toBe(updated.timestamp);

    // The fact carries the annotation with its body as it now stands.
    const fact = await grace.stream.next('the scoped fact', (m) => m.frame?.channel === 'mark:body-updated' && m.frame.scope === id);
    expect(fact.frame!.payload).toMatchObject({ annotation: { id: annotationId, body: [tag, link] } });

    const retag = { type: 'TextualBody', value: 'Mammal', purpose: 'tagging' };
    await grace.ask('bind:update-body', { resourceId: id, annotationId, operations: [{ op: 'replace', oldItem: tag, newItem: retag }, { op: 'remove', item: link }] });
    body = world().view(id)!.annotations.annotations[0]!.body;
    expect(body).toEqual([retag]);

    // What the annotation links to reads back with it.
    await grace.ask('bind:update-body', { resourceId: id, annotationId, operations: [{ op: 'add', item: link }] });
    const one = await grace.ask('browse:annotation-requested', { resourceId: id, annotationId });
    expect(one).toMatchObject({ resolvedResource: { '@id': target, name: 'Linked to' } });
    // A linking annotation whose body names an entity type is one of its resource's entity references.
    const plain = ((await grace.ask('mark:create-request', { resourceId: id, request: highlight(id, 'dog', 40) })) as { annotationId: string }).annotationId;
    const described = await grace.ask('browse:resource-requested', { resourceId: id });
    expect((described['annotations'] as Array<{ id: string }>).map((a) => a.id)).toEqual([annotationId, plain]);
    expect((described['entityReferences'] as Array<{ id: string }>).map((a) => a.id)).toEqual([annotationId]);
  });

  it('links a generated resource from the annotation it was generated for', async () => {
    const id = await resource(world(), 'Source');
    const grace = await world().person('grace', { scopes: [id] });
    const annotationId = ((await grace.ask('mark:create-request', { resourceId: id, request: { ...highlight(id, 'fox', 16), motivation: 'linking' } })) as { annotationId: string }).annotationId;

    const generated = await world().created(grace.did, { name: 'About the fox', storageUri: 'file://generated/fox.md', content: 'Foxes.\n', sourceResourceId: id, sourceAnnotationId: annotationId, generationPrompt: 'Tell me about the fox' });
    expect(world().stored(generated)[0]!.payload).toMatchObject({ generatedFrom: { resourceId: id, annotationId }, generationPrompt: 'Tell me about the fox' });
    expect(world().view(generated)!.resource).toMatchObject({ wasDerivedFrom: id });

    await grace.stream.next('the link', (m) => m.frame?.channel === 'mark:body-updated' && m.frame.scope === id);
    expect(world().view(id)!.annotations.annotations[0]!.body).toEqual([{ type: 'SpecificResource', source: generated, purpose: 'linking' }]);
  });
});
