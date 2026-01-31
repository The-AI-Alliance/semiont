import { describe, it, expect } from 'vitest';
import { isResourceEvent, isSystemEvent, isResourceScopedEvent, getEventType } from '../events';
import type { ResourceEvent, SystemEvent } from '../events';

describe('@semiont/core - events', () => {
  describe('isResourceEvent', () => {
    it('should return true for valid resource event', () => {
      const event = {
        id: 'evt-123',
        timestamp: '2024-01-01T00:00:00Z',
        resourceId: 'doc-abc',
        userId: 'did:web:example.com:users:alice',
        type: 'resource.created',
        version: 1,
        payload: {},
      };

      expect(isResourceEvent(event)).toBe(true);
    });

    it('should return true for system event without resourceId', () => {
      const event = {
        id: 'evt-123',
        timestamp: '2024-01-01T00:00:00Z',
        userId: 'did:web:example.com:users:alice',
        type: 'entitytype.added',
        version: 1,
        payload: {},
      };

      expect(isResourceEvent(event)).toBe(true);
    });

    it('should return false for event without id', () => {
      const event = {
        timestamp: '2024-01-01T00:00:00Z',
        resourceId: 'doc-abc',
        type: 'resource.created',
      };

      expect(isResourceEvent(event)).toBe(false);
    });

    it('should return false for event without timestamp', () => {
      const event = {
        id: 'evt-123',
        resourceId: 'doc-abc',
        type: 'resource.created',
      };

      expect(isResourceEvent(event)).toBe(false);
    });

    it('should return false for event without type', () => {
      const event = {
        id: 'evt-123',
        timestamp: '2024-01-01T00:00:00Z',
        resourceId: 'doc-abc',
      };

      expect(isResourceEvent(event)).toBe(false);
    });

    it('should return false for event with type without dot', () => {
      const event = {
        id: 'evt-123',
        timestamp: '2024-01-01T00:00:00Z',
        resourceId: 'doc-abc',
        type: 'invalid',
      };

      expect(isResourceEvent(event)).toBe(false);
    });

    it('should return false for null', () => {
      expect(isResourceEvent(null)).toBeFalsy();
    });

    it('should return false for undefined', () => {
      expect(isResourceEvent(undefined)).toBeFalsy();
    });

    it('should return false for non-object values', () => {
      expect(isResourceEvent('string')).toBe(false);
      expect(isResourceEvent(123)).toBe(false);
      expect(isResourceEvent(true)).toBe(false);
    });

    it('should return false for event with non-string id', () => {
      const event = {
        id: 123,
        timestamp: '2024-01-01T00:00:00Z',
        resourceId: 'doc-abc',
        type: 'resource.created',
      };

      expect(isResourceEvent(event)).toBe(false);
    });

    it('should return false for event with non-string resourceId', () => {
      const event = {
        id: 'evt-123',
        timestamp: '2024-01-01T00:00:00Z',
        resourceId: 123,
        type: 'resource.created',
      };

      expect(isResourceEvent(event)).toBe(false);
    });
  });

  describe('isSystemEvent', () => {
    it('should return true for entitytype.added event', () => {
      const event: ResourceEvent = {
        id: 'evt-123',
        timestamp: '2024-01-01T00:00:00Z',
        userId: 'did:web:example.com:users:alice',
        type: 'entitytype.added',
        version: 1,
        payload: {
          entityType: 'Person',
        },
      } as SystemEvent;

      expect(isSystemEvent(event)).toBe(true);
    });

    it('should return false for resource.created event', () => {
      const event: ResourceEvent = {
        id: 'evt-123',
        timestamp: '2024-01-01T00:00:00Z',
        resourceId: 'doc-abc',
        userId: 'did:web:example.com:users:alice',
        type: 'resource.created',
        version: 1,
        payload: {
          name: 'Test',
          format: 'text/plain',
          contentChecksum: 'abc123',
          creationMethod: 'upload',
        },
      } as any;

      expect(isSystemEvent(event)).toBe(false);
    });

    it('should return false for annotation events', () => {
      const event: ResourceEvent = {
        id: 'evt-123',
        timestamp: '2024-01-01T00:00:00Z',
        resourceId: 'doc-abc',
        userId: 'did:web:example.com:users:alice',
        type: 'annotation.created',
        version: 1,
        payload: {} as any,
      } as any;

      expect(isSystemEvent(event)).toBe(false);
    });
  });

  describe('isResourceScopedEvent', () => {
    it('should return true for resource.created event', () => {
      const event: ResourceEvent = {
        id: 'evt-123',
        timestamp: '2024-01-01T00:00:00Z',
        resourceId: 'doc-abc',
        userId: 'did:web:example.com:users:alice',
        type: 'resource.created',
        version: 1,
        payload: {
          name: 'Test',
          format: 'text/plain',
          contentChecksum: 'abc123',
          creationMethod: 'upload',
        },
      } as any;

      expect(isResourceScopedEvent(event)).toBe(true);
    });

    it('should return true for annotation events', () => {
      const event: ResourceEvent = {
        id: 'evt-123',
        timestamp: '2024-01-01T00:00:00Z',
        resourceId: 'doc-abc',
        userId: 'did:web:example.com:users:alice',
        type: 'annotation.created',
        version: 1,
        payload: {} as any,
      } as any;

      expect(isResourceScopedEvent(event)).toBe(true);
    });

    it('should return false for entitytype.added event', () => {
      const event: ResourceEvent = {
        id: 'evt-123',
        timestamp: '2024-01-01T00:00:00Z',
        userId: 'did:web:example.com:users:alice',
        type: 'entitytype.added',
        version: 1,
        payload: {
          entityType: 'Person',
        },
      } as SystemEvent;

      expect(isResourceScopedEvent(event)).toBe(false);
    });

    it('should return true for resource.archived event', () => {
      const event: ResourceEvent = {
        id: 'evt-123',
        timestamp: '2024-01-01T00:00:00Z',
        resourceId: 'doc-abc',
        userId: 'did:web:example.com:users:alice',
        type: 'resource.archived',
        version: 1,
        payload: {
          reason: undefined,
        },
      } as any;

      expect(isResourceScopedEvent(event)).toBe(true);
    });
  });

  describe('getEventType', () => {
    it('should extract type from resource.created event', () => {
      const event: ResourceEvent = {
        id: 'evt-123',
        timestamp: '2024-01-01T00:00:00Z',
        resourceId: 'doc-abc',
        userId: 'did:web:example.com:users:alice',
        type: 'resource.created',
        version: 1,
        payload: {} as any,
      } as any;

      expect(getEventType(event)).toBe('resource.created');
    });

    it('should extract type from entitytype.added event', () => {
      const event: ResourceEvent = {
        id: 'evt-123',
        timestamp: '2024-01-01T00:00:00Z',
        userId: 'did:web:example.com:users:alice',
        type: 'entitytype.added',
        version: 1,
        payload: {} as any,
      } as SystemEvent;

      expect(getEventType(event)).toBe('entitytype.added');
    });

    it('should extract type from annotation event', () => {
      const event: ResourceEvent = {
        id: 'evt-123',
        timestamp: '2024-01-01T00:00:00Z',
        resourceId: 'doc-abc',
        userId: 'did:web:example.com:users:alice',
        type: 'annotation.body.updated',
        version: 1,
        payload: {} as any,
      } as any;

      expect(getEventType(event)).toBe('annotation.body.updated');
    });
  });

  describe('event type guard integration', () => {
    it('should correctly classify system vs resource events', () => {
      const systemEvent: ResourceEvent = {
        id: 'evt-1',
        timestamp: '2024-01-01T00:00:00Z',
        userId: 'did:web:example.com:users:alice',
        type: 'entitytype.added',
        version: 1,
        payload: { entityType: 'Person' },
      } as SystemEvent;

      const resourceEvent: ResourceEvent = {
        id: 'evt-2',
        timestamp: '2024-01-01T00:00:00Z',
        resourceId: 'doc-abc',
        userId: 'did:web:example.com:users:alice',
        type: 'resource.created',
        version: 1,
        payload: {} as any,
      } as any;

      expect(isSystemEvent(systemEvent)).toBe(true);
      expect(isResourceScopedEvent(systemEvent)).toBe(false);

      expect(isSystemEvent(resourceEvent)).toBe(false);
      expect(isResourceScopedEvent(resourceEvent)).toBe(true);
    });
  });
});
