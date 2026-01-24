import { useState, useEffect } from 'react';

interface UsePanelWidthOptions {
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  storageKey?: string;
}

/**
 * Custom hook for managing resizable panel width with localStorage persistence
 *
 * @param options Configuration options for panel width behavior
 * @param options.defaultWidth Default width in pixels (default: 384px / 24rem)
 * @param options.minWidth Minimum allowed width in pixels (default: 256px / 16rem)
 * @param options.maxWidth Maximum allowed width in pixels (default: 800px / 50rem)
 * @param options.storageKey localStorage key for persistence (default: 'semiont-panel-width')
 *
 * @returns Object containing current width, setter function, and constraints
 *
 * @example
 * ```tsx
 * const { width, setWidth, minWidth, maxWidth } = usePanelWidth();
 *
 * <div style={{ width: `${width}px` }}>
 *   <ResizeHandle onResize={setWidth} minWidth={minWidth} maxWidth={maxWidth} />
 * </div>
 * ```
 */
export function usePanelWidth({
  defaultWidth = 384, // 24rem
  minWidth = 256,     // 16rem
  maxWidth = 800,     // 50rem
  storageKey = 'semiont-panel-width'
}: UsePanelWidthOptions = {}) {
  // Initialize width from localStorage or use default
  const [width, setWidthInternal] = useState<number>(() => {
    if (typeof window === 'undefined') return defaultWidth;

    const saved = localStorage.getItem(storageKey);
    if (saved) {
      const parsed = parseInt(saved, 10);
      // Ensure saved value is within constraints
      return Math.max(minWidth, Math.min(maxWidth, parsed));
    }
    return defaultWidth;
  });

  // Setter that enforces min/max constraints
  const setWidth = (newWidth: number) => {
    const constrained = Math.max(minWidth, Math.min(maxWidth, newWidth));
    setWidthInternal(constrained);
  };

  // Persist to localStorage whenever width changes
  useEffect(() => {
    localStorage.setItem(storageKey, width.toString());
  }, [width, storageKey]);

  return { width, setWidth, minWidth, maxWidth };
}
