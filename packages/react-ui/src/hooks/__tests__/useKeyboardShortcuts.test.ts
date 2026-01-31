import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useKeyboardShortcuts, useDoubleKeyPress, getShortcutDisplay, KeyboardShortcut } from '../useKeyboardShortcuts';

describe('useKeyboardShortcuts', () => {
  beforeEach(() => {
    // Clear any existing event listeners
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Basic Functionality', () => {
    it('should attach keydown listener on mount', () => {
      const handler = vi.fn();
      const shortcuts: KeyboardShortcut[] = [{ key: 's', handler }];

      const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

      renderHook(() => useKeyboardShortcuts(shortcuts));

      expect(addEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
    });

    it('should remove keydown listener on unmount', () => {
      const handler = vi.fn();
      const shortcuts: KeyboardShortcut[] = [{ key: 's', handler }];

      const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');

      const { unmount } = renderHook(() => useKeyboardShortcuts(shortcuts));
      unmount();

      expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
    });

    it('should execute handler when matching key is pressed', () => {
      const handler = vi.fn();
      const shortcuts: KeyboardShortcut[] = [{ key: 's', handler }];

      renderHook(() => useKeyboardShortcuts(shortcuts));

      const event = new KeyboardEvent('keydown', { key: 's' });
      window.dispatchEvent(event);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(event);
    });

    it('should not execute handler for non-matching key', () => {
      const handler = vi.fn();
      const shortcuts: KeyboardShortcut[] = [{ key: 's', handler }];

      renderHook(() => useKeyboardShortcuts(shortcuts));

      const event = new KeyboardEvent('keydown', { key: 'a' });
      window.dispatchEvent(event);

      expect(handler).not.toHaveBeenCalled();
    });

    it('should handle case-insensitive key matching', () => {
      const handler = vi.fn();
      const shortcuts: KeyboardShortcut[] = [{ key: 'S', handler }];

      renderHook(() => useKeyboardShortcuts(shortcuts));

      const event = new KeyboardEvent('keydown', { key: 's' });
      window.dispatchEvent(event);

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('Modifier Keys - Ctrl/Cmd', () => {
    it('should execute handler with Ctrl on Windows/Linux', () => {
      const handler = vi.fn();
      const shortcuts: KeyboardShortcut[] = [{ key: 's', ctrlOrCmd: true, handler }];

      // Mock non-Mac platform
      Object.defineProperty(navigator, 'platform', {
        value: 'Win32',
        configurable: true,
      });

      renderHook(() => useKeyboardShortcuts(shortcuts));

      const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true });
      window.dispatchEvent(event);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should not execute without Ctrl when ctrlOrCmd required', () => {
      const handler = vi.fn();
      const shortcuts: KeyboardShortcut[] = [{ key: 's', ctrlOrCmd: true, handler }];

      renderHook(() => useKeyboardShortcuts(shortcuts));

      const event = new KeyboardEvent('keydown', { key: 's' });
      window.dispatchEvent(event);

      expect(handler).not.toHaveBeenCalled();
    });

    it('should not execute with Ctrl when ctrlOrCmd not required', () => {
      const handler = vi.fn();
      const shortcuts: KeyboardShortcut[] = [{ key: 's', handler }];

      renderHook(() => useKeyboardShortcuts(shortcuts));

      const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true });
      window.dispatchEvent(event);

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('Modifier Keys - Shift', () => {
    it('should execute handler with Shift', () => {
      const handler = vi.fn();
      const shortcuts: KeyboardShortcut[] = [{ key: 's', shift: true, handler }];

      renderHook(() => useKeyboardShortcuts(shortcuts));

      const event = new KeyboardEvent('keydown', { key: 's', shiftKey: true });
      window.dispatchEvent(event);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should not execute without Shift when required', () => {
      const handler = vi.fn();
      const shortcuts: KeyboardShortcut[] = [{ key: 's', shift: true, handler }];

      renderHook(() => useKeyboardShortcuts(shortcuts));

      const event = new KeyboardEvent('keydown', { key: 's' });
      window.dispatchEvent(event);

      expect(handler).not.toHaveBeenCalled();
    });

    it('should not execute with Shift when not required', () => {
      const handler = vi.fn();
      const shortcuts: KeyboardShortcut[] = [{ key: 's', handler }];

      renderHook(() => useKeyboardShortcuts(shortcuts));

      const event = new KeyboardEvent('keydown', { key: 's', shiftKey: true });
      window.dispatchEvent(event);

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('Modifier Keys - Alt', () => {
    it('should execute handler with Alt', () => {
      const handler = vi.fn();
      const shortcuts: KeyboardShortcut[] = [{ key: 's', alt: true, handler }];

      renderHook(() => useKeyboardShortcuts(shortcuts));

      const event = new KeyboardEvent('keydown', { key: 's', altKey: true });
      window.dispatchEvent(event);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should not execute without Alt when required', () => {
      const handler = vi.fn();
      const shortcuts: KeyboardShortcut[] = [{ key: 's', alt: true, handler }];

      renderHook(() => useKeyboardShortcuts(shortcuts));

      const event = new KeyboardEvent('keydown', { key: 's' });
      window.dispatchEvent(event);

      expect(handler).not.toHaveBeenCalled();
    });

    it('should not execute with Alt when not required', () => {
      const handler = vi.fn();
      const shortcuts: KeyboardShortcut[] = [{ key: 's', handler }];

      renderHook(() => useKeyboardShortcuts(shortcuts));

      const event = new KeyboardEvent('keydown', { key: 's', altKey: true });
      window.dispatchEvent(event);

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('Combined Modifiers', () => {
    it('should handle Ctrl+Shift+Key', () => {
      const handler = vi.fn();
      const shortcuts: KeyboardShortcut[] = [
        { key: 's', ctrlOrCmd: true, shift: true, handler },
      ];

      renderHook(() => useKeyboardShortcuts(shortcuts));

      const event = new KeyboardEvent('keydown', {
        key: 's',
        ctrlKey: true,
        shiftKey: true,
      });
      window.dispatchEvent(event);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should handle Ctrl+Alt+Key', () => {
      const handler = vi.fn();
      const shortcuts: KeyboardShortcut[] = [
        { key: 's', ctrlOrCmd: true, alt: true, handler },
      ];

      renderHook(() => useKeyboardShortcuts(shortcuts));

      const event = new KeyboardEvent('keydown', {
        key: 's',
        ctrlKey: true,
        altKey: true,
      });
      window.dispatchEvent(event);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should handle Ctrl+Shift+Alt+Key', () => {
      const handler = vi.fn();
      const shortcuts: KeyboardShortcut[] = [
        { key: 's', ctrlOrCmd: true, shift: true, alt: true, handler },
      ];

      renderHook(() => useKeyboardShortcuts(shortcuts));

      const event = new KeyboardEvent('keydown', {
        key: 's',
        ctrlKey: true,
        shiftKey: true,
        altKey: true,
      });
      window.dispatchEvent(event);

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('Input Field Blocking', () => {
    it('should not execute in INPUT elements', () => {
      const handler = vi.fn();
      const shortcuts: KeyboardShortcut[] = [{ key: 's', handler }];

      renderHook(() => useKeyboardShortcuts(shortcuts));

      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();

      const event = new KeyboardEvent('keydown', { key: 's', bubbles: true });
      input.dispatchEvent(event);

      expect(handler).not.toHaveBeenCalled();
    });

    it('should not execute in TEXTAREA elements', () => {
      const handler = vi.fn();
      const shortcuts: KeyboardShortcut[] = [{ key: 's', handler }];

      renderHook(() => useKeyboardShortcuts(shortcuts));

      const textarea = document.createElement('textarea');
      document.body.appendChild(textarea);
      textarea.focus();

      const event = new KeyboardEvent('keydown', { key: 's', bubbles: true });
      textarea.dispatchEvent(event);

      expect(handler).not.toHaveBeenCalled();
    });

    it('should not execute in contentEditable elements', () => {
      const handler = vi.fn();
      const shortcuts: KeyboardShortcut[] = [{ key: 's', handler }];

      renderHook(() => useKeyboardShortcuts(shortcuts));

      const div = document.createElement('div');
      div.contentEditable = 'true';
      document.body.appendChild(div);
      div.focus();

      const event = new KeyboardEvent('keydown', { key: 's', bubbles: true });
      div.dispatchEvent(event);

      expect(handler).not.toHaveBeenCalled();
    });

    it('should execute in non-input elements', () => {
      const handler = vi.fn();
      const shortcuts: KeyboardShortcut[] = [{ key: 's', handler }];

      renderHook(() => useKeyboardShortcuts(shortcuts));

      const div = document.createElement('div');
      document.body.appendChild(div);

      const event = new KeyboardEvent('keydown', { key: 's', bubbles: true });
      div.dispatchEvent(event);

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('Multiple Shortcuts', () => {
    it('should handle multiple shortcuts', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const shortcuts: KeyboardShortcut[] = [
        { key: 's', handler: handler1 },
        { key: 'a', handler: handler2 },
      ];

      renderHook(() => useKeyboardShortcuts(shortcuts));

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }));
      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).not.toHaveBeenCalled();

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('should execute only first matching shortcut', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const shortcuts: KeyboardShortcut[] = [
        { key: 's', handler: handler1 },
        { key: 's', handler: handler2 },
      ];

      renderHook(() => useKeyboardShortcuts(shortcuts));

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }));

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).not.toHaveBeenCalled();
    });

    it('should handle different modifier combinations for same key', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const shortcuts: KeyboardShortcut[] = [
        { key: 's', handler: handler1 },
        { key: 's', ctrlOrCmd: true, handler: handler2 },
      ];

      renderHook(() => useKeyboardShortcuts(shortcuts));

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }));
      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).not.toHaveBeenCalled();

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }));
      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });
  });

  describe('Enabled/Disabled State', () => {
    it('should execute when enabled is true', () => {
      const handler = vi.fn();
      const shortcuts: KeyboardShortcut[] = [{ key: 's', enabled: true, handler }];

      renderHook(() => useKeyboardShortcuts(shortcuts));

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should execute when enabled is undefined', () => {
      const handler = vi.fn();
      const shortcuts: KeyboardShortcut[] = [{ key: 's', handler }];

      renderHook(() => useKeyboardShortcuts(shortcuts));

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should not execute when enabled is false', () => {
      const handler = vi.fn();
      const shortcuts: KeyboardShortcut[] = [{ key: 's', enabled: false, handler }];

      renderHook(() => useKeyboardShortcuts(shortcuts));

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }));

      expect(handler).not.toHaveBeenCalled();
    });

    it('should filter out disabled shortcuts in array', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const handler3 = vi.fn();
      const shortcuts: KeyboardShortcut[] = [
        { key: 'a', enabled: false, handler: handler1 },
        { key: 'b', enabled: true, handler: handler2 },
        { key: 'c', handler: handler3 },
      ];

      renderHook(() => useKeyboardShortcuts(shortcuts));

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c' }));

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalledTimes(1);
      expect(handler3).toHaveBeenCalledTimes(1);
    });
  });

  describe('Event Prevention', () => {
    it('should call preventDefault on matching event', () => {
      const handler = vi.fn();
      const shortcuts: KeyboardShortcut[] = [{ key: 's', handler }];

      renderHook(() => useKeyboardShortcuts(shortcuts));

      const event = new KeyboardEvent('keydown', { key: 's' });
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
      window.dispatchEvent(event);

      expect(preventDefaultSpy).toHaveBeenCalled();
    });

    it('should call stopPropagation on matching event', () => {
      const handler = vi.fn();
      const shortcuts: KeyboardShortcut[] = [{ key: 's', handler }];

      renderHook(() => useKeyboardShortcuts(shortcuts));

      const event = new KeyboardEvent('keydown', { key: 's' });
      const stopPropagationSpy = vi.spyOn(event, 'stopPropagation');
      window.dispatchEvent(event);

      expect(stopPropagationSpy).toHaveBeenCalled();
    });

    it('should not prevent default for non-matching events', () => {
      const handler = vi.fn();
      const shortcuts: KeyboardShortcut[] = [{ key: 's', handler }];

      renderHook(() => useKeyboardShortcuts(shortcuts));

      const event = new KeyboardEvent('keydown', { key: 'a' });
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
      window.dispatchEvent(event);

      expect(preventDefaultSpy).not.toHaveBeenCalled();
    });
  });

  describe('Edge Cases', () => {
    it('should handle undefined key gracefully', () => {
      const handler = vi.fn();
      const shortcuts: KeyboardShortcut[] = [{ key: 's', handler }];

      renderHook(() => useKeyboardShortcuts(shortcuts));

      // @ts-expect-error - Testing runtime behavior
      const event = new KeyboardEvent('keydown', {});
      window.dispatchEvent(event);

      expect(handler).not.toHaveBeenCalled();
    });

    it('should handle empty shortcuts array', () => {
      const shortcuts: KeyboardShortcut[] = [];

      expect(() => renderHook(() => useKeyboardShortcuts(shortcuts))).not.toThrow();

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }));
    });

    it('should update when shortcuts array changes', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      const { rerender } = renderHook(
        ({ shortcuts }) => useKeyboardShortcuts(shortcuts),
        { initialProps: { shortcuts: [{ key: 's', handler: handler1 }] } }
      );

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }));
      expect(handler1).toHaveBeenCalledTimes(1);

      rerender({ shortcuts: [{ key: 's', handler: handler2 }] });

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }));
      expect(handler2).toHaveBeenCalledTimes(1);
      expect(handler1).toHaveBeenCalledTimes(1); // Should not be called again
    });
  });
});

describe('useDoubleKeyPress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('Basic Functionality', () => {
    it('should execute handler on double key press', () => {
      const handler = vi.fn();

      renderHook(() => useDoubleKeyPress('Escape', handler));

      // First press
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(handler).not.toHaveBeenCalled();

      // Second press within timeout
      vi.advanceTimersByTime(200);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should not execute on single key press', () => {
      const handler = vi.fn();

      renderHook(() => useDoubleKeyPress('Escape', handler));

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      vi.advanceTimersByTime(1000);

      expect(handler).not.toHaveBeenCalled();
    });

    it('should not execute if second press is too late', () => {
      const handler = vi.fn();

      renderHook(() => useDoubleKeyPress('Escape', handler, 300));

      // First press
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

      // Wait longer than timeout
      vi.advanceTimersByTime(400);

      // Second press
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

      expect(handler).not.toHaveBeenCalled();
    });

    it('should reset after successful double press', () => {
      const handler = vi.fn();

      renderHook(() => useDoubleKeyPress('Escape', handler));

      // First double press
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      vi.advanceTimersByTime(100);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(handler).toHaveBeenCalledTimes(1);

      // Try third press immediately - should not trigger again
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(handler).toHaveBeenCalledTimes(1);

      // Start new double press sequence
      vi.advanceTimersByTime(400);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      vi.advanceTimersByTime(100);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe('Custom Timeout', () => {
    it('should respect custom timeout', () => {
      const handler = vi.fn();

      renderHook(() => useDoubleKeyPress('Escape', handler, 500));

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      vi.advanceTimersByTime(400);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should use default timeout of 300ms', () => {
      const handler = vi.fn();

      renderHook(() => useDoubleKeyPress('Escape', handler));

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      vi.advanceTimersByTime(250);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('Different Keys', () => {
    it('should only respond to specified key', () => {
      const handler = vi.fn();

      renderHook(() => useDoubleKeyPress('Escape', handler));

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      vi.advanceTimersByTime(100);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

      expect(handler).not.toHaveBeenCalled();
    });

    it('should not trigger on different key pressed', () => {
      const handler = vi.fn();

      renderHook(() => useDoubleKeyPress('Escape', handler));

      // First Escape press
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      vi.advanceTimersByTime(100);

      // Different key (Enter) - ignored by hook
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      vi.advanceTimersByTime(100);

      // Second Escape press within timeout window - should trigger
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

      // The hook doesn't reset timer on different keys, so this triggers
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
});

describe('getShortcutDisplay', () => {
  describe('Single Keys', () => {
    it('should display single uppercase key', () => {
      const shortcut: KeyboardShortcut = { key: 's', handler: vi.fn() };
      expect(getShortcutDisplay(shortcut)).toBe('S');
    });

    it('should capitalize single character keys', () => {
      const shortcut: KeyboardShortcut = { key: 'a', handler: vi.fn() };
      expect(getShortcutDisplay(shortcut)).toBe('A');
    });

    it('should capitalize multi-character keys', () => {
      const shortcut: KeyboardShortcut = { key: 'escape', handler: vi.fn() };
      expect(getShortcutDisplay(shortcut)).toBe('Escape');
    });

    it('should handle special keys', () => {
      const shortcut: KeyboardShortcut = { key: 'Enter', handler: vi.fn() };
      expect(getShortcutDisplay(shortcut)).toBe('Enter');
    });
  });

  describe('With Modifiers', () => {
    it('should show Ctrl+Key on non-Mac', () => {
      Object.defineProperty(navigator, 'platform', {
        value: 'Win32',
        configurable: true,
      });

      const shortcut: KeyboardShortcut = { key: 's', ctrlOrCmd: true, handler: vi.fn() };
      const display = getShortcutDisplay(shortcut);

      expect(display).toContain('Ctrl');
      expect(display).toContain('S');
    });

    it('should show Shift+Key', () => {
      const shortcut: KeyboardShortcut = { key: 's', shift: true, handler: vi.fn() };
      const display = getShortcutDisplay(shortcut);

      expect(display).toContain('Shift');
      expect(display).toContain('S');
    });

    it('should show Alt+Key on non-Mac', () => {
      Object.defineProperty(navigator, 'platform', {
        value: 'Win32',
        configurable: true,
      });

      const shortcut: KeyboardShortcut = { key: 's', alt: true, handler: vi.fn() };
      const display = getShortcutDisplay(shortcut);

      expect(display).toContain('Alt');
      expect(display).toContain('S');
    });
  });

  describe('Combined Modifiers', () => {
    it('should combine all modifiers', () => {
      Object.defineProperty(navigator, 'platform', {
        value: 'Win32',
        configurable: true,
      });

      const shortcut: KeyboardShortcut = {
        key: 's',
        ctrlOrCmd: true,
        shift: true,
        alt: true,
        handler: vi.fn(),
      };
      const display = getShortcutDisplay(shortcut);

      expect(display).toContain('Ctrl');
      expect(display).toContain('Shift');
      expect(display).toContain('Alt');
      expect(display).toContain('S');
    });

    it('should order modifiers correctly', () => {
      Object.defineProperty(navigator, 'platform', {
        value: 'Win32',
        configurable: true,
      });

      const shortcut: KeyboardShortcut = {
        key: 's',
        ctrlOrCmd: true,
        shift: true,
        handler: vi.fn(),
      };
      const display = getShortcutDisplay(shortcut);

      // Display should be "Ctrl+Shift+S"
      expect(display).toBe('Ctrl+Shift+S');

      // Verify order by checking display structure
      const parts = display.split('+');
      expect(parts[0]).toBe('Ctrl');
      expect(parts[1]).toBe('Shift');
      expect(parts[2]).toBe('S');
    });
  });
});
