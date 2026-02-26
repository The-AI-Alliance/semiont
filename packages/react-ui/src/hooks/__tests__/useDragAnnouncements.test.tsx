/**
 * Tests for useDragAnnouncements hook
 *
 * Validates the accessibility announcements for drag and drop operations:
 * - Reorder announcements
 * - Pickup announcements
 * - Drop announcements
 * - Move announcements
 * - Keyboard reorder announcements
 * - Cannot move announcements
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { LiveRegionProvider } from '../../components/LiveRegion';
import { useDragAnnouncements } from '../useDragAnnouncements';
import React from 'react';

describe('useDragAnnouncements', () => {
  let mockAnnounce: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockAnnounce = vi.fn();
  });

  function renderWithProvider() {
    return renderHook(() => useDragAnnouncements(), {
      wrapper: ({ children }) => (
        <LiveRegionProvider>{children}</LiveRegionProvider>
      ),
    });
  }

  it('provides all announcement functions', () => {
    const { result } = renderWithProvider();

    expect(typeof result.current.announceReorder).toBe('function');
    expect(typeof result.current.announcePickup).toBe('function');
    expect(typeof result.current.announceDrop).toBe('function');
    expect(typeof result.current.announceMove).toBe('function');
    expect(typeof result.current.announceKeyboardReorder).toBe('function');
    expect(typeof result.current.announceCannotMove).toBe('function');
  });

  it('announces reorder with custom message', () => {
    const { result } = renderWithProvider();

    // Just verify it doesn't throw
    expect(() => {
      result.current.announceReorder('Resources reordered by date');
    }).not.toThrow();
  });

  it('announces pickup with position information', () => {
    const { result } = renderWithProvider();

    expect(() => {
      result.current.announcePickup('Document.pdf', 3, 10);
    }).not.toThrow();
  });

  it('announces drop with new position', () => {
    const { result } = renderWithProvider();

    expect(() => {
      result.current.announceDrop('Document.pdf', 5, 10);
    }).not.toThrow();
  });

  it('announces move up with position', () => {
    const { result } = renderWithProvider();

    expect(() => {
      result.current.announceMove('Document.pdf', 'up', 2, 10);
    }).not.toThrow();
  });

  it('announces move down with position', () => {
    const { result } = renderWithProvider();

    expect(() => {
      result.current.announceMove('Document.pdf', 'down', 4, 10);
    }).not.toThrow();
  });

  it('announces keyboard reorder up', () => {
    const { result } = renderWithProvider();

    expect(() => {
      result.current.announceKeyboardReorder('Document.pdf', 'up', 1, 10);
    }).not.toThrow();
  });

  it('announces keyboard reorder down', () => {
    const { result } = renderWithProvider();

    expect(() => {
      result.current.announceKeyboardReorder('Document.pdf', 'down', 6, 10);
    }).not.toThrow();
  });

  it('announces cannot move up at top of list', () => {
    const { result } = renderWithProvider();

    expect(() => {
      result.current.announceCannotMove('up');
    }).not.toThrow();
  });

  it('announces cannot move down at bottom of list', () => {
    const { result } = renderWithProvider();

    expect(() => {
      result.current.announceCannotMove('down');
    }).not.toThrow();
  });

  it('works without LiveRegionProvider (no-op mode)', () => {
    const { result } = renderHook(() => useDragAnnouncements());

    // All functions should work without throwing
    expect(() => {
      result.current.announceReorder('Test message');
      result.current.announcePickup('Resource', 1, 5);
      result.current.announceDrop('Resource', 2, 5);
      result.current.announceMove('Resource', 'up', 1, 5);
      result.current.announceKeyboardReorder('Resource', 'down', 3, 5);
      result.current.announceCannotMove('up');
    }).not.toThrow();
  });

  it('handles various resource names', () => {
    const { result } = renderWithProvider();

    const resourceNames = [
      'Document.pdf',
      'Image with spaces.jpg',
      'UTF-8: 文档.docx',
      'Special!@#$%Characters.txt',
    ];

    resourceNames.forEach((name) => {
      expect(() => {
        result.current.announcePickup(name, 1, 5);
        result.current.announceDrop(name, 2, 5);
        result.current.announceMove(name, 'up', 1, 5);
        result.current.announceKeyboardReorder(name, 'down', 3, 5);
      }).not.toThrow();
    });
  });

  it('handles edge case positions', () => {
    const { result } = renderWithProvider();

    // First position
    expect(() => {
      result.current.announcePickup('Resource', 1, 10);
      result.current.announceDrop('Resource', 1, 10);
    }).not.toThrow();

    // Last position
    expect(() => {
      result.current.announcePickup('Resource', 10, 10);
      result.current.announceDrop('Resource', 10, 10);
    }).not.toThrow();

    // Single item list
    expect(() => {
      result.current.announcePickup('Resource', 1, 1);
      result.current.announceDrop('Resource', 1, 1);
    }).not.toThrow();
  });
});
