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
vi.mock('@semiont/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@semiont/core')>();
  return {
    ...actual,
  getExactText: vi.fn((selector: any) => selector?.exact ?? null),
  getTargetSelector: vi.fn((target: any) => target?.selector ?? null),
  };
});

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
      expect(formatEventType('yield:created', t)).toBe('resourceCreated');
      expect(formatEventType('yield:cloned', t)).toBe('resourceCloned');
      expect(formatEventType('mark:archived', t)).toBe('resourceArchived');
      expect(formatEventType('mark:unarchived', t)).toBe('resourceUnarchived');
    });

    it('returns motivation-specific key for mark:added', () => {
      expect(formatEventType('mark:added', t, { annotation: { motivation: 'highlighting' } })).toBe('highlightAdded');
      expect(formatEventType('mark:added', t, { annotation: { motivation: 'linking' } })).toBe('referenceCreated');
      expect(formatEventType('mark:added', t, { annotation: { motivation: 'assessing' } })).toBe('assessmentAdded');
      expect(formatEventType('mark:added', t, { annotation: { motivation: 'commenting' } })).toBe('annotationAdded');
    });

    it('returns annotationRemoved for mark:removed', () => {
      expect(formatEventType('mark:removed', t)).toBe('annotationRemoved');
    });

    it('returns annotationBodyUpdated for mark:body-updated', () => {
      expect(formatEventType('mark:body-updated', t)).toBe('annotationBodyUpdated');
    });

    it('returns entitytag keys', () => {
      expect(formatEventType('mark:entity-tag-added', t)).toBe('entitytagAdded');
      expect(formatEventType('mark:entity-tag-removed', t)).toBe('entitytagRemoved');
    });

    it('returns jobEvent for job types', () => {
      expect(formatEventType('job:completed', t)).toBe('jobEvent');
      expect(formatEventType('job:started', t)).toBe('jobEvent');
      expect(formatEventType('job:failed', t)).toBe('jobEvent');
    });

    it('returns representationEvent for yield:representation types', () => {
      expect(formatEventType('yield:representation-added', t)).toBe('representationEvent');
      expect(formatEventType('yield:representation-removed', t)).toBe('representationEvent');
    });

    it('returns raw type for unknown event types', () => {
      expect(formatEventType('custom.event' as any, t)).toBe('custom.event');
    });
  });

  describe('getEventEmoji', () => {
    it('returns document emoji for resource events', () => {
      expect(getEventEmoji('yield:created')).toBe('📄');
      expect(getEventEmoji('yield:cloned')).toBe('📄');
    });

    it('returns motivation-specific emoji for mark:added', () => {
      expect(getEventEmoji('mark:added', { annotation: { motivation: 'highlighting' } })).toBe('🟡');
      expect(getEventEmoji('mark:added', { annotation: { motivation: 'linking' } })).toBeTruthy();
      expect(getEventEmoji('mark:added', { annotation: { motivation: 'assessing' } })).toBe('🔴');
    });

    it('returns trash emoji for mark:removed', () => {
      expect(getEventEmoji('mark:removed')).toBe('🗑️');
    });

    it('returns pencil emoji for mark:body-updated', () => {
      expect(getEventEmoji('mark:body-updated')).toBe('✏️');
    });

    it('returns tag emoji for entitytag events', () => {
      expect(getEventEmoji('mark:entity-tag-added')).toBe('🏷️');
      expect(getEventEmoji('mark:entity-tag-removed')).toBe('🏷️');
    });

    it('returns appropriate emoji for job events', () => {
      expect(getEventEmoji('job:completed')).toBe('🔗');
      expect(getEventEmoji('job:started')).toBe('⚙️');
      expect(getEventEmoji('job:failed')).toBe('❌');
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
    it('returns resource name for yield:created', () => {
      const event = { type: 'yield:created' as const, payload: { name: 'My Document' }, userId: 'u1', timestamp: '' } as any;
      const result = getEventDisplayContent(event, [], []);
      expect(result).toEqual({ exact: 'My Document', isQuoted: false, isTag: false });
    });

    it('returns resource name for yield:cloned', () => {
      const event = { type: 'yield:cloned' as const, payload: { name: 'Cloned Doc' }, userId: 'u1', timestamp: '' } as any;
      const result = getEventDisplayContent(event, [], []);
      expect(result).toEqual({ exact: 'Cloned Doc', isQuoted: false, isTag: false });
    });

    it('returns entity type for entitytag events', () => {
      const event = { type: 'mark:entity-tag-added' as const, payload: { entityType: 'Person' }, userId: 'u1', timestamp: '' } as any;
      const result = getEventDisplayContent(event, [], []);
      expect(result).toEqual({ exact: 'Person', isQuoted: false, isTag: true });
    });

    it('returns null for job:started', () => {
      const event = { type: 'job:started' as const, payload: {}, userId: 'u1', timestamp: '' } as any;
      expect(getEventDisplayContent(event, [], [])).toBeNull();
    });

    it('returns null for yield:representation events', () => {
      const event = { type: 'yield:representation-added' as const, payload: {}, userId: 'u1', timestamp: '' } as any;
      expect(getEventDisplayContent(event, [], [])).toBeNull();
    });
  });

  describe('getEventEntityTypes', () => {
    it('returns entity types from mark:added with linking motivation', () => {
      const event = {
        type: 'mark:added' as const,
        payload: {
          annotation: {
            motivation: 'linking',
            body: { entityTypes: ['Person', 'Place'] },
          },
        },
      } as any;
      expect(getEventEntityTypes(event)).toEqual(['Person', 'Place']);
    });

    it('returns empty array for non-linking annotations', () => {
      const event = {
        type: 'mark:added' as const,
        payload: {
          annotation: { motivation: 'highlighting', body: null },
        },
      } as any;
      expect(getEventEntityTypes(event)).toEqual([]);
    });

    it('returns empty array for non-annotation events', () => {
      const event = { type: 'yield:created' as const, payload: { name: 'test' } } as any;
      expect(getEventEntityTypes(event)).toEqual([]);
    });
  });

  describe('getResourceCreationDetails', () => {
    it('returns created details for yield:created', () => {
      const event = {
        type: 'yield:created' as const,
        payload: { name: 'Doc', creationMethod: 'upload' },
        userId: 'user-1',
        timestamp: '',
      } as any;
      const result = getResourceCreationDetails(event);
      expect(result).toEqual({
        type: 'created',
        method: 'upload',
        userId: 'user-1',
        metadata: undefined,
      });
    });

    it('returns cloned details for yield:cloned', () => {
      const event = {
        type: 'yield:cloned' as const,
        payload: { name: 'Clone', creationMethod: 'clone', parentResourceId: 'parent-1' },
        userId: 'user-2',
        timestamp: '',
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
        type: 'yield:created' as const,
        payload: { name: 'Doc' },
        userId: 'u1',
        timestamp: '',
      } as any;
      expect(getResourceCreationDetails(event)?.method).toBe('unknown');
    });

    it('returns null for non-creation events', () => {
      const event = { type: 'mark:added' as const, payload: {} } as any;
      expect(getResourceCreationDetails(event)).toBeNull();
    });
  });
});
