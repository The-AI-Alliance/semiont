import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { render } from '@testing-library/react';
import { useRovingTabIndex } from '../useRovingTabIndex';
import { KeyboardEvent as ReactKeyboardEvent } from 'react';

describe('useRovingTabIndex', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('Basic Functionality', () => {
    it('should return containerRef and handleKeyDown', () => {
      const { result } = renderHook(() => useRovingTabIndex(3));

      expect(result.current).toHaveProperty('containerRef');
      expect(result.current).toHaveProperty('handleKeyDown');
      expect(result.current).toHaveProperty('focusItem');
      expect(typeof result.current.handleKeyDown).toBe('function');
      expect(typeof result.current.focusItem).toBe('function');
    });

    it('should initialize with containerRef', () => {
      const { result } = renderHook(() => useRovingTabIndex(3));

      expect(result.current.containerRef.current).toBeNull();
    });
  });

  describe('Horizontal Orientation', () => {
    it('should navigate right with ArrowRight', () => {
      const { result } = renderHook(() =>
        useRovingTabIndex(3, { orientation: 'horizontal' })
      );

      // Create container with buttons
      const container = document.createElement('div');
      const buttons = [
        document.createElement('button'),
        document.createElement('button'),
        document.createElement('button'),
      ];
      buttons.forEach((btn, i) => {
        btn.setAttribute('role', 'button');
        btn.textContent = `Button ${i}`;
        container.appendChild(btn);
      });
      document.body.appendChild(container);

      // Set the ref
      (result.current.containerRef as any).current = container;

      // Initialize tabindex
      buttons.forEach((btn, i) => {
        btn.setAttribute('tabindex', i === 0 ? '0' : '-1');
      });

      // Simulate ArrowRight
      const event = {
        key: 'ArrowRight',
        preventDefault: vi.fn(),
      } as unknown as ReactKeyboardEvent;

      result.current.handleKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(buttons[1].getAttribute('tabindex')).toBe('0');
      expect(buttons[0].getAttribute('tabindex')).toBe('-1');
      expect(buttons[2].getAttribute('tabindex')).toBe('-1');
    });

    it('should navigate left with ArrowLeft', () => {
      const { result } = renderHook(() =>
        useRovingTabIndex(3, { orientation: 'horizontal' })
      );

      const container = document.createElement('div');
      const buttons = [
        document.createElement('button'),
        document.createElement('button'),
        document.createElement('button'),
      ];
      buttons.forEach((btn) => {
        btn.setAttribute('role', 'button');
        container.appendChild(btn);
      });
      document.body.appendChild(container);

      (result.current.containerRef as any).current = container;

      // Start at index 1
      buttons.forEach((btn, i) => {
        btn.setAttribute('tabindex', i === 1 ? '0' : '-1');
      });

      const event = {
        key: 'ArrowLeft',
        preventDefault: vi.fn(),
      } as unknown as ReactKeyboardEvent;

      result.current.handleKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(buttons[0].getAttribute('tabindex')).toBe('0');
      expect(buttons[1].getAttribute('tabindex')).toBe('-1');
    });

    it('should not navigate with ArrowDown in horizontal mode', () => {
      const { result } = renderHook(() =>
        useRovingTabIndex(3, { orientation: 'horizontal' })
      );

      const container = document.createElement('div');
      const buttons = [
        document.createElement('button'),
        document.createElement('button'),
      ];
      buttons.forEach((btn) => {
        btn.setAttribute('role', 'button');
        container.appendChild(btn);
      });
      document.body.appendChild(container);

      (result.current.containerRef as any).current = container;
      buttons[0].setAttribute('tabindex', '0');
      buttons[1].setAttribute('tabindex', '-1');

      const event = {
        key: 'ArrowDown',
        preventDefault: vi.fn(),
      } as unknown as ReactKeyboardEvent;

      result.current.handleKeyDown(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(buttons[0].getAttribute('tabindex')).toBe('0');
    });
  });

  describe('Vertical Orientation', () => {
    it('should navigate down with ArrowDown', () => {
      const { result } = renderHook(() =>
        useRovingTabIndex(3, { orientation: 'vertical' })
      );

      const container = document.createElement('div');
      const buttons = [
        document.createElement('button'),
        document.createElement('button'),
        document.createElement('button'),
      ];
      buttons.forEach((btn) => {
        btn.setAttribute('role', 'button');
        container.appendChild(btn);
      });
      document.body.appendChild(container);

      (result.current.containerRef as any).current = container;
      buttons.forEach((btn, i) => {
        btn.setAttribute('tabindex', i === 0 ? '0' : '-1');
      });

      const event = {
        key: 'ArrowDown',
        preventDefault: vi.fn(),
      } as unknown as ReactKeyboardEvent;

      result.current.handleKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(buttons[1].getAttribute('tabindex')).toBe('0');
      expect(buttons[0].getAttribute('tabindex')).toBe('-1');
    });

    it('should navigate up with ArrowUp', () => {
      const { result } = renderHook(() =>
        useRovingTabIndex(3, { orientation: 'vertical' })
      );

      const container = document.createElement('div');
      const buttons = [
        document.createElement('button'),
        document.createElement('button'),
        document.createElement('button'),
      ];
      buttons.forEach((btn) => {
        btn.setAttribute('role', 'button');
        container.appendChild(btn);
      });
      document.body.appendChild(container);

      (result.current.containerRef as any).current = container;
      buttons.forEach((btn, i) => {
        btn.setAttribute('tabindex', i === 1 ? '0' : '-1');
      });

      const event = {
        key: 'ArrowUp',
        preventDefault: vi.fn(),
      } as unknown as ReactKeyboardEvent;

      result.current.handleKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(buttons[0].getAttribute('tabindex')).toBe('0');
      expect(buttons[1].getAttribute('tabindex')).toBe('-1');
    });

    it('should not navigate with ArrowRight in vertical mode', () => {
      const { result } = renderHook(() =>
        useRovingTabIndex(3, { orientation: 'vertical' })
      );

      const container = document.createElement('div');
      const buttons = [
        document.createElement('button'),
        document.createElement('button'),
      ];
      buttons.forEach((btn) => {
        btn.setAttribute('role', 'button');
        container.appendChild(btn);
      });
      document.body.appendChild(container);

      (result.current.containerRef as any).current = container;
      buttons[0].setAttribute('tabindex', '0');
      buttons[1].setAttribute('tabindex', '-1');

      const event = {
        key: 'ArrowRight',
        preventDefault: vi.fn(),
      } as unknown as ReactKeyboardEvent;

      result.current.handleKeyDown(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(buttons[0].getAttribute('tabindex')).toBe('0');
    });
  });

  describe('Grid Orientation', () => {
    it('should navigate right with ArrowRight in grid', () => {
      const { result } = renderHook(() =>
        useRovingTabIndex(6, { orientation: 'grid', cols: 3 })
      );

      const container = document.createElement('div');
      const buttons = Array.from({ length: 6 }, () => document.createElement('button'));
      buttons.forEach((btn) => {
        btn.setAttribute('role', 'button');
        container.appendChild(btn);
      });
      document.body.appendChild(container);

      (result.current.containerRef as any).current = container;
      buttons.forEach((btn, i) => {
        btn.setAttribute('tabindex', i === 0 ? '0' : '-1');
      });

      const event = {
        key: 'ArrowRight',
        preventDefault: vi.fn(),
      } as unknown as ReactKeyboardEvent;

      result.current.handleKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(buttons[1].getAttribute('tabindex')).toBe('0');
      expect(buttons[0].getAttribute('tabindex')).toBe('-1');
    });

    it('should navigate down with ArrowDown in grid', () => {
      const { result } = renderHook(() =>
        useRovingTabIndex(6, { orientation: 'grid', cols: 3 })
      );

      const container = document.createElement('div');
      const buttons = Array.from({ length: 6 }, () => document.createElement('button'));
      buttons.forEach((btn) => {
        btn.setAttribute('role', 'button');
        container.appendChild(btn);
      });
      document.body.appendChild(container);

      (result.current.containerRef as any).current = container;
      buttons.forEach((btn, i) => {
        btn.setAttribute('tabindex', i === 0 ? '0' : '-1');
      });

      const event = {
        key: 'ArrowDown',
        preventDefault: vi.fn(),
      } as unknown as ReactKeyboardEvent;

      result.current.handleKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(buttons[3].getAttribute('tabindex')).toBe('0');
      expect(buttons[0].getAttribute('tabindex')).toBe('-1');
    });

    it('should navigate up by cols in grid', () => {
      const { result } = renderHook(() =>
        useRovingTabIndex(6, { orientation: 'grid', cols: 3 })
      );

      const container = document.createElement('div');
      const buttons = Array.from({ length: 6 }, () => document.createElement('button'));
      buttons.forEach((btn) => {
        btn.setAttribute('role', 'button');
        container.appendChild(btn);
      });
      document.body.appendChild(container);

      (result.current.containerRef as any).current = container;
      buttons.forEach((btn, i) => {
        btn.setAttribute('tabindex', i === 4 ? '0' : '-1');
      });

      const event = {
        key: 'ArrowUp',
        preventDefault: vi.fn(),
      } as unknown as ReactKeyboardEvent;

      result.current.handleKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(buttons[1].getAttribute('tabindex')).toBe('0');
      expect(buttons[4].getAttribute('tabindex')).toBe('-1');
    });
  });

  describe('Looping Behavior', () => {
    it('should loop to beginning when at end with loop=true', () => {
      const { result } = renderHook(() =>
        useRovingTabIndex(3, { orientation: 'horizontal', loop: true })
      );

      const container = document.createElement('div');
      const buttons = [
        document.createElement('button'),
        document.createElement('button'),
        document.createElement('button'),
      ];
      buttons.forEach((btn) => {
        btn.setAttribute('role', 'button');
        container.appendChild(btn);
      });
      document.body.appendChild(container);

      (result.current.containerRef as any).current = container;

      // Focus on item using focusItem
      result.current.focusItem(2);

      const event = {
        key: 'ArrowRight',
        preventDefault: vi.fn(),
      } as unknown as ReactKeyboardEvent;

      result.current.handleKeyDown(event);

      expect(buttons[0].getAttribute('tabindex')).toBe('0');
      expect(buttons[2].getAttribute('tabindex')).toBe('-1');
    });

    it('should loop to end when at beginning with loop=true', () => {
      const { result } = renderHook(() =>
        useRovingTabIndex(3, { orientation: 'horizontal', loop: true })
      );

      const container = document.createElement('div');
      const buttons = [
        document.createElement('button'),
        document.createElement('button'),
        document.createElement('button'),
      ];
      buttons.forEach((btn) => {
        btn.setAttribute('role', 'button');
        container.appendChild(btn);
      });
      document.body.appendChild(container);

      (result.current.containerRef as any).current = container;
      buttons.forEach((btn, i) => {
        btn.setAttribute('tabindex', i === 0 ? '0' : '-1');
      });

      const event = {
        key: 'ArrowLeft',
        preventDefault: vi.fn(),
      } as unknown as ReactKeyboardEvent;

      result.current.handleKeyDown(event);

      expect(buttons[2].getAttribute('tabindex')).toBe('0');
      expect(buttons[0].getAttribute('tabindex')).toBe('-1');
    });

    it('should not loop when loop=false', () => {
      const { result } = renderHook(() =>
        useRovingTabIndex(3, { orientation: 'horizontal', loop: false })
      );

      const container = document.createElement('div');
      const buttons = [
        document.createElement('button'),
        document.createElement('button'),
        document.createElement('button'),
      ];
      buttons.forEach((btn) => {
        btn.setAttribute('role', 'button');
        container.appendChild(btn);
      });
      document.body.appendChild(container);

      (result.current.containerRef as any).current = container;

      // Focus on last item
      result.current.focusItem(2);

      const event = {
        key: 'ArrowRight',
        preventDefault: vi.fn(),
      } as unknown as ReactKeyboardEvent;

      result.current.handleKeyDown(event);

      // Should stay at index 2
      expect(buttons[2].getAttribute('tabindex')).toBe('0');
      expect(buttons[0].getAttribute('tabindex')).toBe('-1');
    });
  });

  describe('Home and End Keys', () => {
    it('should navigate to first item with Home', () => {
      const { result } = renderHook(() => useRovingTabIndex(3));

      const container = document.createElement('div');
      const buttons = [
        document.createElement('button'),
        document.createElement('button'),
        document.createElement('button'),
      ];
      buttons.forEach((btn) => {
        btn.setAttribute('role', 'button');
        container.appendChild(btn);
      });
      document.body.appendChild(container);

      (result.current.containerRef as any).current = container;
      buttons.forEach((btn, i) => {
        btn.setAttribute('tabindex', i === 2 ? '0' : '-1');
      });

      const event = {
        key: 'Home',
        preventDefault: vi.fn(),
      } as unknown as ReactKeyboardEvent;

      result.current.handleKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(buttons[0].getAttribute('tabindex')).toBe('0');
      expect(buttons[2].getAttribute('tabindex')).toBe('-1');
    });

    it('should navigate to last item with End', () => {
      const { result } = renderHook(() => useRovingTabIndex(3));

      const container = document.createElement('div');
      const buttons = [
        document.createElement('button'),
        document.createElement('button'),
        document.createElement('button'),
      ];
      buttons.forEach((btn) => {
        btn.setAttribute('role', 'button');
        container.appendChild(btn);
      });
      document.body.appendChild(container);

      (result.current.containerRef as any).current = container;
      buttons.forEach((btn, i) => {
        btn.setAttribute('tabindex', i === 0 ? '0' : '-1');
      });

      const event = {
        key: 'End',
        preventDefault: vi.fn(),
      } as unknown as ReactKeyboardEvent;

      result.current.handleKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(buttons[2].getAttribute('tabindex')).toBe('0');
      expect(buttons[0].getAttribute('tabindex')).toBe('-1');
    });
  });

  describe('focusItem Function', () => {
    it('should focus specific item by index', () => {
      const { result } = renderHook(() => useRovingTabIndex(3));

      const container = document.createElement('div');
      const buttons = [
        document.createElement('button'),
        document.createElement('button'),
        document.createElement('button'),
      ];
      buttons.forEach((btn) => {
        btn.setAttribute('role', 'button');
        container.appendChild(btn);
      });
      document.body.appendChild(container);

      (result.current.containerRef as any).current = container;

      result.current.focusItem(1);

      expect(buttons[0].getAttribute('tabindex')).toBe('-1');
      expect(buttons[1].getAttribute('tabindex')).toBe('0');
      expect(buttons[2].getAttribute('tabindex')).toBe('-1');
    });

    it('should clamp index to bounds when loop=false', () => {
      const { result } = renderHook(() => useRovingTabIndex(3, { loop: false }));

      const container = document.createElement('div');
      const buttons = [
        document.createElement('button'),
        document.createElement('button'),
        document.createElement('button'),
      ];
      buttons.forEach((btn) => {
        btn.setAttribute('role', 'button');
        container.appendChild(btn);
      });
      document.body.appendChild(container);

      (result.current.containerRef as any).current = container;

      result.current.focusItem(10);

      expect(buttons[2].getAttribute('tabindex')).toBe('0');
      expect(buttons[0].getAttribute('tabindex')).toBe('-1');
      expect(buttons[1].getAttribute('tabindex')).toBe('-1');
    });

    it('should wrap index when loop=true', () => {
      const { result } = renderHook(() => useRovingTabIndex(3, { loop: true }));

      const container = document.createElement('div');
      const buttons = [
        document.createElement('button'),
        document.createElement('button'),
        document.createElement('button'),
      ];
      buttons.forEach((btn) => {
        btn.setAttribute('role', 'button');
        container.appendChild(btn);
      });
      document.body.appendChild(container);

      (result.current.containerRef as any).current = container;

      result.current.focusItem(4); // 4 % 3 = 1

      expect(buttons[1].getAttribute('tabindex')).toBe('0');
      expect(buttons[0].getAttribute('tabindex')).toBe('-1');
      expect(buttons[2].getAttribute('tabindex')).toBe('-1');
    });

    it('should handle negative indices with loop=true', () => {
      const { result } = renderHook(() => useRovingTabIndex(3, { loop: true }));

      const container = document.createElement('div');
      const buttons = [
        document.createElement('button'),
        document.createElement('button'),
        document.createElement('button'),
      ];
      buttons.forEach((btn) => {
        btn.setAttribute('role', 'button');
        container.appendChild(btn);
      });
      document.body.appendChild(container);

      (result.current.containerRef as any).current = container;

      result.current.focusItem(-1);

      expect(buttons[2].getAttribute('tabindex')).toBe('0');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty container gracefully', () => {
      const { result } = renderHook(() => useRovingTabIndex(0));

      const container = document.createElement('div');
      document.body.appendChild(container);

      (result.current.containerRef as any).current = container;

      expect(() => result.current.focusItem(0)).not.toThrow();

      const event = {
        key: 'ArrowRight',
        preventDefault: vi.fn(),
      } as unknown as ReactKeyboardEvent;

      expect(() => result.current.handleKeyDown(event)).not.toThrow();
    });

    it('should handle container without ref', () => {
      const { result } = renderHook(() => useRovingTabIndex(3));

      const event = {
        key: 'ArrowRight',
        preventDefault: vi.fn(),
      } as unknown as ReactKeyboardEvent;

      expect(() => result.current.handleKeyDown(event)).not.toThrow();
    });

    it('should handle unknown keys', () => {
      const { result } = renderHook(() => useRovingTabIndex(3));

      const container = document.createElement('div');
      const button = document.createElement('button');
      button.setAttribute('role', 'button');
      container.appendChild(button);
      document.body.appendChild(container);

      (result.current.containerRef as any).current = container;

      const event = {
        key: 'a',
        preventDefault: vi.fn(),
      } as unknown as ReactKeyboardEvent;

      result.current.handleKeyDown(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('should update when itemCount changes', () => {
      const { result, rerender } = renderHook(
        ({ count }) => useRovingTabIndex(count),
        { initialProps: { count: 2 } }
      );

      const container = document.createElement('div');
      let buttons = [
        document.createElement('button'),
        document.createElement('button'),
      ];
      buttons.forEach((btn) => {
        btn.setAttribute('role', 'button');
        container.appendChild(btn);
      });
      document.body.appendChild(container);

      (result.current.containerRef as any).current = container;

      // Add a third button
      const newButton = document.createElement('button');
      newButton.setAttribute('role', 'button');
      container.appendChild(newButton);

      rerender({ count: 3 });

      // Should handle 3 items now
      result.current.focusItem(2);
      expect(container.children[2].getAttribute('tabindex')).toBe('0');
    });
  });

  describe('Click Handling', () => {
    it('should update tabindex when item is clicked', () => {
      const { result } = renderHook(() => useRovingTabIndex(3));

      const container = document.createElement('div');
      const buttons = [
        document.createElement('button'),
        document.createElement('button'),
        document.createElement('button'),
      ];
      buttons.forEach((btn) => {
        btn.setAttribute('role', 'button');
        container.appendChild(btn);
      });
      document.body.appendChild(container);

      (result.current.containerRef as any).current = container;

      // Initialize
      buttons.forEach((btn, i) => {
        btn.setAttribute('tabindex', i === 0 ? '0' : '-1');
      });

      // Simulate clicking the second button
      buttons[1].click();

      expect(buttons[1].getAttribute('tabindex')).toBe('0');
      expect(buttons[0].getAttribute('tabindex')).toBe('-1');
      expect(buttons[2].getAttribute('tabindex')).toBe('-1');
    });
  });

  describe('Different Element Types', () => {
    it('should work with elements with tabindex attribute', () => {
      const { result } = renderHook(() => useRovingTabIndex(3));

      const container = document.createElement('div');
      const divs = [
        document.createElement('div'),
        document.createElement('div'),
        document.createElement('div'),
      ];
      divs.forEach((div) => {
        div.setAttribute('tabindex', '0');
        container.appendChild(div);
      });
      document.body.appendChild(container);

      (result.current.containerRef as any).current = container;

      result.current.focusItem(1);

      expect(divs[0].getAttribute('tabindex')).toBe('-1');
      expect(divs[1].getAttribute('tabindex')).toBe('0');
      expect(divs[2].getAttribute('tabindex')).toBe('-1');
    });

    it('should work with role="button" elements', () => {
      const { result } = renderHook(() => useRovingTabIndex(3));

      const container = document.createElement('div');
      const items = [
        document.createElement('span'),
        document.createElement('span'),
        document.createElement('span'),
      ];
      items.forEach((item) => {
        item.setAttribute('role', 'button');
        container.appendChild(item);
      });
      document.body.appendChild(container);

      (result.current.containerRef as any).current = container;

      result.current.focusItem(1);

      expect(items[1].getAttribute('tabindex')).toBe('0');
    });

    it('should filter out disabled buttons', () => {
      const { result } = renderHook(() => useRovingTabIndex(3));

      const container = document.createElement('div');
      const buttons = [
        document.createElement('button'),
        document.createElement('button'),
        document.createElement('button'),
      ];
      buttons.forEach((btn) => {
        btn.setAttribute('role', 'button');
        container.appendChild(btn);
      });
      // Disable second button
      buttons[1].setAttribute('disabled', 'true');
      document.body.appendChild(container);

      (result.current.containerRef as any).current = container;

      // Should only find 2 focusable items (0 and 2)
      result.current.focusItem(0);
      expect(buttons[0].getAttribute('tabindex')).toBe('0');
    });
  });
});
