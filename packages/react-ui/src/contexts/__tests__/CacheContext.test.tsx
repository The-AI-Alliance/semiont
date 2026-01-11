import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { CacheProvider, useCacheManager } from '../CacheContext';
import type { CacheManager } from '../../types/CacheManager';
import { resourceUri } from '@semiont/api-client';

// Test component that uses the hook
function TestConsumer() {
  const cacheManager = useCacheManager();

  return (
    <div>
      <div data-testid="has-manager">{cacheManager ? 'yes' : 'no'}</div>
      <button
        data-testid="invalidate-annotations-btn"
        onClick={() =>
          cacheManager.invalidateAnnotations(resourceUri('http://localhost/resources/test-123'))
        }
      >
        Invalidate Annotations
      </button>
      <button
        data-testid="invalidate-events-btn"
        onClick={() => cacheManager.invalidateEvents(resourceUri('http://localhost/resources/test-123'))}
      >
        Invalidate Events
      </button>
    </div>
  );
}

describe('CacheContext', () => {
  describe('CacheProvider', () => {
    it('should provide cache manager to child components', () => {
      const mockManager: CacheManager = {
        invalidateAnnotations: vi.fn(),
        invalidateEvents: vi.fn()
      };

      render(
        <CacheProvider cacheManager={mockManager}>
          <TestConsumer />
        </CacheProvider>
      );

      expect(screen.getByTestId('has-manager')).toHaveTextContent('yes');
    });

    it('should allow calling invalidateAnnotations through manager', async () => {
      const mockInvalidateAnnotations = vi.fn();
      const mockManager: CacheManager = {
        invalidateAnnotations: mockInvalidateAnnotations,
        invalidateEvents: vi.fn()
      };

      render(
        <CacheProvider cacheManager={mockManager}>
          <TestConsumer />
        </CacheProvider>
      );

      const btn = screen.getByTestId('invalidate-annotations-btn');
      btn.click();

      await waitFor(() => {
        expect(mockInvalidateAnnotations).toHaveBeenCalledWith(
          resourceUri('http://localhost/resources/test-123')
        );
      });
    });

    it('should allow calling invalidateEvents through manager', async () => {
      const mockInvalidateEvents = vi.fn();
      const mockManager: CacheManager = {
        invalidateAnnotations: vi.fn(),
        invalidateEvents: mockInvalidateEvents
      };

      render(
        <CacheProvider cacheManager={mockManager}>
          <TestConsumer />
        </CacheProvider>
      );

      const btn = screen.getByTestId('invalidate-events-btn');
      btn.click();

      await waitFor(() => {
        expect(mockInvalidateEvents).toHaveBeenCalledWith(
          resourceUri('http://localhost/resources/test-123')
        );
      });
    });

    it('should render children', () => {
      const mockManager: CacheManager = {
        invalidateAnnotations: vi.fn(),
        invalidateEvents: vi.fn()
      };

      render(
        <CacheProvider cacheManager={mockManager}>
          <div data-testid="child">Child content</div>
        </CacheProvider>
      );

      expect(screen.getByTestId('child')).toHaveTextContent('Child content');
    });

    it('should update when manager changes', async () => {
      const mockInvalidate1 = vi.fn();
      const mockManager1: CacheManager = {
        invalidateAnnotations: mockInvalidate1,
        invalidateEvents: vi.fn()
      };

      const { rerender } = render(
        <CacheProvider cacheManager={mockManager1}>
          <TestConsumer />
        </CacheProvider>
      );

      const btn = screen.getByTestId('invalidate-annotations-btn');
      btn.click();

      await waitFor(() => {
        expect(mockInvalidate1).toHaveBeenCalledTimes(1);
      });

      const mockInvalidate2 = vi.fn();
      const mockManager2: CacheManager = {
        invalidateAnnotations: mockInvalidate2,
        invalidateEvents: vi.fn()
      };

      rerender(
        <CacheProvider cacheManager={mockManager2}>
          <TestConsumer />
        </CacheProvider>
      );

      btn.click();

      await waitFor(() => {
        expect(mockInvalidate2).toHaveBeenCalledTimes(1);
        expect(mockInvalidate1).toHaveBeenCalledTimes(1); // Still 1 from before
      });
    });
  });

  describe('useCacheManager', () => {
    it('should throw error when used outside provider', () => {
      // Suppress console.error for this test
      const consoleError = console.error;
      console.error = () => {};

      expect(() => {
        render(<TestConsumer />);
      }).toThrow('useCacheManager must be used within a CacheProvider');

      console.error = consoleError;
    });

    it('should return manager from context', () => {
      const mockManager: CacheManager = {
        invalidateAnnotations: vi.fn(),
        invalidateEvents: vi.fn()
      };

      render(
        <CacheProvider cacheManager={mockManager}>
          <TestConsumer />
        </CacheProvider>
      );

      expect(screen.getByTestId('has-manager')).toBeInTheDocument();
      expect(screen.getByTestId('has-manager')).toHaveTextContent('yes');
    });
  });

  describe('Provider Pattern Integration', () => {
    it('should accept any CacheManager implementation', async () => {
      // Custom implementation (e.g., with SWR instead of React Query)
      class CustomCacheManager implements CacheManager {
        invalidatedAnnotations: string[] = [];
        invalidatedEvents: string[] = [];

        invalidateAnnotations(rUri: string) {
          this.invalidatedAnnotations.push(rUri);
        }

        invalidateEvents(rUri: string) {
          this.invalidatedEvents.push(rUri);
        }
      }

      const customManager = new CustomCacheManager();
      const invalidateAnnotationsSpy = vi.spyOn(customManager, 'invalidateAnnotations');

      render(
        <CacheProvider cacheManager={customManager}>
          <TestConsumer />
        </CacheProvider>
      );

      const btn = screen.getByTestId('invalidate-annotations-btn');
      btn.click();

      await waitFor(() => {
        expect(invalidateAnnotationsSpy).toHaveBeenCalled();
        expect(customManager.invalidatedAnnotations).toHaveLength(1);
      });
    });

    it('should work with nested providers', () => {
      const outerManager: CacheManager = {
        invalidateAnnotations: vi.fn(),
        invalidateEvents: vi.fn()
      };

      const innerManager: CacheManager = {
        invalidateAnnotations: vi.fn(),
        invalidateEvents: vi.fn()
      };

      function InnerConsumer() {
        const manager = useCacheManager();
        return <div data-testid="inner-manager">{manager ? 'yes' : 'no'}</div>;
      }

      function OuterConsumer() {
        const manager = useCacheManager();
        return (
          <div>
            <div data-testid="outer-manager">{manager ? 'yes' : 'no'}</div>
            <CacheProvider cacheManager={innerManager}>
              <InnerConsumer />
            </CacheProvider>
          </div>
        );
      }

      render(
        <CacheProvider cacheManager={outerManager}>
          <OuterConsumer />
        </CacheProvider>
      );

      expect(screen.getByTestId('outer-manager')).toHaveTextContent('yes');
      expect(screen.getByTestId('inner-manager')).toHaveTextContent('yes');
    });

    it('should use innermost provider when nested', async () => {
      const outerInvalidate = vi.fn();
      const outerManager: CacheManager = {
        invalidateAnnotations: outerInvalidate,
        invalidateEvents: vi.fn()
      };

      const innerInvalidate = vi.fn();
      const innerManager: CacheManager = {
        invalidateAnnotations: innerInvalidate,
        invalidateEvents: vi.fn()
      };

      function NestedConsumer() {
        const manager = useCacheManager();
        return (
          <button
            data-testid="nested-invalidate"
            onClick={() =>
              manager.invalidateAnnotations(resourceUri('http://localhost/resources/test'))
            }
          >
            Invalidate
          </button>
        );
      }

      render(
        <CacheProvider cacheManager={outerManager}>
          <CacheProvider cacheManager={innerManager}>
            <NestedConsumer />
          </CacheProvider>
        </CacheProvider>
      );

      const btn = screen.getByTestId('nested-invalidate');
      btn.click();

      await waitFor(() => {
        expect(innerInvalidate).toHaveBeenCalledTimes(1);
        expect(outerInvalidate).not.toHaveBeenCalled();
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle multiple components using same manager', async () => {
      const mockInvalidate = vi.fn();
      const mockManager: CacheManager = {
        invalidateAnnotations: mockInvalidate,
        invalidateEvents: vi.fn()
      };

      function Consumer1() {
        const manager = useCacheManager();
        return (
          <button
            data-testid="consumer1-invalidate"
            onClick={() =>
              manager.invalidateAnnotations(resourceUri('http://localhost/resources/test1'))
            }
          >
            Invalidate 1
          </button>
        );
      }

      function Consumer2() {
        const manager = useCacheManager();
        return (
          <button
            data-testid="consumer2-invalidate"
            onClick={() =>
              manager.invalidateAnnotations(resourceUri('http://localhost/resources/test2'))
            }
          >
            Invalidate 2
          </button>
        );
      }

      render(
        <CacheProvider cacheManager={mockManager}>
          <Consumer1 />
          <Consumer2 />
        </CacheProvider>
      );

      screen.getByTestId('consumer1-invalidate').click();
      screen.getByTestId('consumer2-invalidate').click();

      await waitFor(() => {
        expect(mockInvalidate).toHaveBeenCalledTimes(2);
      });
    });

    it('should support both synchronous and asynchronous invalidation', async () => {
      const syncInvalidate = vi.fn(); // Returns void
      const asyncInvalidate = vi.fn().mockResolvedValue(undefined); // Returns Promise<void>

      const mockManager: CacheManager = {
        invalidateAnnotations: syncInvalidate,
        invalidateEvents: asyncInvalidate
      };

      function MixedConsumer() {
        const manager = useCacheManager();
        return (
          <div>
            <button
              data-testid="sync-invalidate"
              onClick={() =>
                manager.invalidateAnnotations(resourceUri('http://localhost/resources/test'))
              }
            >
              Sync
            </button>
            <button
              data-testid="async-invalidate"
              onClick={async () =>
                await manager.invalidateEvents(resourceUri('http://localhost/resources/test'))
              }
            >
              Async
            </button>
          </div>
        );
      }

      render(
        <CacheProvider cacheManager={mockManager}>
          <MixedConsumer />
        </CacheProvider>
      );

      screen.getByTestId('sync-invalidate').click();
      screen.getByTestId('async-invalidate').click();

      await waitFor(() => {
        expect(syncInvalidate).toHaveBeenCalledTimes(1);
        expect(asyncInvalidate).toHaveBeenCalledTimes(1);
      });
    });

    it('should handle rapid invalidation calls', async () => {
      const mockInvalidate = vi.fn();
      const mockManager: CacheManager = {
        invalidateAnnotations: mockInvalidate,
        invalidateEvents: vi.fn()
      };

      function RapidConsumer() {
        const manager = useCacheManager();
        return (
          <button
            data-testid="rapid-invalidate"
            onClick={() => {
              // Rapid calls
              for (let i = 0; i < 10; i++) {
                manager.invalidateAnnotations(
                  resourceUri(`http://localhost/resources/test-${i}`)
                );
              }
            }}
          >
            Rapid Invalidate
          </button>
        );
      }

      render(
        <CacheProvider cacheManager={mockManager}>
          <RapidConsumer />
        </CacheProvider>
      );

      screen.getByTestId('rapid-invalidate').click();

      await waitFor(() => {
        expect(mockInvalidate).toHaveBeenCalledTimes(10);
      });
    });
  });
});
