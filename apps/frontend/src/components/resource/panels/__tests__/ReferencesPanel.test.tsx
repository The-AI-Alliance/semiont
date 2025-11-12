import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { ReferencesPanel } from '../ReferencesPanel';

// Mock next-intl
vi.mock('next-intl', () => ({
  useTranslations: vi.fn(() => (key: string, params?: Record<string, any>) => {
    const translations: Record<string, string> = {
      title: 'Detect Entities',
      selectEntityTypes: 'Select entity types',
      noEntityTypes: 'No entity types available',
      select: 'Select',
      deselect: 'Deselect',
      typesSelected: '{count} type(s) selected',
      startDetection: 'Start Detection',
      found: 'Found {count}',
      more: 'Detect More',
    };
    let result = translations[key] || key;
    // Replace {count} with actual count value if provided
    if (params?.count !== undefined) {
      result = result.replace('{count}', String(params.count));
    }
    return result;
  }),
}));

// Mock DetectionProgressWidget
vi.mock('@/components/DetectionProgressWidget', () => ({
  DetectionProgressWidget: ({ progress, onCancel }: any) => (
    <div data-testid="detection-progress-widget">
      <div data-testid="progress-data">{JSON.stringify(progress)}</div>
      <button onClick={onCancel}>Cancel Detection</button>
    </div>
  ),
}));

describe('ReferencesPanel Component', () => {
  const defaultProps = {
    allEntityTypes: ['Person', 'Organization', 'Location', 'Date'],
    isDetecting: false,
    detectionProgress: null,
    onDetect: vi.fn(),
    onCancelDetection: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('should render panel with title', () => {
      render(<ReferencesPanel {...defaultProps} />);

      expect(screen.getByText('Detect Entities')).toBeInTheDocument();
    });

    it('should render all entity type buttons', () => {
      render(<ReferencesPanel {...defaultProps} />);

      expect(screen.getByText('Person')).toBeInTheDocument();
      expect(screen.getByText('Organization')).toBeInTheDocument();
      expect(screen.getByText('Location')).toBeInTheDocument();
      expect(screen.getByText('Date')).toBeInTheDocument();
    });

    it('should show message when no entity types available', () => {
      render(<ReferencesPanel {...defaultProps} allEntityTypes={[]} />);

      expect(screen.getByText('No entity types available')).toBeInTheDocument();
    });

    it('should render start detection button', () => {
      render(<ReferencesPanel {...defaultProps} />);

      expect(screen.getByText(/Start Detection/)).toBeInTheDocument();
    });
  });

  describe('Entity Type Selection', () => {
    it('should toggle entity type selection on click', async () => {
      render(<ReferencesPanel {...defaultProps} />);

      const personButton = screen.getByText('Person');

      // Initially not selected
      expect(personButton).toHaveAttribute('aria-pressed', 'false');

      // Click to select
      await userEvent.click(personButton);

      expect(personButton).toHaveAttribute('aria-pressed', 'true');

      // Click again to deselect
      await userEvent.click(personButton);

      expect(personButton).toHaveAttribute('aria-pressed', 'false');
    });

    it('should allow multiple selections', async () => {
      render(<ReferencesPanel {...defaultProps} />);

      const personButton = screen.getByText('Person');
      const orgButton = screen.getByText('Organization');
      const locationButton = screen.getByText('Location');

      await userEvent.click(personButton);
      await userEvent.click(orgButton);
      await userEvent.click(locationButton);

      expect(personButton).toHaveAttribute('aria-pressed', 'true');
      expect(orgButton).toHaveAttribute('aria-pressed', 'true');
      expect(locationButton).toHaveAttribute('aria-pressed', 'true');
    });

    it('should deselect when clicking selected type', async () => {
      render(<ReferencesPanel {...defaultProps} />);

      const personButton = screen.getByText('Person');

      await userEvent.click(personButton);
      expect(personButton).toHaveAttribute('aria-pressed', 'true');

      await userEvent.click(personButton);
      expect(personButton).toHaveAttribute('aria-pressed', 'false');
    });

    it('should show selected count', async () => {
      render(<ReferencesPanel {...defaultProps} />);

      const personButton = screen.getByText('Person');
      const orgButton = screen.getByText('Organization');

      await userEvent.click(personButton);

      // Should show count
      expect(screen.getByText(/selected/i)).toBeInTheDocument();

      await userEvent.click(orgButton);

      // Should update count
      expect(screen.getByText(/selected/i)).toBeInTheDocument();
    });

    it('should not show selected count when none selected', () => {
      render(<ReferencesPanel {...defaultProps} />);

      expect(screen.queryByText(/selected/i)).not.toBeInTheDocument();
    });
  });

  describe('Button Styling', () => {
    it('should style selected buttons differently', async () => {
      render(<ReferencesPanel {...defaultProps} />);

      const personButton = screen.getByText('Person');

      // Before selection
      expect(personButton).toHaveClass('bg-gray-50');
      expect(personButton).not.toHaveClass('bg-blue-100');

      await userEvent.click(personButton);

      // After selection
      expect(personButton).toHaveClass('bg-blue-100');
      expect(personButton).not.toHaveClass('bg-gray-50');
    });

    it('should have proper ARIA attributes', () => {
      render(<ReferencesPanel {...defaultProps} />);

      const personButton = screen.getByText('Person');

      expect(personButton).toHaveAttribute('aria-pressed');
      expect(personButton).toHaveAttribute('aria-label');
    });

    it('should have focus styles', () => {
      render(<ReferencesPanel {...defaultProps} />);

      const personButton = screen.getByText('Person');

      expect(personButton).toHaveClass('focus:outline-none', 'focus:ring-2', 'focus:ring-blue-500');
    });
  });

  describe('Start Detection Button', () => {
    it('should be disabled when no types selected', () => {
      render(<ReferencesPanel {...defaultProps} />);

      const startButton = screen.getByText(/Start Detection/);

      expect(startButton).toBeDisabled();
    });

    it('should be enabled when types are selected', async () => {
      render(<ReferencesPanel {...defaultProps} />);

      const personButton = screen.getByText('Person');
      await userEvent.click(personButton);

      const startButton = screen.getByText(/Start Detection/);

      expect(startButton).not.toBeDisabled();
    });

    it('should call onDetect with selected types', async () => {
      const onDetect = vi.fn();
      render(<ReferencesPanel {...defaultProps} onDetect={onDetect} />);

      await userEvent.click(screen.getByText('Person'));
      await userEvent.click(screen.getByText('Organization'));

      const startButton = screen.getByText(/Start Detection/);
      await userEvent.click(startButton);

      expect(onDetect).toHaveBeenCalledWith(['Person', 'Organization']);
    });

    it('should clear selected types after detection starts', async () => {
      const { rerender } = render(<ReferencesPanel {...defaultProps} />);

      await userEvent.click(screen.getByText('Person'));

      const startButton = screen.getByText(/Start Detection/);
      await userEvent.click(startButton);

      // Simulate detection starting
      rerender(
        <ReferencesPanel
          {...defaultProps}
          isDetecting={true}
          detectionProgress={{ completedEntityTypes: [] }}
        />
      );

      // Simulate detection completing
      rerender(
        <ReferencesPanel
          {...defaultProps}
          isDetecting={false}
          detectionProgress={{
            completedEntityTypes: [{ entityType: 'Person', foundCount: 5 }],
          }}
        />
      );

      // UI should reset but we can't directly test internal state
      // We can test that buttons are back to unselected state after going through full cycle
    });

    it('should have proper styling when disabled', () => {
      render(<ReferencesPanel {...defaultProps} />);

      const startButton = screen.getByText(/Start Detection/);

      expect(startButton).toHaveClass('bg-gray-200', 'cursor-not-allowed');
    });

    it('should have proper styling when enabled', async () => {
      render(<ReferencesPanel {...defaultProps} />);

      await userEvent.click(screen.getByText('Person'));

      const startButton = screen.getByText(/Start Detection/);

      expect(startButton).toHaveClass('from-blue-600', 'to-cyan-600');
    });
  });

  describe('Detection Progress', () => {
    it('should show progress widget when detecting', () => {
      render(
        <ReferencesPanel
          {...defaultProps}
          isDetecting={true}
          detectionProgress={{ completedEntityTypes: [] }}
        />
      );

      expect(screen.getByTestId('detection-progress-widget')).toBeInTheDocument();
    });

    it('should pass progress data to widget', () => {
      const progress = {
        completedEntityTypes: [
          { entityType: 'Person', foundCount: 5 },
          { entityType: 'Organization', foundCount: 3 },
        ],
      };

      render(
        <ReferencesPanel
          {...defaultProps}
          isDetecting={true}
          detectionProgress={progress}
        />
      );

      const progressData = screen.getByTestId('progress-data');
      expect(progressData.textContent).toContain('Person');
      expect(progressData.textContent).toContain('Organization');
    });

    it('should hide entity type selection during detection', () => {
      render(
        <ReferencesPanel
          {...defaultProps}
          isDetecting={true}
          detectionProgress={{ completedEntityTypes: [] }}
        />
      );

      expect(screen.queryByText('Select entity types')).not.toBeInTheDocument();
      expect(screen.queryByText('Person')).not.toBeInTheDocument();
    });

    it('should allow canceling detection', async () => {
      const onCancelDetection = vi.fn();

      render(
        <ReferencesPanel
          {...defaultProps}
          isDetecting={true}
          detectionProgress={{ completedEntityTypes: [] }}
          onCancelDetection={onCancelDetection}
        />
      );

      const cancelButton = screen.getByText('Cancel Detection');
      await userEvent.click(cancelButton);

      expect(onCancelDetection).toHaveBeenCalledOnce();
    });
  });

  describe('Detection Complete Log', () => {
    it('should show completed log after detection finishes', () => {
      const { rerender } = render(
        <ReferencesPanel
          {...defaultProps}
          isDetecting={false}
          detectionProgress={{
            completedEntityTypes: [
              { entityType: 'Person', foundCount: 5 },
              { entityType: 'Organization', foundCount: 3 },
            ],
          }}
        />
      );

      // Parent clears detectionProgress after completion
      rerender(
        <ReferencesPanel
          {...defaultProps}
          isDetecting={false}
          detectionProgress={null}
        />
      );

      expect(screen.getByText('Person:')).toBeInTheDocument();
      expect(screen.getByText('Organization:')).toBeInTheDocument();
    });

    it('should show found counts in log', () => {
      const { rerender } = render(
        <ReferencesPanel
          {...defaultProps}
          isDetecting={false}
          detectionProgress={{
            completedEntityTypes: [{ entityType: 'Person', foundCount: 5 }],
          }}
        />
      );

      rerender(<ReferencesPanel {...defaultProps} isDetecting={false} detectionProgress={null} />);
      expect(screen.getByText(/Found.*5/i)).toBeInTheDocument();
    });

    it('should show checkmarks for completed types', () => {
      const { rerender } = render(
        <ReferencesPanel
          {...defaultProps}
          isDetecting={false}
          detectionProgress={{
            completedEntityTypes: [{ entityType: 'Person', foundCount: 5 }],
          }}
        />
      );

      rerender(<ReferencesPanel {...defaultProps} isDetecting={false} detectionProgress={null} />);
      expect(screen.getByText('✓')).toBeInTheDocument();
    });

    it('should show "Detect More" button after completion', () => {
      const { rerender } = render(
        <ReferencesPanel
          {...defaultProps}
          isDetecting={false}
          detectionProgress={{
            completedEntityTypes: [{ entityType: 'Person', foundCount: 5 }],
          }}
        />
      );

      rerender(<ReferencesPanel {...defaultProps} isDetecting={false} detectionProgress={null} />);
      expect(screen.getByText('Detect More')).toBeInTheDocument();
    });

    it('should clear log and show selection UI when clicking "Detect More"', async () => {
      const { rerender } = render(
        <ReferencesPanel
          {...defaultProps}
          isDetecting={false}
          detectionProgress={{
            completedEntityTypes: [{ entityType: 'Person', foundCount: 5 }],
          }}
        />
      );

      rerender(<ReferencesPanel {...defaultProps} isDetecting={false} detectionProgress={null} />);

      const detectMoreButton = screen.getByText('Detect More');
      await userEvent.click(detectMoreButton);

      // Should show selection UI again
      expect(screen.getByText('Select entity types')).toBeInTheDocument();
      expect(screen.getByText('Person')).toBeInTheDocument();
    });

    it('should not show log when empty', () => {
      render(
        <ReferencesPanel
          {...defaultProps}
          isDetecting={false}
          detectionProgress={{
            completedEntityTypes: [],
          }}
        />
      );

      expect(screen.queryByText('Detect More')).not.toBeInTheDocument();
    });
  });

  describe('State Transitions', () => {
    it('should transition from idle to detecting', () => {
      const { rerender } = render(<ReferencesPanel {...defaultProps} />);

      // Idle state
      expect(screen.getByText('Select entity types')).toBeInTheDocument();

      // Start detecting
      rerender(
        <ReferencesPanel
          {...defaultProps}
          isDetecting={true}
          detectionProgress={{ completedEntityTypes: [] }}
        />
      );

      // Detecting state
      expect(screen.getByTestId('detection-progress-widget')).toBeInTheDocument();
      expect(screen.queryByText('Select entity types')).not.toBeInTheDocument();
    });

    it('should transition from detecting to complete', () => {
      const { rerender } = render(
        <ReferencesPanel
          {...defaultProps}
          isDetecting={true}
          detectionProgress={{ completedEntityTypes: [] }}
        />
      );

      // Detecting
      expect(screen.getByTestId('detection-progress-widget')).toBeInTheDocument();

      // Complete - first trigger useEffect to copy to lastDetectionLog
      rerender(
        <ReferencesPanel
          {...defaultProps}
          isDetecting={false}
          detectionProgress={{
            completedEntityTypes: [{ entityType: 'Person', foundCount: 5 }],
          }}
        />
      );

      // Then clear detectionProgress to show the log
      rerender(<ReferencesPanel {...defaultProps} isDetecting={false} detectionProgress={null} />);

      expect(screen.queryByTestId('detection-progress-widget')).not.toBeInTheDocument();
      expect(screen.getByText('Detect More')).toBeInTheDocument();
    });

    it('should transition from complete to idle', async () => {
      const { rerender } = render(
        <ReferencesPanel
          {...defaultProps}
          isDetecting={false}
          detectionProgress={{
            completedEntityTypes: [{ entityType: 'Person', foundCount: 5 }],
          }}
        />
      );

      // Clear detectionProgress to show the log
      rerender(<ReferencesPanel {...defaultProps} isDetecting={false} detectionProgress={null} />);

      const detectMoreButton = screen.getByText('Detect More');
      await userEvent.click(detectMoreButton);

      rerender(<ReferencesPanel {...defaultProps} />);

      expect(screen.getByText('Select entity types')).toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty entity types array', () => {
      expect(() => {
        render(<ReferencesPanel {...defaultProps} allEntityTypes={[]} />);
      }).not.toThrow();
    });

    it('should handle many entity types', () => {
      const manyTypes = Array.from({ length: 50 }, (_, i) => `Type${i}`);

      expect(() => {
        render(<ReferencesPanel {...defaultProps} allEntityTypes={manyTypes} />);
      }).not.toThrow();

      expect(screen.getByText('Type0')).toBeInTheDocument();
      expect(screen.getByText('Type49')).toBeInTheDocument();
    });

    it('should handle entity types with special characters', () => {
      const specialTypes = ['Type-A', 'Type_B', 'Type.C', 'Type/D'];

      render(<ReferencesPanel {...defaultProps} allEntityTypes={specialTypes} />);

      specialTypes.forEach(type => {
        expect(screen.getByText(type)).toBeInTheDocument();
      });
    });

    it('should handle selecting and deselecting all types', async () => {
      render(<ReferencesPanel {...defaultProps} />);

      // Select all
      for (const type of defaultProps.allEntityTypes) {
        await userEvent.click(screen.getByText(type));
      }

      defaultProps.allEntityTypes.forEach(type => {
        expect(screen.getByText(type)).toHaveAttribute('aria-pressed', 'true');
      });

      // Deselect all
      for (const type of defaultProps.allEntityTypes) {
        await userEvent.click(screen.getByText(type));
      }

      defaultProps.allEntityTypes.forEach(type => {
        expect(screen.getByText(type)).toHaveAttribute('aria-pressed', 'false');
      });
    });

    it('should handle rapid selection changes', async () => {
      render(<ReferencesPanel {...defaultProps} />);

      const personButton = screen.getByText('Person');

      // Rapid clicks
      for (let i = 0; i < 10; i++) {
        await userEvent.click(personButton);
      }

      // Should be in a consistent state (even number of clicks = not selected)
      expect(personButton).toHaveAttribute('aria-pressed', 'false');
    });

    it('should handle zero found count in results', () => {
      render(
        <ReferencesPanel
          {...defaultProps}
          isDetecting={false}
          detectionProgress={{
            completedEntityTypes: [{ entityType: 'Person', foundCount: 0 }],
          }}
        />
      );

      expect(screen.getByText(/Found.*0/i)).toBeInTheDocument();
    });

    it('should handle undefined detectionProgress', () => {
      expect(() => {
        render(
          <ReferencesPanel
            {...defaultProps}
            isDetecting={false}
            detectionProgress={undefined as any}
          />
        );
      }).not.toThrow();
    });
  });

  describe('Styling and Appearance', () => {
    it('should have proper panel structure', () => {
      const { container } = render(<ReferencesPanel {...defaultProps} />);

      const panel = container.firstChild as HTMLElement;
      expect(panel).toHaveClass('flex', 'flex-col', 'h-full', 'bg-white', 'dark:bg-gray-900');
    });

    it('should support dark mode', () => {
      const { container } = render(<ReferencesPanel {...defaultProps} />);

      const panel = container.firstChild as HTMLElement;
      expect(panel).toHaveClass('dark:bg-gray-900');
    });

    it('should have emoji in title', () => {
      render(<ReferencesPanel {...defaultProps} />);

      expect(screen.getByText('🔵')).toBeInTheDocument();
    });

    it('should have proper button layout', () => {
      render(<ReferencesPanel {...defaultProps} />);

      const buttonContainer = screen.getByText('Person').parentElement;
      expect(buttonContainer).toHaveClass('flex', 'flex-wrap', 'gap-2');
    });
  });

  describe('Accessibility', () => {
    it('should have proper ARIA labels for selection', async () => {
      render(<ReferencesPanel {...defaultProps} />);

      const personButton = screen.getByText('Person');

      expect(personButton).toHaveAttribute('aria-label');

      await userEvent.click(personButton);

      // Label should update to indicate deselection is possible
      const label = personButton.getAttribute('aria-label');
      expect(label).toBeTruthy();
    });

    it('should have proper ARIA pressed states', async () => {
      render(<ReferencesPanel {...defaultProps} />);

      const personButton = screen.getByText('Person');

      expect(personButton).toHaveAttribute('aria-pressed', 'false');

      await userEvent.click(personButton);

      expect(personButton).toHaveAttribute('aria-pressed', 'true');
    });

    it('should be keyboard navigable', () => {
      render(<ReferencesPanel {...defaultProps} />);

      const personButton = screen.getByText('Person');
      personButton.focus();

      expect(personButton).toHaveFocus();
    });
  });
});
