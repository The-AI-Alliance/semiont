/**
 * Which annotation a stored event is about. The history panel asks this of
 * every row, to mark the rows of a hovered annotation and to make a row lead
 * to its annotation.
 */

import { describe, it, expect } from 'vitest';
import { getAnnotationIdFromEvent, type StoredEventLike } from '../event-utils';

const event = (type: string, payload: unknown): StoredEventLike => ({
  id: 'evt-1',
  type,
  timestamp: '2026-01-01T00:00:00.000Z',
  userId: 'did:web:kb.example:users:alice',
  resourceId: 'res-1',
  payload,
  metadata: { sequenceNumber: 1 },
});

describe('the annotation a stored event is about', () => {
  it('is the annotation a mark:added carries', () => {
    expect(getAnnotationIdFromEvent(event('mark:added', { annotation: { id: 'ann-1' } }))).toBe('ann-1');
  });

  it.each(['mark:removed', 'mark:body-updated'])('is the id a %s names', (type) => {
    expect(getAnnotationIdFromEvent(event(type, { annotationId: 'ann-1' }))).toBe('ann-1');
  });

  it('is none for an event about no annotation', () => {
    expect(getAnnotationIdFromEvent(event('yield:created', { name: 'A' }))).toBeNull();
  });

  it.each([
    ['mark:added', { annotation: { id: 'not an id' } }],
    ['mark:removed', { annotationId: 'a/b' }],
    ['mark:removed', {}],
    ['mark:added', undefined],
  ])('is none when a %s names no annotation id (%j)', (type, payload) => {
    expect(getAnnotationIdFromEvent(event(type, payload))).toBeNull();
  });
});
