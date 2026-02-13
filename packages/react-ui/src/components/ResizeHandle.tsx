'use client';

import React, { useRef, useCallback, useEffect, useState } from 'react';
import './layout/ResizeHandle.css';

interface ResizeHandleProps {
  /** Callback fired when resize occurs */
  onResize: (newWidth: number) => void;
  /** Minimum allowed width in pixels */
  minWidth: number;
  /** Maximum allowed width in pixels */
  maxWidth: number;
  /** Position of handle - left or right edge */
  position?: 'left' | 'right';
  /** Aria label for accessibility */
  ariaLabel?: string;
}

/**
 * Draggable resize handle for panels and sidebars
 *
 * Features:
 * - Mouse drag to resize
 * - Keyboard navigation (Arrow keys: ±10px, Shift+Arrow: ±50px)
 * - Enforces min/max constraints
 * - Visual feedback on hover and drag
 * - Accessible (WCAG compliant)
 *
 * @example
 * ```tsx
 * <div className="panel" style={{ width: `${width}px` }}>
 *   <ResizeHandle
 *     onResize={setWidth}
 *     minWidth={256}
 *     maxWidth={800}
 *     position="left"
 *   />
 *   <div>Panel content</div>
 * </div>
 * ```
 */
export function ResizeHandle({
  onResize,
  minWidth,
  maxWidth,
  position = 'left',
  ariaLabel = 'Resize panel'
}: ResizeHandleProps) {
  const [isDragging, setIsDragging] = useState(false);
  const startXRef = useRef<number>(0);
  const startWidthRef = useRef<number>(0);

  // Store callback in ref to avoid including in dependency arrays
  const onResizeRef = useRef(onResize);
  useEffect(() => {
    onResizeRef.current = onResize;
  });

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    startXRef.current = e.clientX;

    // Get current width from parent element
    const parent = (e.target as HTMLElement).parentElement;
    if (parent) {
      startWidthRef.current = parent.offsetWidth;
    }
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging) return;

    const deltaX = e.clientX - startXRef.current;
    // For left-positioned handles, moving right decreases width (panel is on right)
    // For right-positioned handles, moving right increases width (panel is on left)
    const widthDelta = position === 'left' ? -deltaX : deltaX;
    const newWidth = startWidthRef.current + widthDelta;

    // Enforce constraints
    const constrainedWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));
    onResizeRef.current(constrainedWidth);
  }, [isDragging, minWidth, maxWidth, position]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Keyboard navigation for accessibility
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Get current width from parent element
    const parent = (e.target as HTMLElement).parentElement;
    if (!parent) return;

    const currentWidth = parent.offsetWidth;
    const step = e.shiftKey ? 50 : 10; // Shift+Arrow for larger steps
    let newWidth = currentWidth;

    if (position === 'left') {
      // Left handle: Left arrow = wider, Right arrow = narrower
      if (e.key === 'ArrowLeft') {
        newWidth = currentWidth + step;
        e.preventDefault();
      } else if (e.key === 'ArrowRight') {
        newWidth = currentWidth - step;
        e.preventDefault();
      }
    } else {
      // Right handle: Right arrow = wider, Left arrow = narrower
      if (e.key === 'ArrowRight') {
        newWidth = currentWidth + step;
        e.preventDefault();
      } else if (e.key === 'ArrowLeft') {
        newWidth = currentWidth - step;
        e.preventDefault();
      }
    }

    // Only resize if arrow key was pressed
    if (newWidth !== currentWidth) {
      const constrainedWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));
      onResizeRef.current(constrainedWidth);
    }
  }, [minWidth, maxWidth, position]);

  // Add/remove global mouse event listeners for dragging
  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      // Prevent text selection during drag
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';

      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
      };
    }
    return undefined;
  }, [isDragging, handleMouseMove, handleMouseUp]);

  return (
    <button
      type="button"
      className={`semiont-resize-handle semiont-resize-handle--${position} ${isDragging ? 'semiont-resize-handle--dragging' : ''}`}
      onMouseDown={handleMouseDown}
      onKeyDown={handleKeyDown}
      aria-label={ariaLabel}
      role="separator"
      aria-orientation="vertical"
      tabIndex={0}
    />
  );
}
