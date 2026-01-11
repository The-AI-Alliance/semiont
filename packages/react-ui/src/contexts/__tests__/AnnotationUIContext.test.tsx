import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import React from 'react';
import { AnnotationUIProvider, useAnnotationUI } from '../AnnotationUIContext';

// Test component that uses the hook
function TestConsumer() {
  const { newAnnotationIds, clearNewAnnotationId, triggerSparkleAnimation } = useAnnotationUI();

  return (
    <div>
      <div data-testid="annotation-count">{newAnnotationIds.size}</div>
      <div data-testid="has-ann-1">{newAnnotationIds.has('ann-1') ? 'yes' : 'no'}</div>
      <div data-testid="has-ann-2">{newAnnotationIds.has('ann-2') ? 'yes' : 'no'}</div>
      <button data-testid="trigger-ann-1" onClick={() => triggerSparkleAnimation('ann-1')}>
        Trigger 1
      </button>
      <button data-testid="trigger-ann-2" onClick={() => triggerSparkleAnimation('ann-2')}>
        Trigger 2
      </button>
      <button data-testid="clear-ann-1" onClick={() => clearNewAnnotationId('ann-1')}>
        Clear 1
      </button>
      <button data-testid="clear-ann-2" onClick={() => clearNewAnnotationId('ann-2')}>
        Clear 2
      </button>
    </div>
  );
}

describe('AnnotationUIContext', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('AnnotationUIProvider', () => {
    it('should provide UI state to child components', () => {
      render(
        <AnnotationUIProvider>
          <TestConsumer />
        </AnnotationUIProvider>
      );

      expect(screen.getByTestId('annotation-count')).toHaveTextContent('0');
      expect(screen.getByTestId('has-ann-1')).toHaveTextContent('no');
    });

    it('should render children', () => {
      render(
        <AnnotationUIProvider>
          <div data-testid="child">Child content</div>
        </AnnotationUIProvider>
      );

      expect(screen.getByTestId('child')).toHaveTextContent('Child content');
    });
  });

  describe('useAnnotationUI', () => {
    it('should throw error when used outside provider', () => {
      // Suppress console.error for this test
      const consoleError = console.error;
      console.error = () => {};

      expect(() => {
        render(<TestConsumer />);
      }).toThrow('useAnnotationUI must be used within an AnnotationUIProvider');

      console.error = consoleError;
    });

    it('should return UI state from context', () => {
      render(
        <AnnotationUIProvider>
          <TestConsumer />
        </AnnotationUIProvider>
      );

      expect(screen.getByTestId('annotation-count')).toBeInTheDocument();
    });
  });

  describe('Sparkle Animation State', () => {
    it('should add annotation ID when triggering sparkle animation', async () => {
      render(
        <AnnotationUIProvider>
          <TestConsumer />
        </AnnotationUIProvider>
      );

      expect(screen.getByTestId('has-ann-1')).toHaveTextContent('no');

      act(() => {
        screen.getByTestId('trigger-ann-1').click();
      });

      expect(screen.getByTestId('has-ann-1')).toHaveTextContent('yes');
      expect(screen.getByTestId('annotation-count')).toHaveTextContent('1');
    });

    it('should support multiple concurrent animations', () => {
      render(
        <AnnotationUIProvider>
          <TestConsumer />
        </AnnotationUIProvider>
      );

      act(() => {
        screen.getByTestId('trigger-ann-1').click();
        screen.getByTestId('trigger-ann-2').click();
      });

      expect(screen.getByTestId('has-ann-1')).toHaveTextContent('yes');
      expect(screen.getByTestId('has-ann-2')).toHaveTextContent('yes');
      expect(screen.getByTestId('annotation-count')).toHaveTextContent('2');
    });

    it('should auto-clear annotation after 6 seconds', () => {
      render(
        <AnnotationUIProvider>
          <TestConsumer />
        </AnnotationUIProvider>
      );

      act(() => {
        screen.getByTestId('trigger-ann-1').click();
      });

      expect(screen.getByTestId('has-ann-1')).toHaveTextContent('yes');

      // Fast-forward 6 seconds
      act(() => {
        vi.advanceTimersByTime(6000);
      });

      expect(screen.getByTestId('has-ann-1')).toHaveTextContent('no');
      expect(screen.getByTestId('annotation-count')).toHaveTextContent('0');
    });

    it('should manually clear annotation before timeout', () => {
      render(
        <AnnotationUIProvider>
          <TestConsumer />
        </AnnotationUIProvider>
      );

      act(() => {
        screen.getByTestId('trigger-ann-1').click();
      });

      expect(screen.getByTestId('has-ann-1')).toHaveTextContent('yes');

      act(() => {
        screen.getByTestId('clear-ann-1').click();
      });

      expect(screen.getByTestId('has-ann-1')).toHaveTextContent('no');
      expect(screen.getByTestId('annotation-count')).toHaveTextContent('0');
    });

    it('should clear only specified annotation, not others', () => {
      render(
        <AnnotationUIProvider>
          <TestConsumer />
        </AnnotationUIProvider>
      );

      act(() => {
        screen.getByTestId('trigger-ann-1').click();
        screen.getByTestId('trigger-ann-2').click();
      });

      expect(screen.getByTestId('has-ann-1')).toHaveTextContent('yes');
      expect(screen.getByTestId('has-ann-2')).toHaveTextContent('yes');

      act(() => {
        screen.getByTestId('clear-ann-1').click();
      });

      expect(screen.getByTestId('has-ann-1')).toHaveTextContent('no');
      expect(screen.getByTestId('has-ann-2')).toHaveTextContent('yes');
      expect(screen.getByTestId('annotation-count')).toHaveTextContent('1');
    });

    it('should handle clearing non-existent annotation gracefully', () => {
      render(
        <AnnotationUIProvider>
          <TestConsumer />
        </AnnotationUIProvider>
      );

      expect(screen.getByTestId('annotation-count')).toHaveTextContent('0');

      // Clear non-existent annotation
      screen.getByTestId('clear-ann-1').click();

      // Should still be 0, no error
      expect(screen.getByTestId('annotation-count')).toHaveTextContent('0');
    });

    it('should handle triggering same animation multiple times', () => {
      render(
        <AnnotationUIProvider>
          <TestConsumer />
        </AnnotationUIProvider>
      );

      act(() => {
        screen.getByTestId('trigger-ann-1').click();
      });

      expect(screen.getByTestId('has-ann-1')).toHaveTextContent('yes');

      // Trigger again (should not add duplicate)
      act(() => {
        screen.getByTestId('trigger-ann-1').click();
      });

      expect(screen.getByTestId('annotation-count')).toHaveTextContent('1');
    });
  });

  describe('Edge Cases', () => {
    it('should handle rapid trigger and clear operations', () => {
      render(
        <AnnotationUIProvider>
          <TestConsumer />
        </AnnotationUIProvider>
      );

      // Rapid operations
      act(() => {
        for (let i = 0; i < 5; i++) {
          screen.getByTestId('trigger-ann-1').click();
          screen.getByTestId('clear-ann-1').click();
        }
      });

      expect(screen.getByTestId('has-ann-1')).toHaveTextContent('no');
      expect(screen.getByTestId('annotation-count')).toHaveTextContent('0');
    });

    it('should handle multiple components accessing same state', () => {
      function Consumer1() {
        const { newAnnotationIds } = useAnnotationUI();
        return <div data-testid="consumer1-count">{newAnnotationIds.size}</div>;
      }

      function Consumer2() {
        const { triggerSparkleAnimation } = useAnnotationUI();
        return (
          <button data-testid="consumer2-trigger" onClick={() => triggerSparkleAnimation('ann-1')}>
            Trigger
          </button>
        );
      }

      render(
        <AnnotationUIProvider>
          <Consumer1 />
          <Consumer2 />
        </AnnotationUIProvider>
      );

      expect(screen.getByTestId('consumer1-count')).toHaveTextContent('0');

      act(() => {
        screen.getByTestId('consumer2-trigger').click();
      });

      // Both consumers should see the update
      expect(screen.getByTestId('consumer1-count')).toHaveTextContent('1');
    });

    it('should maintain Set uniqueness', () => {
      function SetTestConsumer() {
        const { newAnnotationIds, triggerSparkleAnimation } = useAnnotationUI();

        return (
          <div>
            <div data-testid="ids-array">{Array.from(newAnnotationIds).join(',')}</div>
            <button
              data-testid="trigger-multiple"
              onClick={() => {
                triggerSparkleAnimation('ann-1');
                triggerSparkleAnimation('ann-1');
                triggerSparkleAnimation('ann-2');
              }}
            >
              Trigger Multiple
            </button>
          </div>
        );
      }

      render(
        <AnnotationUIProvider>
          <SetTestConsumer />
        </AnnotationUIProvider>
      );

      act(() => {
        screen.getByTestId('trigger-multiple').click();
      });

      const idsText = screen.getByTestId('ids-array').textContent;
      expect(idsText).toBe('ann-1,ann-2'); // Not 'ann-1,ann-1,ann-2'
    });

    it('should handle timeout cleanup properly when component unmounts', () => {
      const { unmount } = render(
        <AnnotationUIProvider>
          <TestConsumer />
        </AnnotationUIProvider>
      );

      act(() => {
        screen.getByTestId('trigger-ann-1').click();
      });

      expect(screen.getByTestId('has-ann-1')).toHaveTextContent('yes');

      // Unmount before timeout
      unmount();

      // Advance timers (should not cause errors)
      act(() => {
        vi.advanceTimersByTime(6000);
      });

      // No errors should occur
    });
  });

  describe('State Independence', () => {
    it('should have independent state for each provider instance', () => {
      function Consumer({ testId }: { testId: string }) {
        const { newAnnotationIds, triggerSparkleAnimation } = useAnnotationUI();

        return (
          <div>
            <div data-testid={`${testId}-count`}>{newAnnotationIds.size}</div>
            <button
              data-testid={`${testId}-trigger`}
              onClick={() => triggerSparkleAnimation('ann-1')}
            >
              Trigger
            </button>
          </div>
        );
      }

      render(
        <div>
          <AnnotationUIProvider>
            <Consumer testId="provider1" />
          </AnnotationUIProvider>
          <AnnotationUIProvider>
            <Consumer testId="provider2" />
          </AnnotationUIProvider>
        </div>
      );

      // Both start at 0
      expect(screen.getByTestId('provider1-count')).toHaveTextContent('0');
      expect(screen.getByTestId('provider2-count')).toHaveTextContent('0');

      // Trigger only in provider1
      act(() => {
        screen.getByTestId('provider1-trigger').click();
      });

      // Only provider1 should update
      expect(screen.getByTestId('provider1-count')).toHaveTextContent('1');
      expect(screen.getByTestId('provider2-count')).toHaveTextContent('0');
    });
  });
});
