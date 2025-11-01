import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { ResourceActionsPanel } from '../ResourceActionsPanel';

// Mock next-intl
vi.mock('next-intl', () => ({
  useTranslations: vi.fn(() => (key: string) => {
    const translations: Record<string, string> = {
      title: 'Actions',
      clone: 'Clone',
      cloneDescription: 'Create a copy of this resource',
      archive: 'Archive',
      archiveDescription: 'Archive this resource (can be unarchived later)',
      unarchive: 'Unarchive',
      unarchiveDescription: 'Restore this resource from archive',
    };
    return translations[key] || key;
  }),
}));

// Mock button styles
vi.mock('@/lib/button-styles', () => ({
  buttonStyles: {
    secondary: {
      base: 'btn-secondary',
    },
  },
}));

describe('ResourceActionsPanel Component', () => {
  const defaultProps = {
    isArchived: false,
    onArchive: vi.fn(),
    onUnarchive: vi.fn(),
    onClone: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('should render panel title', () => {
      render(<ResourceActionsPanel {...defaultProps} />);

      expect(screen.getByText('Actions')).toBeInTheDocument();
    });

    it('should render clone button', () => {
      render(<ResourceActionsPanel {...defaultProps} />);

      expect(screen.getByText(/Clone/)).toBeInTheDocument();
    });

    it('should render clone description', () => {
      render(<ResourceActionsPanel {...defaultProps} />);

      expect(screen.getByText('Create a copy of this resource')).toBeInTheDocument();
    });
  });

  describe('Clone Action', () => {
    it('should call onClone when clone button clicked', async () => {
      const onClone = vi.fn();
      render(<ResourceActionsPanel {...defaultProps} onClone={onClone} />);

      const cloneButton = screen.getByText(/Clone/);
      await userEvent.click(cloneButton);

      expect(onClone).toHaveBeenCalledOnce();
    });

    it('should have proper button styling', () => {
      render(<ResourceActionsPanel {...defaultProps} />);

      const cloneButton = screen.getByText(/Clone/).closest('button');
      expect(cloneButton).toHaveClass('btn-secondary', 'w-full', 'justify-center');
    });

    it('should show clone emoji', () => {
      render(<ResourceActionsPanel {...defaultProps} />);

      const cloneButton = screen.getByRole('button', { name: /📋.*Clone/ });
      expect(cloneButton).toBeInTheDocument();
    });
  });

  describe('Archive Action (Non-Archived Resource)', () => {
    it('should show archive button when not archived', () => {
      render(<ResourceActionsPanel {...defaultProps} isArchived={false} />);

      expect(screen.getByRole('button', { name: /📦.*Archive/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Unarchive/ })).not.toBeInTheDocument();
    });

    it('should call onArchive when archive button clicked', async () => {
      const onArchive = vi.fn();
      render(<ResourceActionsPanel {...defaultProps} onArchive={onArchive} isArchived={false} />);

      const archiveButton = screen.getByRole('button', { name: /📦.*Archive/ });
      await userEvent.click(archiveButton);

      expect(onArchive).toHaveBeenCalledOnce();
    });

    it('should show archive description', () => {
      render(<ResourceActionsPanel {...defaultProps} isArchived={false} />);

      expect(screen.getByText('Archive this resource (can be unarchived later)')).toBeInTheDocument();
    });

    it('should have proper styling for archive button', () => {
      render(<ResourceActionsPanel {...defaultProps} isArchived={false} />);

      const archiveButton = screen.getByRole('button', { name: /📦.*Archive/ });
      expect(archiveButton).toHaveClass(
        'bg-white',
        'dark:bg-gray-800',
        'text-red-600',
        'dark:text-red-400',
        'border',
        'border-red-300',
        'dark:border-red-700'
      );
    });

    it('should show archive emoji', () => {
      render(<ResourceActionsPanel {...defaultProps} isArchived={false} />);

      const archiveButton = screen.getByRole('button', { name: /📦.*Archive/ });
      expect(archiveButton).toBeInTheDocument();
    });
  });

  describe('Unarchive Action (Archived Resource)', () => {
    it('should show unarchive button when archived', () => {
      render(<ResourceActionsPanel {...defaultProps} isArchived={true} />);

      expect(screen.getByText(/Unarchive/)).toBeInTheDocument();
      expect(screen.queryByText(/^Archive$/)).not.toBeInTheDocument();
    });

    it('should call onUnarchive when unarchive button clicked', async () => {
      const onUnarchive = vi.fn();
      render(<ResourceActionsPanel {...defaultProps} onUnarchive={onUnarchive} isArchived={true} />);

      const unarchiveButton = screen.getByRole('button', { name: /📤.*Unarchive/ });
      await userEvent.click(unarchiveButton);

      expect(onUnarchive).toHaveBeenCalledOnce();
    });

    it('should show unarchive description', () => {
      render(<ResourceActionsPanel {...defaultProps} isArchived={true} />);

      expect(screen.getByText('Restore this resource from archive')).toBeInTheDocument();
    });

    it('should have proper styling for unarchive button', () => {
      render(<ResourceActionsPanel {...defaultProps} isArchived={true} />);

      const unarchiveButton = screen.getByRole('button', { name: /📤.*Unarchive/ });
      expect(unarchiveButton).toHaveClass('btn-secondary', 'w-full', 'justify-center');
    });

    it('should show unarchive emoji', () => {
      render(<ResourceActionsPanel {...defaultProps} isArchived={true} />);

      const unarchiveButton = screen.getByRole('button', { name: /📤.*Unarchive/ });
      expect(unarchiveButton).toBeInTheDocument();
    });
  });

  describe('State Transitions', () => {
    it('should transition from non-archived to archived UI', () => {
      const { rerender } = render(<ResourceActionsPanel {...defaultProps} isArchived={false} />);

      expect(screen.getByText(/^Archive/)).toBeInTheDocument();

      rerender(<ResourceActionsPanel {...defaultProps} isArchived={true} />);

      expect(screen.queryByText(/^Archive$/)).not.toBeInTheDocument();
      expect(screen.getByText(/Unarchive/)).toBeInTheDocument();
    });

    it('should transition from archived to non-archived UI', () => {
      const { rerender } = render(<ResourceActionsPanel {...defaultProps} isArchived={true} />);

      expect(screen.getByText(/Unarchive/)).toBeInTheDocument();

      rerender(<ResourceActionsPanel {...defaultProps} isArchived={false} />);

      expect(screen.queryByText(/Unarchive/)).not.toBeInTheDocument();
      expect(screen.getByText(/^Archive/)).toBeInTheDocument();
    });
  });

  describe('Multiple Actions', () => {
    it('should allow multiple button clicks', async () => {
      const onClone = vi.fn();
      render(<ResourceActionsPanel {...defaultProps} onClone={onClone} />);

      const cloneButton = screen.getByText(/Clone/);

      await userEvent.click(cloneButton);
      await userEvent.click(cloneButton);
      await userEvent.click(cloneButton);

      expect(onClone).toHaveBeenCalledTimes(3);
    });

    it('should handle rapid clicks', async () => {
      const onArchive = vi.fn();
      render(<ResourceActionsPanel {...defaultProps} onArchive={onArchive} isArchived={false} />);

      const archiveButton = screen.getByRole('button', { name: /📦.*Archive/ });

      // Simulate rapid clicks
      await userEvent.click(archiveButton);
      await userEvent.click(archiveButton);

      expect(onArchive).toHaveBeenCalledTimes(2);
    });
  });

  describe('Styling and Appearance', () => {
    it('should have proper panel structure', () => {
      const { container } = render(<ResourceActionsPanel {...defaultProps} />);

      const panel = container.firstChild as HTMLElement;
      expect(panel).toHaveClass('space-y-4');
    });

    it('should have proper title styling', () => {
      render(<ResourceActionsPanel {...defaultProps} />);

      const title = screen.getByText('Actions');
      expect(title).toHaveClass('text-sm', 'font-semibold', 'mb-3');
    });

    it('should support dark mode', () => {
      render(<ResourceActionsPanel {...defaultProps} isArchived={false} />);

      const archiveButton = screen.getByRole('button', { name: /📦.*Archive/ });
      expect(archiveButton).toHaveClass('dark:bg-gray-800', 'dark:text-red-400', 'dark:border-red-700');
    });

    it('should have full-width buttons', () => {
      render(<ResourceActionsPanel {...defaultProps} />);

      const cloneButton = screen.getByText(/Clone/).closest('button');
      expect(cloneButton).toHaveClass('w-full');
    });

    it('should center button content', () => {
      render(<ResourceActionsPanel {...defaultProps} />);

      const cloneButton = screen.getByText(/Clone/).closest('button');
      expect(cloneButton).toHaveClass('justify-center');
    });

    it('should have proper spacing for descriptions', () => {
      render(<ResourceActionsPanel {...defaultProps} />);

      const description = screen.getByText('Create a copy of this resource');
      expect(description).toHaveClass('text-xs', 'mt-1');
    });
  });

  describe('Accessibility', () => {
    it('should have semantic heading', () => {
      render(<ResourceActionsPanel {...defaultProps} />);

      const heading = screen.getByText('Actions');
      expect(heading.tagName).toBe('H3');
    });

    it('should have clickable buttons', () => {
      render(<ResourceActionsPanel {...defaultProps} />);

      const cloneButton = screen.getByText(/Clone/).closest('button');
      expect(cloneButton?.tagName).toBe('BUTTON');
    });

    it('should have hover states', () => {
      render(<ResourceActionsPanel {...defaultProps} isArchived={false} />);

      const archiveButton = screen.getByRole('button', { name: /📦.*Archive/ });
      expect(archiveButton).toHaveClass('hover:bg-red-50', 'dark:hover:bg-red-900/20');
    });

    it('should be keyboard navigable', () => {
      render(<ResourceActionsPanel {...defaultProps} />);

      const cloneButton = screen.getByText(/Clone/).closest('button');
      cloneButton?.focus();

      expect(cloneButton).toHaveFocus();
    });

    it('should have descriptive text for each action', () => {
      render(<ResourceActionsPanel {...defaultProps} isArchived={false} />);

      expect(screen.getByText('Create a copy of this resource')).toBeInTheDocument();
      expect(screen.getByText('Archive this resource (can be unarchived later)')).toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    it('should handle missing callbacks gracefully', () => {
      expect(() => {
        render(
          <ResourceActionsPanel
            isArchived={false}
            onArchive={undefined as any}
            onUnarchive={undefined as any}
            onClone={undefined as any}
          />
        );
      }).not.toThrow();
    });

    it('should render with minimal props', () => {
      expect(() => {
        render(<ResourceActionsPanel {...defaultProps} />);
      }).not.toThrow();
    });

    it('should handle boolean edge cases', () => {
      expect(() => {
        render(<ResourceActionsPanel {...defaultProps} isArchived={true} />);
        render(<ResourceActionsPanel {...defaultProps} isArchived={false} />);
      }).not.toThrow();
    });
  });

  describe('Button Interactions', () => {
    it('should not call wrong callbacks', async () => {
      const onArchive = vi.fn();
      const onUnarchive = vi.fn();
      const onClone = vi.fn();

      render(
        <ResourceActionsPanel
          isArchived={false}
          onArchive={onArchive}
          onUnarchive={onUnarchive}
          onClone={onClone}
        />
      );

      const cloneButton = screen.getByText(/Clone/);
      await userEvent.click(cloneButton);

      expect(onClone).toHaveBeenCalledOnce();
      expect(onArchive).not.toHaveBeenCalled();
      expect(onUnarchive).not.toHaveBeenCalled();
    });

    it('should only show relevant action button', () => {
      const { rerender } = render(<ResourceActionsPanel {...defaultProps} isArchived={false} />);

      // Should only have Archive, not Unarchive
      expect(screen.getAllByRole('button')).toHaveLength(2); // Clone + Archive

      rerender(<ResourceActionsPanel {...defaultProps} isArchived={true} />);

      // Should only have Unarchive, not Archive
      expect(screen.getAllByRole('button')).toHaveLength(2); // Clone + Unarchive
    });
  });

  describe('Visual Consistency', () => {
    it('should have consistent button widths', () => {
      render(<ResourceActionsPanel {...defaultProps} isArchived={false} />);

      const buttons = screen.getAllByRole('button');
      buttons.forEach(button => {
        expect(button).toHaveClass('w-full');
      });
    });

    it('should have consistent spacing', () => {
      const { container } = render(<ResourceActionsPanel {...defaultProps} />);

      const panel = container.firstChild as HTMLElement;
      expect(panel).toHaveClass('space-y-4');
    });

    it('should maintain layout across state changes', () => {
      const { rerender, container } = render(
        <ResourceActionsPanel {...defaultProps} isArchived={false} />
      );

      const structure1 = container.querySelector('.space-y-4');
      expect(structure1).toBeInTheDocument();

      rerender(<ResourceActionsPanel {...defaultProps} isArchived={true} />);

      const structure2 = container.querySelector('.space-y-4');
      expect(structure2).toBeInTheDocument();
    });
  });
});
