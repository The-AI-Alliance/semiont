import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useToolbar, ToolbarPanelType } from '../useToolbar';

describe('useToolbar', () => {
  // Mock localStorage
  let localStorageMock: { [key: string]: string } = {};

  beforeEach(() => {
    localStorageMock = {};

    // Mock localStorage methods
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: vi.fn((key: string) => localStorageMock[key] || null),
        setItem: vi.fn((key: string, value: string) => {
          localStorageMock[key] = value;
        }),
        removeItem: vi.fn((key: string) => {
          delete localStorageMock[key];
        }),
        clear: vi.fn(() => {
          localStorageMock = {};
        }),
      },
      writable: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Basic Functionality', () => {
    it('should initialize with null active panel by default', () => {
      const { result } = renderHook(() => useToolbar());

      expect(result.current.activePanel).toBeNull();
    });

    it('should initialize with provided initial panel', () => {
      const { result } = renderHook(() =>
        useToolbar({ initialPanel: 'document' })
      );

      expect(result.current.activePanel).toBe('document');
    });

    it('should toggle panel on', () => {
      const { result } = renderHook(() => useToolbar());

      act(() => {
        result.current.togglePanel('document');
      });

      expect(result.current.activePanel).toBe('document');
    });

    it('should toggle panel off when clicking same panel', () => {
      const { result } = renderHook(() => useToolbar());

      act(() => {
        result.current.togglePanel('document');
      });

      expect(result.current.activePanel).toBe('document');

      act(() => {
        result.current.togglePanel('document');
      });

      expect(result.current.activePanel).toBeNull();
    });

    it('should switch between different panels', () => {
      const { result } = renderHook(() => useToolbar());

      act(() => {
        result.current.togglePanel('document');
      });

      expect(result.current.activePanel).toBe('document');

      act(() => {
        result.current.togglePanel('history');
      });

      expect(result.current.activePanel).toBe('history');
    });
  });

  describe('All Panel Types', () => {
    const panelTypes: ToolbarPanelType[] = [
      'document',
      'history',
      'info',
      'annotations',
      'settings',
      'collaboration',
      'user',
      'jsonld',
    ];

    panelTypes.forEach((panelType) => {
      it(`should support ${panelType} panel`, () => {
        const { result } = renderHook(() => useToolbar());

        act(() => {
          result.current.togglePanel(panelType);
        });

        expect(result.current.activePanel).toBe(panelType);
      });
    });

    it('should switch between all panel types', () => {
      const { result } = renderHook(() => useToolbar());

      panelTypes.forEach((panelType) => {
        act(() => {
          result.current.togglePanel(panelType);
        });

        expect(result.current.activePanel).toBe(panelType);
      });
    });
  });

  describe('setActivePanel', () => {
    it('should set panel directly', () => {
      const { result } = renderHook(() => useToolbar());

      act(() => {
        result.current.setActivePanel('document');
      });

      expect(result.current.activePanel).toBe('document');
    });

    it('should set panel to null directly', () => {
      const { result } = renderHook(() =>
        useToolbar({ initialPanel: 'document' })
      );

      expect(result.current.activePanel).toBe('document');

      act(() => {
        result.current.setActivePanel(null);
      });

      expect(result.current.activePanel).toBeNull();
    });

    it('should override current panel', () => {
      const { result } = renderHook(() =>
        useToolbar({ initialPanel: 'document' })
      );

      act(() => {
        result.current.setActivePanel('history');
      });

      expect(result.current.activePanel).toBe('history');
    });

    it('should work independently from togglePanel', () => {
      const { result } = renderHook(() => useToolbar());

      // Use togglePanel first
      act(() => {
        result.current.togglePanel('document');
      });

      expect(result.current.activePanel).toBe('document');

      // Use setActivePanel
      act(() => {
        result.current.setActivePanel('history');
      });

      expect(result.current.activePanel).toBe('history');

      // togglePanel should still work
      act(() => {
        result.current.togglePanel('history');
      });

      expect(result.current.activePanel).toBeNull();
    });
  });

  describe('LocalStorage Persistence', () => {
    it('should not persist by default', () => {
      const { result } = renderHook(() => useToolbar());

      act(() => {
        result.current.togglePanel('document');
      });

      expect(window.localStorage.setItem).not.toHaveBeenCalled();
    });

    it('should persist when persistToStorage is true', () => {
      const { result } = renderHook(() =>
        useToolbar({ persistToStorage: true })
      );

      act(() => {
        result.current.togglePanel('document');
      });

      expect(window.localStorage.setItem).toHaveBeenCalledWith(
        'activeToolbarPanel',
        'document'
      );
    });

    it('should use custom storage key', () => {
      const { result } = renderHook(() =>
        useToolbar({ persistToStorage: true, storageKey: 'customKey' })
      );

      act(() => {
        result.current.togglePanel('document');
      });

      expect(window.localStorage.setItem).toHaveBeenCalledWith(
        'customKey',
        'document'
      );
    });

    it('should remove from storage when toggled off', () => {
      const { result } = renderHook(() =>
        useToolbar({ persistToStorage: true })
      );

      act(() => {
        result.current.togglePanel('document');
      });

      act(() => {
        result.current.togglePanel('document');
      });

      expect(window.localStorage.removeItem).toHaveBeenCalledWith(
        'activeToolbarPanel'
      );
    });

    it('should load from storage on initialization', () => {
      // Set storage before rendering hook
      localStorageMock['activeToolbarPanel'] = 'history';

      const { result } = renderHook(() =>
        useToolbar({ persistToStorage: true })
      );

      expect(result.current.activePanel).toBe('history');
    });

    it('should ignore invalid panel in storage', () => {
      // Set invalid panel in storage
      localStorageMock['activeToolbarPanel'] = 'invalid-panel';

      const { result } = renderHook(() =>
        useToolbar({ persistToStorage: true })
      );

      expect(result.current.activePanel).toBeNull();
    });

    it('should prefer initialPanel over storage when persistence disabled', () => {
      localStorageMock['activeToolbarPanel'] = 'history';

      const { result } = renderHook(() =>
        useToolbar({ initialPanel: 'document', persistToStorage: false })
      );

      expect(result.current.activePanel).toBe('document');
    });

    it('should prefer storage over initialPanel when persistence enabled', () => {
      localStorageMock['activeToolbarPanel'] = 'history';

      const { result } = renderHook(() =>
        useToolbar({ initialPanel: 'document', persistToStorage: true })
      );

      expect(result.current.activePanel).toBe('history');
    });

    it('should fall back to initialPanel if storage is empty', () => {
      const { result } = renderHook(() =>
        useToolbar({ initialPanel: 'document', persistToStorage: true })
      );

      expect(result.current.activePanel).toBe('document');
    });

    it('should update storage when switching panels', () => {
      const { result } = renderHook(() =>
        useToolbar({ persistToStorage: true })
      );

      act(() => {
        result.current.togglePanel('document');
      });

      expect(localStorageMock['activeToolbarPanel']).toBe('document');

      act(() => {
        result.current.togglePanel('history');
      });

      expect(localStorageMock['activeToolbarPanel']).toBe('history');
    });

    it('should not persist when using setActivePanel directly', () => {
      const { result } = renderHook(() =>
        useToolbar({ persistToStorage: true })
      );

      act(() => {
        result.current.setActivePanel('document');
      });

      // setActivePanel is the raw React setter, does not persist
      expect(localStorageMock['activeToolbarPanel']).toBeUndefined();
      expect(result.current.activePanel).toBe('document');
    });

    it('should not persist when using setActivePanel(null)', () => {
      const { result } = renderHook(() =>
        useToolbar({ persistToStorage: true, initialPanel: 'document' })
      );

      // First toggle to persist initial state
      act(() => {
        result.current.togglePanel('history');
      });

      expect(localStorageMock['activeToolbarPanel']).toBe('history');

      // setActivePanel doesn't affect localStorage
      act(() => {
        result.current.setActivePanel(null);
      });

      // localStorage should still have the last togglePanel value
      expect(localStorageMock['activeToolbarPanel']).toBe('history');
      expect(result.current.activePanel).toBeNull();
    });
  });

  describe('Edge Cases', () => {
    it('should handle rapid toggles', () => {
      const { result } = renderHook(() => useToolbar());

      act(() => {
        result.current.togglePanel('document');
        result.current.togglePanel('document');
        result.current.togglePanel('document');
      });

      expect(result.current.activePanel).toBe('document');
    });

    it('should handle rapid panel switches', () => {
      const { result } = renderHook(() => useToolbar());

      act(() => {
        result.current.togglePanel('document');
        result.current.togglePanel('history');
        result.current.togglePanel('info');
        result.current.togglePanel('annotations');
      });

      expect(result.current.activePanel).toBe('annotations');
    });

    it('should maintain state across rerenders', () => {
      const { result, rerender } = renderHook(() => useToolbar());

      act(() => {
        result.current.togglePanel('document');
      });

      rerender();

      expect(result.current.activePanel).toBe('document');
    });

    it('should handle options changes', () => {
      const { result, rerender } = renderHook(
        ({ options }) => useToolbar(options),
        { initialProps: { options: { persistToStorage: false } } }
      );

      act(() => {
        result.current.togglePanel('document');
      });

      expect(localStorageMock['activeToolbarPanel']).toBeUndefined();

      // Rerender with persistence enabled
      rerender({ options: { persistToStorage: true } });

      act(() => {
        result.current.togglePanel('history');
      });

      expect(localStorageMock['activeToolbarPanel']).toBe('history');
    });
  });

  describe('Consistency', () => {
    it('should have stable function references', () => {
      const { result, rerender } = renderHook(() => useToolbar());

      const initialToggle = result.current.togglePanel;
      const initialSet = result.current.setActivePanel;

      rerender();

      expect(result.current.togglePanel).toBe(initialToggle);
      expect(result.current.setActivePanel).toBe(initialSet);
    });

    it('should return consistent structure', () => {
      const { result } = renderHook(() => useToolbar());

      expect(result.current).toHaveProperty('activePanel');
      expect(result.current).toHaveProperty('togglePanel');
      expect(result.current).toHaveProperty('setActivePanel');
      expect(typeof result.current.togglePanel).toBe('function');
      expect(typeof result.current.setActivePanel).toBe('function');
    });
  });

  describe('Real-World Scenarios', () => {
    it('should handle user opening and closing panels', () => {
      const { result } = renderHook(() => useToolbar());

      // User opens document panel
      act(() => {
        result.current.togglePanel('document');
      });
      expect(result.current.activePanel).toBe('document');

      // User switches to annotations
      act(() => {
        result.current.togglePanel('annotations');
      });
      expect(result.current.activePanel).toBe('annotations');

      // User closes annotations
      act(() => {
        result.current.togglePanel('annotations');
      });
      expect(result.current.activePanel).toBeNull();
    });

    it('should persist user preference across sessions', () => {
      // First session
      const { result, unmount } = renderHook(() =>
        useToolbar({ persistToStorage: true })
      );

      act(() => {
        result.current.togglePanel('history');
      });

      expect(localStorageMock['activeToolbarPanel']).toBe('history');

      unmount();

      // Second session
      const { result: result2 } = renderHook(() =>
        useToolbar({ persistToStorage: true })
      );

      expect(result2.current.activePanel).toBe('history');
    });

    it('should handle keyboard shortcut setting panel directly', () => {
      const { result } = renderHook(() => useToolbar());

      // Simulate keyboard shortcut opening settings directly
      act(() => {
        result.current.setActivePanel('settings');
      });

      expect(result.current.activePanel).toBe('settings');
    });

    it('should handle modal closing all panels', () => {
      const { result } = renderHook(() =>
        useToolbar({ initialPanel: 'document' })
      );

      // Modal opens, needs to close all panels
      act(() => {
        result.current.setActivePanel(null);
      });

      expect(result.current.activePanel).toBeNull();
    });
  });

  describe('Type Safety', () => {
    it('should accept all valid panel types', () => {
      const { result } = renderHook(() => useToolbar());

      const validPanels: ToolbarPanelType[] = [
        'document',
        'history',
        'info',
        'annotations',
        'settings',
        'collaboration',
        'user',
        'jsonld',
      ];

      validPanels.forEach((panel) => {
        act(() => {
          result.current.togglePanel(panel);
        });
        expect(result.current.activePanel).toBe(panel);
      });
    });
  });
});
