'use client';

import { useRef, useEffect, useCallback, KeyboardEvent } from 'react';

interface UseRovingTabIndexOptions {
  orientation?: 'horizontal' | 'vertical' | 'grid';
  loop?: boolean;
  cols?: number; // For grid navigation
}

export function useRovingTabIndex<T extends HTMLElement>(
  itemCount: number,
  options: UseRovingTabIndexOptions = {}
) {
  const { orientation = 'horizontal', loop = true, cols = 1 } = options;
  const containerRef = useRef<T>(null);
  const currentIndexRef = useRef(0);

  // Get all focusable items within the container
  const getFocusableItems = useCallback(() => {
    if (!containerRef.current) return [];
    return Array.from(
      containerRef.current.querySelectorAll<HTMLElement>(
        '[role="button"]:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    );
  }, []);

  // Focus item at specific index
  const focusItem = useCallback((index: number) => {
    const items = getFocusableItems();
    if (items.length === 0) return;

    // Ensure index is within bounds
    let targetIndex = index;
    if (loop) {
      targetIndex = ((index % items.length) + items.length) % items.length;
    } else {
      targetIndex = Math.max(0, Math.min(index, items.length - 1));
    }

    // Update tabindex attributes
    items.forEach((item, i) => {
      item.setAttribute('tabindex', i === targetIndex ? '0' : '-1');
    });

    // Focus the target item
    items[targetIndex]?.focus();
    currentIndexRef.current = targetIndex;
  }, [getFocusableItems, loop]);

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const items = getFocusableItems();
      if (items.length === 0) return;

      const currentIndex = currentIndexRef.current;
      let nextIndex = currentIndex;

      switch (event.key) {
        case 'ArrowRight':
          if (orientation === 'horizontal' || orientation === 'grid') {
            event.preventDefault();
            nextIndex = currentIndex + 1;
          }
          break;

        case 'ArrowLeft':
          if (orientation === 'horizontal' || orientation === 'grid') {
            event.preventDefault();
            nextIndex = currentIndex - 1;
          }
          break;

        case 'ArrowDown':
          if (orientation === 'vertical') {
            event.preventDefault();
            nextIndex = currentIndex + 1;
          } else if (orientation === 'grid') {
            event.preventDefault();
            nextIndex = currentIndex + cols;
          }
          break;

        case 'ArrowUp':
          if (orientation === 'vertical') {
            event.preventDefault();
            nextIndex = currentIndex - 1;
          } else if (orientation === 'grid') {
            event.preventDefault();
            nextIndex = currentIndex - cols;
          }
          break;

        case 'Home':
          event.preventDefault();
          nextIndex = 0;
          break;

        case 'End':
          event.preventDefault();
          nextIndex = items.length - 1;
          break;

        default:
          return;
      }

      focusItem(nextIndex);
    },
    [orientation, cols, getFocusableItems, focusItem]
  );

  // Initialize tabindex on mount and when items change
  useEffect(() => {
    const items = getFocusableItems();
    if (items.length === 0) return;

    // Set initial tabindex values
    items.forEach((item, i) => {
      item.setAttribute('tabindex', i === 0 ? '0' : '-1');
    });

    // Add click handlers to update current index
    const handleClick = (index: number) => () => {
      currentIndexRef.current = index;
      const items = getFocusableItems();
      items.forEach((item, i) => {
        item.setAttribute('tabindex', i === index ? '0' : '-1');
      });
    };

    const clickHandlers = items.map((item, i) => {
      const handler = handleClick(i);
      item.addEventListener('click', handler);
      return handler;
    });

    // Cleanup
    return () => {
      items.forEach((item, i) => {
        const handler = clickHandlers[i];
        if (handler) {
          item.removeEventListener('click', handler);
        }
      });
    };
  }, [itemCount, getFocusableItems]);

  return {
    containerRef,
    handleKeyDown,
    focusItem,
  };
}