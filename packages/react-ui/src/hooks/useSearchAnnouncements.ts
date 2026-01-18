'use client';

import { useCallback } from 'react';
import { useLiveRegion } from '../components/LiveRegion';

/**
 * Hook for announcing search-related events to screen readers
 */
export function useSearchAnnouncements() {
  const { announce } = useLiveRegion();

  const announceSearching = useCallback(() => {
    announce('Searching...', 'polite');
  }, [announce]);

  const announceSearchResults = useCallback((count: number, query: string) => {
    if (count === 0) {
      announce(`No results found for ${query}`, 'polite');
    } else if (count === 1) {
      announce(`1 result found for ${query}`, 'polite');
    } else {
      announce(`${count} results found for ${query}`, 'polite');
    }
  }, [announce]);

  const announceSelection = useCallback((name: string, type: string) => {
    announce(`Selected ${type}: ${name}. Press Enter to navigate.`, 'polite');
  }, [announce]);

  const announceNavigation = useCallback((name: string, type: string) => {
    announce(`Navigating to ${type}: ${name}`, 'assertive');
  }, [announce]);

  return {
    announceSearching,
    announceSearchResults,
    announceSelection,
    announceNavigation
  };
}