import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../event-bus';

/**
 * EventBus scope semantics tests. Uses a small set of representative
 * channels as examples — the scoping behavior is not specific to any
 * particular channel, so these tests pick ones with simple payloads.
 */
describe('EventBus scoping', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
  });

  it('creates isolated scopes with separate subject instances', () => {
    const resource1 = eventBus.scope('resource-1');
    const resource2 = eventBus.scope('resource-2');

    const events1: unknown[] = [];
    const events2: unknown[] = [];

    resource1.on('mark:create-ok').subscribe(e => events1.push(e));
    resource2.on('mark:create-ok').subscribe(e => events2.push(e));

    resource1.emit('mark:create-ok', { response: { annotationId:'ann-1' as never } });
    resource2.emit('mark:create-ok', { response: { annotationId:'ann-2' as never } });

    expect(events1).toHaveLength(1);
    expect((events1[0] as { response: { annotationId: string } }).response.annotationId).toBe('ann-1');

    expect(events2).toHaveLength(1);
    expect((events2[0] as { response: { annotationId: string } }).response.annotationId).toBe('ann-2');
  });

  it('isolates events between different scopes', () => {
    const resource1 = eventBus.scope('resource-1');
    const resource2 = eventBus.scope('resource-2');

    const events1: unknown[] = [];
    const events2: unknown[] = [];

    resource1.on('mark:create-ok').subscribe(e => events1.push(e));
    resource2.on('mark:create-ok').subscribe(e => events2.push(e));

    // Emit to resource1 only
    resource1.emit('mark:create-ok', { response: { annotationId:'ann-1' as never } });

    expect(events1).toHaveLength(1);
    expect((events1[0] as { response: { annotationId: string } }).response.annotationId).toBe('ann-1');

    expect(events2).toHaveLength(0); // Resource2 should not receive event
  });

  it('allows nested scoping', () => {
    const resourceScope = eventBus.scope('resource-1');
    const subsystemScope = resourceScope.scope('subsystem-a');

    const resourceEvents: unknown[] = [];
    const subsystemEvents: unknown[] = [];

    resourceScope.on('mark:create-ok').subscribe(e => resourceEvents.push(e));
    subsystemScope.on('mark:create-ok').subscribe(e => subsystemEvents.push(e));

    // Events to different scopes are isolated
    resourceScope.emit('mark:create-ok', { response: { annotationId:'res-level' as never } });
    subsystemScope.emit('mark:create-ok', { response: { annotationId:'subsystem-level' as never } });

    expect(resourceEvents).toHaveLength(1);
    expect((resourceEvents[0] as { response: { annotationId: string } }).response.annotationId).toBe('res-level');

    expect(subsystemEvents).toHaveLength(1);
    expect((subsystemEvents[0] as { response: { annotationId: string } }).response.annotationId).toBe('subsystem-level');
  });

  it('shares same parent EventBus subjects map', () => {
    const resource1 = eventBus.scope('resource-1');
    const resource2 = eventBus.scope('resource-2');

    // Both scopes use the same underlying EventBus
    expect((resource1 as unknown as { parent: unknown }).parent).toBe((resource2 as unknown as { parent: unknown }).parent);
    expect((resource1 as unknown as { parent: unknown }).parent).toBe(eventBus);
  });

  it('maintains type safety across scopes', () => {
    const resourceScope = eventBus.scope('resource-1');

    // One name for reading and writing was the old shape: `get()` handed back
    // a Subject, so a holder could do both and nothing said which it meant.
    // The verbs separate them, and the payload stays typed either way — which
    // is what this test is actually about.
    const events: unknown[] = [];
    resourceScope.on('mark:create-ok').subscribe(e => {
      expect(e.response.annotationId).toBeDefined();
      events.push(e);
    });

    resourceScope.emit('mark:create-ok', { response: { annotationId:'ann-1' as never } });

    expect(events).toHaveLength(1);
  });
});
