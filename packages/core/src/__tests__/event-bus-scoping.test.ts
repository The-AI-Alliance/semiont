/**
 * EventBus Scoping Tests
 *
 * Tests resource-scoped event isolation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../event-bus';

describe('EventBus scoping', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
  });

  it('scopes events by resource', () => {
    const resource1 = eventBus.scope('resource-1');
    const resource2 = eventBus.scope('resource-2');

    const events1: any[] = [];
    const events2: any[] = [];

    resource1.get('annotate:progress').subscribe(e => events1.push(e));
    resource2.get('annotate:progress').subscribe(e => events2.push(e));

    resource1.get('annotate:progress').next({ status: 'started' });
    resource2.get('annotate:progress').next({ status: 'complete' });

    expect(events1).toHaveLength(1);
    expect(events1[0].status).toBe('started');

    expect(events2).toHaveLength(1);
    expect(events2[0].status).toBe('complete');
  });

  it('isolates events between different scopes', () => {
    const resource1 = eventBus.scope('resource-1');
    const resource2 = eventBus.scope('resource-2');

    const events1: any[] = [];
    const events2: any[] = [];

    resource1.get('annotate:created').subscribe(e => events1.push(e));
    resource2.get('annotate:created').subscribe(e => events2.push(e));

    // Emit to resource1 only
    const mockAnnotation = {
      '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
      type: 'Annotation' as const,
      id: 'http://localhost:4000/annotations/ann-1',
      motivation: 'commenting' as const,
      target: 'http://localhost:4000/resources/resource-1',
      body: []
    };
    resource1.get('annotate:created').next({ annotation: mockAnnotation });

    expect(events1).toHaveLength(1);
    expect(events1[0].annotation.id).toBe('http://localhost:4000/annotations/ann-1');

    expect(events2).toHaveLength(0); // Resource2 should not receive event
  });

  it('allows nested scoping', () => {
    const resourceScope = eventBus.scope('resource-1');
    const subsystemScope = resourceScope.scope('subsystem-a');

    const resourceEvents: any[] = [];
    const subsystemEvents: any[] = [];

    resourceScope.get('annotate:progress').subscribe(e => resourceEvents.push(e));
    subsystemScope.get('annotate:progress').subscribe(e => subsystemEvents.push(e));

    // Events to different scopes are isolated
    resourceScope.get('annotate:progress').next({ status: 'started', message: 'resource level' });
    subsystemScope.get('annotate:progress').next({ status: 'started', message: 'subsystem level' });

    expect(resourceEvents).toHaveLength(1);
    expect(resourceEvents[0].message).toBe('resource level');

    expect(subsystemEvents).toHaveLength(1);
    expect(subsystemEvents[0].message).toBe('subsystem level');
  });

  it('shares same parent EventBus subjects map', () => {
    const resource1 = eventBus.scope('resource-1');
    const resource2 = eventBus.scope('resource-2');

    // Both scopes use the same underlying EventBus
    expect((resource1 as any).parent).toBe((resource2 as any).parent);
    expect((resource1 as any).parent).toBe(eventBus);
  });

  it('maintains type safety across scopes', () => {
    const resourceScope = eventBus.scope('resource-1');

    // Type should be preserved
    const subject = resourceScope.get('annotate:progress');

    const events: any[] = [];
    // Subscribe first
    subject.subscribe(e => {
      // e should have the correct type
      expect(e.status).toBeDefined();
      events.push(e);
    });

    // Then emit - this should compile without errors
    subject.next({ status: 'started', message: 'Beginning detection' });

    expect(events).toHaveLength(1);
  });
});
