/**
 * Binder Actor Tests
 *
 * Tests the Binder's RxJS pipeline:
 * - Search request handling (bind:search-requested → bind:search-results/bind:search-failed)
 * - Error handling
 * - Lifecycle (stop)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { take } from 'rxjs/operators';
import { EventBus, type Logger } from '@semiont/core';
import type { KnowledgeBase } from '../knowledge-base';
import { Binder } from '../binder';

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger),
};

function createMockKb(searchFn: (...args: any[]) => any): KnowledgeBase {
  return {
    eventStore: {} as any,
    views: {} as any,
    content: {} as any,
    graph: {
      searchResources: searchFn,
      createResource: vi.fn(),
      deleteResource: vi.fn(),
      getBacklinks: vi.fn(),
      findPath: vi.fn(),
      getResourceConnections: vi.fn(),
      disconnect: vi.fn(),
    } as any,
  };
}

describe('Binder', () => {
  let eventBus: EventBus;
  let binder: Binder;
  let mockSearchFn: ReturnType<typeof vi.fn>;
  let kb: KnowledgeBase;

  beforeEach(async () => {
    vi.clearAllMocks();
    eventBus = new EventBus();
    mockSearchFn = vi.fn();
    kb = createMockKb(mockSearchFn);
    binder = new Binder(kb, eventBus, mockLogger);
    await binder.initialize();
  });

  afterEach(async () => {
    await binder.stop();
    eventBus.destroy();
  });

  describe('search handling', () => {
    it('should emit bind:search-results on success', async () => {
      const mockResults = [
        { '@id': 'http://localhost:4000/resources/r1', name: 'Resource 1' },
        { '@id': 'http://localhost:4000/resources/r2', name: 'Resource 2' },
      ];
      mockSearchFn.mockResolvedValue(mockResults);

      const resultPromise = eventBus.get('bind:search-results').pipe(take(1)).toPromise();

      eventBus.get('bind:search-requested').next({
        referenceId: 'ref-1',
        searchTerm: 'test query',
      });

      const result = await resultPromise;
      expect(result!.referenceId).toBe('ref-1');
      expect(result!.searchTerm).toBe('test query');
      expect(result!.results).toEqual(mockResults);

      expect(mockSearchFn).toHaveBeenCalledWith('test query');
    });

    it('should emit bind:search-failed on error', async () => {
      mockSearchFn.mockRejectedValue(new Error('Graph connection failed'));

      const resultPromise = eventBus.get('bind:search-failed').pipe(take(1)).toPromise();

      eventBus.get('bind:search-requested').next({
        referenceId: 'ref-2',
        searchTerm: 'failing query',
      });

      const result = await resultPromise;
      expect(result!.referenceId).toBe('ref-2');
      expect(result!.error.message).toBe('Graph connection failed');
    });

    it('should handle empty search results', async () => {
      mockSearchFn.mockResolvedValue([]);

      const resultPromise = eventBus.get('bind:search-results').pipe(take(1)).toPromise();

      eventBus.get('bind:search-requested').next({
        referenceId: 'ref-3',
        searchTerm: 'nonexistent',
      });

      const result = await resultPromise;
      expect(result!.results).toEqual([]);
    });
  });

  describe('lifecycle', () => {
    it('should stop cleanly', async () => {
      await binder.stop();
      expect(mockLogger.info).toHaveBeenCalledWith('Binder actor stopped');
    });

    it('should not process events after stop', async () => {
      await binder.stop();

      eventBus.get('bind:search-requested').next({
        referenceId: 'ref-4',
        searchTerm: 'after stop',
      });

      // Give time for any processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockSearchFn).not.toHaveBeenCalled();
    });
  });
});
