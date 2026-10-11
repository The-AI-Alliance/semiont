/**
 * The graph a Weaver builds from the record (WEAVER.md § The fold, § Reconcile):
 * what each resource and annotation is in it, read back as a reader of the
 * graph reads it, and whether the Weaver's own check of the graph against the
 * record finds anything to repair in a graph it has just built.
 *
 * Nothing here states a view: the record is the real Archivist's, and the
 * graph is held to what that Archivist's view holds.
 */
import { annotationId, resourceId } from '@semiont/core';
import { intendedGraphAnnotation } from '@semiont/graph';
import { expect, it } from 'vitest';
import { eachWeaver } from '../harness/weaver-world';
import { delegated, highlighted, link, referenced, tag, uploaded, whole } from './support';

const byId = <T extends { id: string }>(annotations: T[]) => [...annotations].sort((a, b) => a.id.localeCompare(b.id));

eachWeaver('the graph a Weaver builds', (world) => {
  it('says what the record says, and is one its own reconcile finds nothing wrong with', async () => {
    const kb = world().kb;
    const linkedTo = await uploaded(world(), 'Linked to');
    const id = await uploaded(world(), 'Annotated');
    const grace = await kb.person('grace');
    const worker = await kb.worker('model');

    // A person's highlight; a reference she then binds to another resource and tags;
    // and work she asked a worker for, which the worker sends and the record says she asked for.
    const marked = await highlighted(grace, id, 'quick brown');
    const reference = await referenced(grace, id, 'fox');
    await grace.ask('bind:update-body', { resourceId: id, annotationId: reference, operations: [{ op: 'add', item: tag('Animal') }, { op: 'add', item: link(linkedTo) }] });
    const worked = whole(id, 'lazy dog');
    await delegated(world(), grace, worker, id, worked);

    await world().caughtUp(id, linkedTo);

    // Every annotation in the graph is what the graph is to hold of the one the record's view holds.
    const view = kb.view(id)!;
    const inGraph = await world().graph.getResourceAnnotations(resourceId(id));
    expect(view.annotations.annotations.map((a) => a.id).sort()).toEqual([marked, reference, worked.id].sort());
    expect(byId(inGraph)).toEqual(byId(view.annotations.annotations.map(intendedGraphAnnotation)));

    // By the one who asked, not the one who sent it; with the software that made it.
    const delegatedInGraph = await world().graph.getAnnotation(annotationId(worked.id));
    expect(delegatedInGraph?.creator).toMatchObject({ '@type': 'Person', '@id': grace.did });
    expect(delegatedInGraph?.generator).toMatchObject({ '@type': 'Software', '@id': worker.did });
    expect(world().recorded(id, 'mark:added').find((event) => (event.payload['annotation'] as { id: string }).id === worked.id)?.userId).toBe(worker.did);

    // A link and a tag added after the annotation was made are read back, dated when the record says the body changed.
    const bound = await world().graph.getAnnotation(annotationId(reference));
    expect(bound?.body).toEqual([tag('Animal'), link(linkedTo)]);
    expect(bound?.modified).toBe(world().recorded(id, 'mark:body-updated')[0]!.timestamp);
    expect((await world().graph.getResourceReferencedBy(resourceId(linkedTo))).map((a) => a.id)).toEqual([reference]);

    // The link is a connection of the resource it is on, to the resource it is to; and a resource is found by its name.
    const connections = await world().graph.getResourceConnections(resourceId(id));
    expect(connections.map((connection) => connection.targetResource['@id'])).toEqual([linkedTo]);
    expect(connections[0]!.annotations.map((a) => a.id)).toEqual([reference]);
    const named = await world().graph.listResources({ search: 'Linked to' });
    expect(named.resources.map((resource) => resource['@id'])).toContain(linkedTo);

    // The resource is dated and attributed as its event records.
    const created = world().recorded(id, 'yield:created')[0]!;
    expect(await world().graph.getResource(resourceId(id))).toMatchObject({
      name: 'Annotated',
      archived: false,
      dateCreated: created.timestamp,
      wasAttributedTo: created.payload['wasAttributedTo'],
    });

    // Reconcile runs when a Weaver starts. In a graph this Weaver built, it finds nothing to repair.
    await world().restart();
    const health = await world().weaver.health();
    expect(health.catchUp).toMatchObject({ phase: 'done', summary: { eventsFailed: 0 } });
    expect(health.reconcile).toMatchObject({ phase: 'done', summary: { divergent: 0, healed: 0, healFailures: 0, orphaned: 0 } });
    expect(health.applyFailures).toBe(0);
  });

  it('follows a resource through archiving, its entity types and an annotation\'s removal', async () => {
    const kb = world().kb;
    const id = await uploaded(world(), 'Followed');
    const grace = await kb.person('grace');
    const kept = await highlighted(grace, id, 'quick');
    const removed = await highlighted(grace, id, 'lazy dog');

    await grace.ask('mark:delete', { resourceId: id, annotationId: removed });
    // An entity type joins the knowledge base's list before a resource is given it: the Archivist refuses one that has not.
    await grace.ask('frame:add-entity-type', { tag: 'Fable' });
    await grace.ask('frame:add-entity-type', { tag: 'Pangram' });
    await grace.ask('mark:update-entity-types', { resourceId: id, currentEntityTypes: [], updatedEntityTypes: ['Fable', 'Pangram'] });
    await grace.ask('mark:update-entity-types', { resourceId: id, currentEntityTypes: ['Fable', 'Pangram'], updatedEntityTypes: ['Pangram'] });
    await grace.ask('mark:archive', { resourceId: id });
    await world().caughtUp(id);

    expect((await world().graph.getResourceAnnotations(resourceId(id))).map((a) => a.id)).toEqual([kept]);
    expect(await world().graph.getResource(resourceId(id))).toMatchObject({ archived: true, entityTypes: ['Pangram'] });
    expect(await world().graph.getEntityTypeStats()).toContainEqual({ type: 'Pangram', count: 1 });

    await grace.ask('mark:unarchive', { resourceId: id });
    await world().caughtUp(id);
    expect((await world().graph.getResource(resourceId(id)))?.archived).toBe(false);
  });

  it('says how far it has applied each resource, in order, and never past what the record holds', async () => {
    const kb = world().kb;
    const id = await uploaded(world(), 'Signalled');
    const grace = await kb.person('grace');
    await highlighted(grace, id, 'quick');
    await highlighted(grace, id, 'brown');
    await highlighted(grace, id, 'fox');
    await world().caughtUp(id);

    const signalled = world().appliedSignals(id).map((signal) => signal.sequenceNumber);
    expect(signalled.at(-1)).toBe(world().lastFollowed(id));
    expect(signalled).toEqual([...signalled].sort((a, b) => a - b));
    expect(new Set(signalled).size).toBe(signalled.length);
  });
});
