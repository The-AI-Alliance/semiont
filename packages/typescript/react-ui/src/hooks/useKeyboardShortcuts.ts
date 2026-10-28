'use client';

import { useEffect, useCallback, useRef } from 'react';

// Define keyboard shortcut types
export interface KeyboardShortcut {
  key: string;
  ctrlOrCmd?: boolean;
  shift?: boolean;
  alt?: boolean;
  handler: (event: KeyboardEvent) => void;
  description?: string;
  enabled?: boolean;
}

// Platform detection
const isMac = typeof window !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0;

/**
 * Hook for managing keyboard shortcuts
 * Handles platform differences (Cmd on Mac, Ctrl on Windows/Linux)
 * Prevents conflicts with browser shortcuts
 */
export function useKeyboardShortcuts(shortcuts: KeyboardShortcut[]) {
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    // Guard against undefined key
    if (!event.key) return;

    // Don't trigger shortcuts if user is typing in an input field
    const target = event.target as HTMLElement;
    if (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.contentEditable === 'true'
    ) {
      return;
    }

    // Get the active shortcuts
    const activeShortcuts = shortcutsRef.current.filter(s => s.enabled !== false);

    for (const shortcut of activeShortcuts) {
      // Check if the key matches
      if (event.key.toLowerCase() !== shortcut.key.toLowerCase()) continue;

      // Check modifiers
      const ctrlOrCmdPressed = isMac ? event.metaKey : event.ctrlKey;
      if (shortcut.ctrlOrCmd && !ctrlOrCmdPressed) continue;
      if (!shortcut.ctrlOrCmd && ctrlOrCmdPressed) continue;

      if (shortcut.shift && !event.shiftKey) continue;
      if (!shortcut.shift && event.shiftKey) continue;

      if (shortcut.alt && !event.altKey) continue;
      if (!shortcut.alt && event.altKey) continue;

      // Prevent default browser behavior
      event.preventDefault();
      event.stopPropagation();

      // Execute the handler
      shortcut.handler(event);
      break;
    }
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);
}

/**
 * Hook for double key press detection (e.g., double Escape)
 */
export function useDoubleKeyPress(
  key: string,
  handler: () => void,
  timeout: number = 300
) {
  const lastPressRef = useRef<number>(0);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key !== key) return;

    const now = Date.now();
    const timeSinceLastPress = now - lastPressRef.current;

    if (timeSinceLastPress < timeout) {
      // Double press detected
      handlerRef.current();
      lastPressRef.current = 0; // Reset
    } else {
      lastPressRef.current = now;
    }
  }, [key, timeout]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);
}

/**
 * Get keyboard shortcut display text based on platform
 */
export function getShortcutDisplay(shortcut: KeyboardShortcut): string {
  const parts: string[] = [];

  if (shortcut.ctrlOrCmd) {
    parts.push(isMac ? '⌘' : 'Ctrl');
  }
  if (shortcut.shift) {
    parts.push('Shift');
  }
  if (shortcut.alt) {
    parts.push(isMac ? '⌥' : 'Alt');
  }

  // Capitalize the key
  const key = shortcut.key.length === 1
    ? shortcut.key.toUpperCase()
    : shortcut.key.charAt(0).toUpperCase() + shortcut.key.slice(1);
  parts.push(key);

  return parts.join(isMac ? '' : '+');
}

/**
 * Hook to check if user is currently typing in an input field
 * Keyboard shortcuts should generally be disabled when typing
 */
export function useIsTyping(): boolean {
  const isTypingRef = useRef(false);

  useEffect(() => {
    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.contentEditable === 'true'
      ) {
        isTypingRef.current = true;
      }
    };

    const handleFocusOut = () => {
      isTypingRef.current = false;
    };

    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('focusout', handleFocusOut);

    return () => {
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('focusout', handleFocusOut);
    };
  }, []);

  return isTypingRef.current;
}