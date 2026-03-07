import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  formatEventType,
  getEventEmoji,
  formatRelativeTime,
  getEventDisplayContent,
  getEventEntityTypes,
  getResourceCreationDetails,
} from '../event-formatting';

// Mock api-client functions
vi.mock('@semiont/api-client', () => ({
  getExactText: vi.fn((selector: any) => selector?.exact ?? null),
  getTargetSelector: vi.fn((target: any) => target?.selector ?? null),
}));

const t = vi.fn((key: string, params?: Record<string, string | number>) => {
  if (params) return `${key}(${JSON.stringify(params)})`;
  return key;
});

describe('event-formatting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('formatEventType', () => {
    it('returns translation key for resource events', () => {
      expect(formatEventType('resource.created', t)).toBe('resourceCreated');
      expect(formatEventType('resource.cloned', t)).toBe('resourceCloned');
      expect(formatEventType('resource.archived', t)).toBe('resourceArchived');
      expect(formatEventType('resource.unarchived', t)).toBe('resourceUnarchived');
    });

    it('returns motivation-specific key for annotation.added', () => {
      expect(formatEventType('annotation.added', t, { annotation: { motivation: 'highlighting' } })).toBe('highlightAdded');
      expect(formatEventType('annotation.added', t, { annotation: { motivation: 'linking' } })).toBe('referenceCreated');
      expect(formatEventType('annotation.added', t, { annotation: { motivation: 'assessing' } })).toBe('assessmentAdded');
      expect(formatEventType('annotation.added', t, { annotation: { motivation: 'commenting' } })).toBe('annotationAdded');
    });

    it('returns annotationRemoved for annotation.removed', () => {
      expect(formatEventType('annotation.removed', t)).toBe('annotationRemoved');
    });

    it('returns annotationBodyUpdated for annotation.body.updated', () => {
      expect(formatEventType('annotation.body.updated', t)).toBe('annotationBodyUpdated');
    });

    it('returns entitytag keys', () => {
      expect(formatEventType('entitytag.added', t)).toBe('entitytagAdded');
      expect(formatEventType('entitytag.removed', t)).toBe('entitytagRemoved');
    });

    it('returns jobEvent for job types', () => {
      expect(formatEventType('job.completed', t)).toBe('jobEvent');
      expect(formatEventType('job.started', t)).toBe('jobEvent');
      expect(formatEventType('job.failed', t)).toBe('jobEvent');
    });

    it('returns representationEvent for representation types', () => {
      expect(formatEventType('representation.added', t)).toBe('representationEvent');
      expect(formatEventType('representation.removed', t)).toBe('representationEvent');
    });

    it('returns raw type for unknown event types', () => {
      expect(formatEventType('custom.event' as any, t)).toBe('custom.event');
    });
  });

  describe('getEventEmoji', () => {
    it('returns document emoji for resource events', () => {
      expect(getEventEmoji('resource.created')).toBe('📄');
      expect(getEventEmoji('resource.cloned')).toBe('📄');
    });

    it('returns motivation-specific emoji for annotation.added', () => {
      expect(getEventEmoji('annotation.added', { annotation: { motivation: 'highlighting' } })).toBe('🟡');
      expect(getEventEmoji('annotation.added', { annotation: { motivation: 'linking' } })).toBeTruthy();
      expect(getEventEmoji('annotation.added', { annotation: { motivation: 'assessing' } })).toBe('🔴');
    });

    it('returns trash emoji for annotation.removed', () => {
      expect(getEventEmoji('annotation.removed')).toBe('🗑️');
    });

    it('returns pencil emoji for annotation.body.updated', () => {
      expect(getEventEmoji('annotation.body.updated')).toBe('✏️');
    });

    it('returns tag emoji for entitytag events', () => {
      expect(getEventEmoji('entitytag.added')).toBe('🏷️');
      expect(getEventEmoji('entitytag.removed')).toBe('🏷️');
    });

    it('returns appropriate emoji for job events', () => {
      expect(getEventEmoji('job.completed')).toBe('🔗');
      expect(getEventEmoji('job.started')).toBe('⚙️');
      expect(getEventEmoji('job.failed')).toBe('❌');
    });

    it('returns default emoji for unknown', () => {
      expect(getEventEmoji('unknown' as any)).toBe('📝');
    });
  });

  describe('formatRelativeTime', () => {
    it('returns justNow for recent timestamps', () => {
      const now = new Date().toISOString();
      expect(formatRelativeTime(now, t)).toBe('justNow');
    });

    it('returns minutesAgo for timestamps within an hour', () => {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const result = formatRelativeTime(fiveMinAgo, t);
      expect(result).toContain('minutesAgo');
    });

    it('returns hoursAgo for timestamps within a day', () => {
      const threeHoursAgo = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
      const result = formatRelativeTime(threeHoursAgo, t);
      expect(result).toContain('hoursAgo');
    });

    it('returns daysAgo for timestamps within a week', () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 86400 * 1000).toISOString();
      const result = formatRelativeTime(twoDaysAgo, t);
      expect(result).toContain('daysAgo');
    });

    it('returns formatted date for older timestamps', () => {
      const oldDate = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
      const result = formatRelativeTime(oldDate, t);
      // Should be a locale date string, not a translation key
      expect(result).not.toContain('Ago');
    });
  });

  describe('getEventDisplayContent', () => {
    it('returns resource name for resource.created', () => {
      const event = {
        event: { type: 'resource.created' as const, payload: { name: 'My Document' }, userId: 'u1', timestamp: '' },
      } as any;
      const result = getEventDisplayContent(event, [], []);
      expect(result).toEqual({ exact: 'My Document', isQuoted: false, isTag: false });
    });

    it('returns resource name for resource.cloned', () => {
      const event = {
        event: { type: 'resource.cloned' as const, payload: { name: 'Cloned Doc' }, userId: 'u1', timestamp: '' },
      } as any;
      const result = getEventDisplayContent(event, [], []);
      expect(result).toEqual({ exact: 'Cloned Doc', isQuoted: false, isTag: false });
    });

    it('returns entity type for entitytag events', () => {
      const event = {
        event: { type: 'entitytag.added' as const, payload: { entityType: 'Person' }, userId: 'u1', timestamp: '' },
      } as any;
      const result = getEventDisplayContent(event, [], []);
      expect(result).toEqual({ exact: 'Person', isQuoted: false, isTag: true });
    });

    it('returns null for job.started', () => {
      const event = {
        event: { type: 'job.started' as const, payload: {}, userId: 'u1', timestamp: '' },
      } as any;
      expect(getEventDisplayContent(event, [], [])).toBeNull();
    });

    it('returns null for representation events', () => {
      const event = {
        event: { type: 'representation.added' as const, payload: {}, userId: 'u1', timestamp: '' },
      } as any;
      expect(getEventDisplayContent(event, [], [])).toBeNull();
    });
  });

  describe('getEventEntityTypes', () => {
    it('returns entity types from annotation.added with linking motivation', () => {
      const event = {
        event: {
          type: 'annotation.added' as const,
          payload: {
            annotation: {
              motivation: 'linking',
              body: { entityTypes: ['Person', 'Place'] },
            },
          },
        },
      } as any;
      expect(getEventEntityTypes(event)).toEqual(['Person', 'Place']);
    });

    it('returns empty array for non-linking annotations', () => {
      const event = {
        event: {
          type: 'annotation.added' as const,
          payload: {
            annotation: { motivation: 'highlighting', body: null },
          },
        },
      } as any;
      expect(getEventEntityTypes(event)).toEqual([]);
    });

    it('returns empty array for non-annotation events', () => {
      const event = {
        event: { type: 'resource.created' as const, payload: { name: 'test' } },
      } as any;
      expect(getEventEntityTypes(event)).toEqual([]);
    });
  });

  describe('getResourceCreationDetails', () => {
    it('returns created details for resource.created', () => {
      const event = {
        event: {
          type: 'resource.created' as const,
          payload: { name: 'Doc', creationMethod: 'upload' },
          userId: 'user-1',
          timestamp: '',
        },
      } as any;
      const result = getResourceCreationDetails(event);
      expect(result).toEqual({
        type: 'created',
        method: 'upload',
        userId: 'user-1',
        metadata: undefined,
      });
    });

    it('returns cloned details for resource.cloned', () => {
      const event = {
        event: {
          type: 'resource.cloned' as const,
          payload: { name: 'Clone', creationMethod: 'clone', parentResourceId: 'parent-1' },
          userId: 'user-2',
          timestamp: '',
        },
      } as any;
      const result = getResourceCreationDetails(event);
      expect(result).toEqual({
        type: 'cloned',
        method: 'clone',
        userId: 'user-2',
        sourceDocId: 'parent-1',
        parentResourceId: 'parent-1',
        metadata: undefined,
      });
    });

    it('uses fallback method when creationMethod missing', () => {
      const event = {
        event: {
          type: 'resource.created' as const,
          payload: { name: 'Doc' },
          userId: 'u1',
          timestamp: '',
        },
      } as any;
      expect(getResourceCreationDetails(event)?.method).toBe('unknown');
    });

    it('returns null for non-creation events', () => {
      const event = {
        event: { type: 'annotation.added' as const, payload: {} },
      } as any;
      expect(getResourceCreationDetails(event)).toBeNull();
    });
  });
});
