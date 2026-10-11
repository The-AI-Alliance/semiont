/**
 * How a Weaver brings the graph back in line with the record (WEAVER.md §
 * Catch-up, § Reconcile, § Rebuild): what it missed while it was down, what
 * was lost from the graph behind its back, and what it is asked to rebuild.
 */
import { annotationId, resourceId } from '@semiont/core';
import { intendedGraphAnnotation } from '@semiont/graph';
import { expect, it } from 'vitest';
import { eachWeaver, type WeaverWorld } from '../harness/weaver-world';
import { highlighted, link, referenced, uploaded } from './support';

const byId = <T extends { id: string }>(annotations: T[]) => [...annotations].sort((a, b) => a.id.localeCompare(b.id));

/** Whether the graph holds, for `id`, what it is to hold of the record's view. */
async function asTheRecordSays(world: WeaverWorld, id: string): Promise<void> {
  const view = world.kb.view(id)!;
  const inGraph = await world.graph.getResourceAnnotations(resourceId(id));
  expect(byId(inGraph)).toEqual(byId(view.annotations.annotations.map(intendedGraphAnnotation)));
  expect(await world.graph.getResource(resourceId(id))).toMatchObject({ name: view.resource.name, archived: view.resource.archived ?? false });
}

eachWeaver('a Weaver, bringing the graph back', (world) => {
  it('applies what was recorded while it was down, when it starts again', async () => {
    const kb = world().kb;
    const before = await uploaded(world(), 'Before it stopped');
    await world().caughtUp(before);

    expect(await world().stop()).toBe(0);
    const during = await uploaded(world(), 'While it was down');
    const grace = await kb.person('grace');
    const marked = await highlighted(grace, during, 'quick brown');
    await highlighted(grace, before, 'fox');

    await world().start();

    const health = await world().weaver.health();
    // Its checkpoint says how far it had got: the three events recorded since are all it replays.
    expect(health.catchUp).toMatchObject({ phase: 'done', summary: { eventsReplayed: 3, eventsFailed: 0, parityPending: 0 } });
    expect(health.reconcile).toMatchObject({ phase: 'done', summary: { divergent: 0 } });
    await asTheRecordSays(world(), during);
    await asTheRecordSays(world(), before);
    expect(await world().graph.getAnnotation(annotationId(marked))).not.toBeNull();
  });

  it('with nothing kept, applies the whole record again and ends with the same graph', async () => {
    const id = await uploaded(world(), 'Replayed whole');
    const grace = await world().kb.person('grace');
    await highlighted(grace, id, 'lazy dog');
    await world().caughtUp(id);
    const held = byId(await world().graph.getResourceAnnotations(resourceId(id)));

    await world().replace();

    const health = await world().weaver.health();
    expect(health.catchUp).toMatchObject({ phase: 'done', summary: { eventsFailed: 0 } });
    expect(health.catchUp.summary!['eventsReplayed']).toBeGreaterThanOrEqual(2);
    expect(health.reconcile).toMatchObject({ phase: 'done', summary: { divergent: 0 } });
    expect(byId(await world().graph.getResourceAnnotations(resourceId(id)))).toEqual(held);
  });

  it('rebuilds from the record what was lost from the graph behind its back, when it next starts', async () => {
    const id = await uploaded(world(), 'Damaged');
    const grace = await world().kb.person('grace');
    const lost = await highlighted(grace, id, 'quick');
    await world().caughtUp(id);
    const made = (await world().graph.getAnnotation(annotationId(lost)))!.created;

    await world().stop();
    await world().lose(lost);
    await world().start();

    const health = await world().weaver.health();
    // Its checkpoint says the event was applied, so catch-up replays nothing: reconcile is what finds it.
    expect(health.catchUp).toMatchObject({ phase: 'done', summary: { eventsReplayed: 0 } });
    expect(health.reconcile).toMatchObject({ phase: 'done', summary: { divergent: 1, healed: 1, healFailures: 0, orphaned: 0 } });
    await asTheRecordSays(world(), id);
    // Rebuilt from the record, it is dated as the record dates it, not when it was rebuilt.
    expect((await world().graph.getAnnotation(annotationId(lost)))?.created).toBe(made);
  });

  it('rebuilds a whole graph that was cleaned, when it next starts', async () => {
    const linkedTo = await uploaded(world(), 'Cleaned, linked to');
    const id = await uploaded(world(), 'Cleaned');
    const grace = await world().kb.person('grace');
    const reference = await referenced(grace, id, 'fox');
    await grace.ask('bind:update-body', { resourceId: id, annotationId: reference, operations: [{ op: 'add', item: link(linkedTo) }] });
    await world().caughtUp(id, linkedTo);

    await world().stop();
    await world().clean();
    await world().start();

    const health = await world().weaver.health();
    expect(health.reconcile.phase).toBe('done');
    expect(health.reconcile.summary).toMatchObject({ healFailures: 0, orphaned: 0 });
    expect(health.reconcile.summary!['healed']).toBe(health.reconcile.summary!['divergent']);
    expect(health.reconcile.summary!['divergent']).toBeGreaterThanOrEqual(2);
    await asTheRecordSays(world(), id);
    await asTheRecordSays(world(), linkedTo);
    expect((await world().graph.getResourceReferencedBy(resourceId(linkedTo))).map((a) => a.id)).toEqual([reference]);
  });

  it('rebuilds one resource when asked, and leaves another resource\'s link to it alone', async () => {
    const linkedTo = await uploaded(world(), 'Rebuilt, linked to');
    const id = await uploaded(world(), 'Links to the rebuilt');
    const grace = await world().kb.person('grace');
    const reference = await referenced(grace, id, 'fox');
    await grace.ask('bind:update-body', { resourceId: id, annotationId: reference, operations: [{ op: 'add', item: link(linkedTo) }] });
    const own = await highlighted(grace, linkedTo, 'quick');
    await world().caughtUp(id, linkedTo);

    const answer = await world().rebuild(linkedTo);

    expect(answer).toMatchObject({ ok: true, channel: 'weave:rebuild-ok' });
    await asTheRecordSays(world(), linkedTo);
    await asTheRecordSays(world(), id);
    expect((await world().graph.getResourceAnnotations(resourceId(linkedTo))).map((a) => a.id)).toEqual([own]);
    expect((await world().graph.getResourceReferencedBy(resourceId(linkedTo))).map((a) => a.id)).toEqual([reference]);
  });

  it('rebuilds the whole graph when asked, and ends with what the record says', async () => {
    const id = await uploaded(world(), 'Rebuilt with all');
    const grace = await world().kb.person('grace');
    await highlighted(grace, id, 'brown');
    await world().caughtUp(id);

    const answer = await world().rebuild();

    expect(answer).toMatchObject({ ok: true, channel: 'weave:rebuild-ok' });
    await asTheRecordSays(world(), id);
  });
});
