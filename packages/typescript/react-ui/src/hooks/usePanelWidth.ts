import { useState, useEffect, useRef } from 'react';

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
  // Always initialize with defaultWidth to avoid hydration mismatch
  // localStorage value will be synced in useEffect
  const [width, setWidthInternal] = useState<number>(defaultWidth);
  // Track whether the current width came from user interaction (not mount hydration)
  const userChangedRef = useRef(false);

  // Sync with localStorage on mount (client-side only)
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const saved = localStorage.getItem(storageKey);
    if (saved) {
      const parsed = parseInt(saved, 10);
      // Ensure saved value is within constraints
      const constrained = Math.max(minWidth, Math.min(maxWidth, parsed));
      setWidthInternal(constrained);
    }
  }, []); // Empty deps - only run once on mount

  // Setter that enforces min/max constraints - only called by user interaction
  const setWidth = (newWidth: number) => {
    const constrained = Math.max(minWidth, Math.min(maxWidth, newWidth));
    userChangedRef.current = true;
    setWidthInternal(constrained);
  };

  // Persist to localStorage only when the user has changed the width
  useEffect(() => {
    if (!userChangedRef.current) return;
    localStorage.setItem(storageKey, width.toString());
  }, [width, storageKey]);

  return { width, setWidth, minWidth, maxWidth };
}
