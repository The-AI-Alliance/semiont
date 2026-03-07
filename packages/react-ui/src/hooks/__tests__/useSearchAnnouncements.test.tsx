/**
 * Tests for useSearchAnnouncements hook
 *
 * Validates the accessibility announcements for search operations:
 * - Searching announcements
 * - Search results announcements
 * - Selection announcements
 * - Navigation announcements
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { LiveRegionProvider } from '../../components/LiveRegion';
import { useSearchAnnouncements } from '../useSearchAnnouncements';
import React from 'react';

describe('useSearchAnnouncements', () => {
  function renderWithProvider() {
    return renderHook(() => useSearchAnnouncements(), {
      wrapper: ({ children }) => (
        <LiveRegionProvider>{children}</LiveRegionProvider>
      ),
    });
  }

  it('provides all announcement functions', () => {
    const { result } = renderWithProvider();

    expect(typeof result.current.announceSearching).toBe('function');
    expect(typeof result.current.announceSearchResults).toBe('function');
    expect(typeof result.current.announceSelection).toBe('function');
    expect(typeof result.current.announceNavigation).toBe('function');
  });

  it('announces searching state', () => {
    const { result } = renderWithProvider();

    expect(() => {
      result.current.announceSearching();
    }).not.toThrow();
  });

  it('announces zero search results', () => {
    const { result } = renderWithProvider();

    expect(() => {
      result.current.announceSearchResults(0, 'test query');
    }).not.toThrow();
  });

  it('announces single search result', () => {
    const { result } = renderWithProvider();

    expect(() => {
      result.current.announceSearchResults(1, 'test query');
    }).not.toThrow();
  });

  it('announces multiple search results', () => {
    const { result } = renderWithProvider();

    expect(() => {
      result.current.announceSearchResults(5, 'test query');
    }).not.toThrow();
  });

  it('announces selection with type and name', () => {
    const { result } = renderWithProvider();

    expect(() => {
      result.current.announceSelection('Document.pdf', 'document');
    }).not.toThrow();
  });

  it('announces navigation with type and name', () => {
    const { result } = renderWithProvider();

    expect(() => {
      result.current.announceNavigation('Document.pdf', 'document');
    }).not.toThrow();
  });

  it('works without LiveRegionProvider (no-op mode)', () => {
    const { result } = renderHook(() => useSearchAnnouncements());

    // All functions should work without throwing
    expect(() => {
      result.current.announceSearching();
      result.current.announceSearchResults(5, 'test');
      result.current.announceSelection('Item', 'resource');
      result.current.announceNavigation('Item', 'resource');
    }).not.toThrow();
  });

  it('handles various search queries', () => {
    const { result } = renderWithProvider();

    const queries = [
      'simple query',
      'UTF-8: 搜索',
      'special!@#$%characters',
      'very long query that contains many words and spans multiple lines',
      '',
    ];

    queries.forEach((query) => {
      expect(() => {
        result.current.announceSearchResults(3, query);
      }).not.toThrow();
    });
  });

  it('handles various resource types', () => {
    const { result } = renderWithProvider();

    const types = [
      'document',
      'image',
      'annotation',
      'resource',
      'collection',
      'user',
    ];

    types.forEach((type) => {
      expect(() => {
        result.current.announceSelection('Test Item', type);
        result.current.announceNavigation('Test Item', type);
      }).not.toThrow();
    });
  });

  it('handles various result counts', () => {
    const { result } = renderWithProvider();

    const counts = [0, 1, 2, 10, 100, 1000];

    counts.forEach((count) => {
      expect(() => {
        result.current.announceSearchResults(count, 'test query');
      }).not.toThrow();
    });
  });

  it('handles empty and special character names', () => {
    const { result } = renderWithProvider();

    const names = [
      '',
      'Normal Name',
      'Name with spaces',
      'UTF-8: 文档',
      'Special!@#$%^&*()',
    ];

    names.forEach((name) => {
      expect(() => {
        result.current.announceSelection(name, 'document');
        result.current.announceNavigation(name, 'document');
      }).not.toThrow();
    });
  });

  it('can be called multiple times in sequence', () => {
    const { result } = renderWithProvider();

    expect(() => {
      result.current.announceSearching();
      result.current.announceSearchResults(5, 'first query');
      result.current.announceSelection('Item 1', 'document');
      result.current.announceNavigation('Item 1', 'document');
      result.current.announceSearching();
      result.current.announceSearchResults(0, 'second query');
    }).not.toThrow();
  });
});
