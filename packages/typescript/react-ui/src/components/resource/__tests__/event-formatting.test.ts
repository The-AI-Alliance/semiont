import { describe, it, expect, vi, beforeEach } from 'vitest';
import { annotationId, resourceId, type Annotation, type StoredEventLike } from '@semiont/core';
import {
  formatEventType,
  getEventEmoji,
  formatRelativeTime,
  getEventDisplayContent,
  getEventEntityTypes,
  getResourceCreationDetails,
} from '../event-formatting';

/** A stored event as the history reads it off the wire: its type, and its payload as sent. */
const stored = (type: string, payload: Record<string, unknown>): StoredEventLike => ({
  id: `event-${type}`,
  type,
  timestamp: '2026-10-14T00:00:00.000Z',
  userId: 'did:web:example.org:users:alice',
  payload,
  metadata: { sequenceNumber: 1 },
});

/**
 * A reference on "Ada Lovelace". Its id is a name, as every annotation's is,
 * and its entity types are the values of its tagging bodies.
 */
const reference: Annotation = {
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  type: 'Annotation',
  id: annotationId('ann-1'),
  motivation: 'linking',
  created: '2026-10-14T00:00:00.000Z',
  target: {
    source: resourceId('res-1'),
    selector: [
      { type: 'TextPositionSelector', start: 0, end: 12 },
      { type: 'TextQuoteSelector', exact: 'Ada Lovelace' },
    ],
  },
  body: [
    { type: 'TextualBody', value: 'Person', purpose: 'tagging' },
    { type: 'TextualBody', value: 'Mathematician', purpose: 'tagging' },
  ],
};

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
      expect(formatEventType('custom.event', t)).toBe('custom.event');
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
      expect(getEventEmoji('unknown')).toBe('📝');
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
      const result = getEventDisplayContent(stored('yield:created', { name: 'My Document' }), [], []);
      expect(result).toEqual({ exact: 'My Document', isQuoted: false, isTag: false });
    });

    it('returns resource name for yield:cloned', () => {
      const result = getEventDisplayContent(stored('yield:cloned', { name: 'Cloned Doc' }), [], []);
      expect(result).toEqual({ exact: 'Cloned Doc', isQuoted: false, isTag: false });
    });

    it('returns entity type for entitytag events', () => {
      const result = getEventDisplayContent(stored('mark:entity-tag-added', { entityType: 'Person' }), [], []);
      expect(result).toEqual({ exact: 'Person', isQuoted: false, isTag: true });
    });

    it('returns null for job:started', () => {
      expect(getEventDisplayContent(stored('job:started', {}), [], [])).toBeNull();
    });

    it('returns null for yield:representation events', () => {
      expect(getEventDisplayContent(stored('yield:representation-added', {}), [], [])).toBeNull();
    });

    it('shows the text an added annotation quotes', () => {
      const added = stored('mark:added', { annotation: reference });
      expect(getEventDisplayContent(added, [], [added])).toEqual({ exact: 'Ada Lovelace', isQuoted: true, isTag: false });
    });

    it('shows the text of an annotation whose body was updated, found by its id', () => {
      const updated = stored('mark:body-updated', { annotationId: 'ann-1', operations: [] });
      expect(getEventDisplayContent(updated, [reference], [updated])).toEqual({ exact: 'Ada Lovelace', isQuoted: true, isTag: false });
    });

    it('shows the text of a removed annotation, from the event that added it', () => {
      // A removed annotation is in no list of annotations: its text is the event's that added it.
      const added = stored('mark:added', { annotation: reference });
      const removed = stored('mark:removed', { annotationId: 'ann-1' });
      expect(getEventDisplayContent(removed, [], [added, removed])).toEqual({ exact: 'Ada Lovelace', isQuoted: true, isTag: false });
    });

    it('shows nothing for an annotation it cannot find', () => {
      const removed = stored('mark:removed', { annotationId: 'ann-2' });
      expect(getEventDisplayContent(removed, [reference], [stored('mark:added', { annotation: reference }), removed])).toBeNull();
    });
  });

  describe('getEventEntityTypes', () => {
    it("reads a reference's entity types off its tagging bodies", () => {
      expect(getEventEntityTypes(stored('mark:added', { annotation: reference }))).toEqual(['Person', 'Mathematician']);
    });

    it('states none for an annotation that does not link: a tag\'s category is no entity type', () => {
      const tag: Annotation = { ...reference, motivation: 'tagging', body: [{ type: 'TextualBody', value: 'Issue', purpose: 'tagging' }] };
      expect(getEventEntityTypes(stored('mark:added', { annotation: tag }))).toEqual([]);
    });

    it('returns empty array for non-annotation events', () => {
      expect(getEventEntityTypes(stored('yield:created', { name: 'test' }))).toEqual([]);
    });
  });

  describe('getResourceCreationDetails', () => {
    it('returns created details for yield:created', () => {
      expect(getResourceCreationDetails(stored('yield:created', { name: 'Doc' }))).toEqual({ type: 'created' });
    });

    it('returns cloned details for yield:cloned', () => {
      const cloned = stored('yield:cloned', { name: 'Clone', parentResourceId: 'parent-1' });
      expect(getResourceCreationDetails(cloned)).toEqual({ type: 'cloned', sourceDocId: 'parent-1' });
    });

    it('returns null for non-creation events', () => {
      expect(getResourceCreationDetails(stored('mark:added', {}))).toBeNull();
    });
  });
});
