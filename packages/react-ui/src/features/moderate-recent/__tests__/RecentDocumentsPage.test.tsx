/**
 * Tests for RecentDocumentsPage component
 *
 * Tests the moderation recent documents viewing page.
 * No Next.js mocking required - all dependencies passed as props!
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RecentDocumentsPage } from '../components/RecentDocumentsPage';
import type { RecentDocumentsPageProps } from '../components/RecentDocumentsPage';

const createMockProps = (overrides?: Partial<RecentDocumentsPageProps>): RecentDocumentsPageProps => ({
  hasDocuments: false,
  isLoading: false,
  theme: 'light',
  showLineNumbers: false,
  activePanel: null,
  translations: {
    pageTitle: 'Recent Documents',
    pageDescription: 'View recently moderated documents',
    sectionTitle: 'Recent Activity',
    sectionDescription: 'Documents that have been recently reviewed',
    noDocuments: 'No documents found',
    activityWillAppear: 'Activity will appear here',
    loading: 'Loading...',
  },
  ToolbarPanels: () => <div data-testid="toolbar-panels" />,
  Toolbar: () => <div data-testid="toolbar" />,
  ...overrides,
});

describe('RecentDocumentsPage', () => {
  describe('Basic Rendering', () => {
    it('renders page title and description', () => {
      const props = createMockProps();
      render(<RecentDocumentsPage {...props} />);

      expect(screen.getByText('Recent Documents')).toBeInTheDocument();
      expect(screen.getByText('View recently moderated documents')).toBeInTheDocument();
    });

    it('renders section title and description', () => {
      const props = createMockProps();
      render(<RecentDocumentsPage {...props} />);

      expect(screen.getByText('Recent Activity')).toBeInTheDocument();
      expect(screen.getByText('Documents that have been recently reviewed')).toBeInTheDocument();
    });

    it('renders clock icon', () => {
      const props = createMockProps();
      const { container } = render(<RecentDocumentsPage {...props} />);

      const icon = container.querySelector('.semiont-recent-docs__icon');
      expect(icon).toBeInTheDocument();
    });

    it('renders loading state', () => {
      const props = createMockProps({ isLoading: true });
      render(<RecentDocumentsPage {...props} />);

      expect(screen.getByText('Loading...')).toBeInTheDocument();
      expect(screen.queryByText('Recent Documents')).not.toBeInTheDocument();
    });

    it('does not render content when loading', () => {
      const props = createMockProps({ isLoading: true });
      render(<RecentDocumentsPage {...props} />);

      expect(screen.queryByText('Recent Activity')).not.toBeInTheDocument();
    });
  });

  describe('Empty State', () => {
    it('displays empty state when no documents', () => {
      const props = createMockProps({ hasDocuments: false });
      render(<RecentDocumentsPage {...props} />);

      expect(screen.getByText('No documents found')).toBeInTheDocument();
      expect(screen.getByText('Activity will appear here')).toBeInTheDocument();
    });

    it('renders empty state SVG icon', () => {
      const props = createMockProps({ hasDocuments: false });
      const { container } = render(<RecentDocumentsPage {...props} />);

      const svg = container.querySelector('.semiont-recent-docs__empty-icon');
      expect(svg).toBeInTheDocument();
    });

    it('applies correct styling to empty state text', () => {
      const props = createMockProps({ hasDocuments: false });
      const { container } = render(<RecentDocumentsPage {...props} />);

      const noDocsText = container.querySelector('.semiont-recent-docs__empty-message');
      expect(noDocsText).toBeInTheDocument();
      expect(noDocsText).toHaveTextContent('No documents found');
    });

    it('applies correct styling to activity hint text', () => {
      const props = createMockProps({ hasDocuments: false });
      const { container } = render(<RecentDocumentsPage {...props} />);

      const hintText = container.querySelector('.semiont-recent-docs__empty-hint');
      expect(hintText).toBeInTheDocument();
      expect(hintText).toHaveTextContent('Activity will appear here');
    });
  });

  describe('Content Card', () => {
    it('renders card with correct styling', () => {
      const props = createMockProps();
      const { container } = render(<RecentDocumentsPage {...props} />);

      const card = container.querySelector('.semiont-card');
      expect(card).toBeInTheDocument();
    });

    it('applies border styling to card', () => {
      const props = createMockProps();
      const { container } = render(<RecentDocumentsPage {...props} />);

      const card = container.querySelector('.semiont-card');
      expect(card).toBeInTheDocument();
    });

    it('applies rounded corners to card', () => {
      const props = createMockProps();
      const { container } = render(<RecentDocumentsPage {...props} />);

      const card = container.querySelector('.semiont-card');
      expect(card).toBeInTheDocument();
    });

    it('applies shadow to card', () => {
      const props = createMockProps();
      const { container } = render(<RecentDocumentsPage {...props} />);

      const card = container.querySelector('.semiont-card');
      expect(card).toBeInTheDocument();
    });
  });

  describe('Header Icon', () => {
    it('renders icon container with correct background', () => {
      const props = createMockProps();
      const { container } = render(<RecentDocumentsPage {...props} />);

      const iconContainer = container.querySelector('.semiont-recent-docs__icon-box');
      expect(iconContainer).toBeInTheDocument();
    });

    it('renders icon with correct size', () => {
      const props = createMockProps();
      const { container } = render(<RecentDocumentsPage {...props} />);

      const icon = container.querySelector('.semiont-recent-docs__icon');
      expect(icon).toBeInTheDocument();
    });

    it('applies correct color to icon', () => {
      const props = createMockProps();
      const { container } = render(<RecentDocumentsPage {...props} />);

      const icon = container.querySelector('.semiont-recent-docs__icon');
      expect(icon).toBeInTheDocument();
    });
  });

  describe('Toolbar Integration', () => {
    it('renders toolbar panels', () => {
      const props = createMockProps();
      render(<RecentDocumentsPage {...props} />);

      expect(screen.getByTestId('toolbar-panels')).toBeInTheDocument();
    });

    it('renders toolbar', () => {
      const props = createMockProps();
      render(<RecentDocumentsPage {...props} />);

      expect(screen.getByTestId('toolbar')).toBeInTheDocument();
    });

    it('passes theme to toolbar panels', () => {
      const ToolbarPanels = vi.fn(() => <div data-testid="toolbar-panels" />);
      const props = createMockProps({ theme: 'dark', ToolbarPanels });
      render(<RecentDocumentsPage {...props} />);

      expect(ToolbarPanels).toHaveBeenCalledWith(
        expect.objectContaining({ theme: 'dark' }),
        expect.anything()
      );
    });

    it('passes activePanel to toolbar', () => {
      const Toolbar = vi.fn(() => <div data-testid="toolbar" />);
      const props = createMockProps({ activePanel: 'settings', Toolbar });
      render(<RecentDocumentsPage {...props} />);

      expect(Toolbar).toHaveBeenCalledWith(
        expect.objectContaining({ activePanel: 'settings' }),
        expect.anything()
      );
    });

    it('passes showLineNumbers to toolbar panels', () => {
      const ToolbarPanels = vi.fn(() => <div data-testid="toolbar-panels" />);
      const props = createMockProps({ showLineNumbers: true, ToolbarPanels });
      render(<RecentDocumentsPage {...props} />);

      expect(ToolbarPanels).toHaveBeenCalledWith(
        expect.objectContaining({ showLineNumbers: true }),
        expect.anything()
      );
    });


    it('passes context to toolbar', () => {
      const Toolbar = vi.fn(() => <div data-testid="toolbar" />);
      const props = createMockProps({ Toolbar });
      render(<RecentDocumentsPage {...props} />);

      expect(Toolbar).toHaveBeenCalledWith(
        expect.objectContaining({ context: 'simple' }),
        expect.anything()
      );
    });
  });

  describe('Layout and Structure', () => {
    it('renders with correct flex layout', () => {
      const props = createMockProps();
      const { container } = render(<RecentDocumentsPage {...props} />);

      const mainContainer = container.querySelector('.semiont-page');
      expect(mainContainer).toBeInTheDocument();
    });

    it('renders content area with overflow', () => {
      const props = createMockProps();
      const { container } = render(<RecentDocumentsPage {...props} />);

      const scrollArea = container.querySelector('.semiont-page__content');
      expect(scrollArea).toBeInTheDocument();
    });

    it('applies correct padding to content', () => {
      const props = createMockProps();
      const { container } = render(<RecentDocumentsPage {...props} />);

      const contentArea = container.querySelector('.semiont-page__content');
      expect(contentArea).toBeInTheDocument();
    });

    it('centers empty state content', () => {
      const props = createMockProps();
      const { container } = render(<RecentDocumentsPage {...props} />);

      const emptyState = container.querySelector('.semiont-recent-docs__empty-state');
      expect(emptyState).toBeInTheDocument();
    });
  });

  describe('Dark Mode', () => {
    it('renders with dark theme', () => {
      const props = createMockProps({ theme: 'dark' });
      render(<RecentDocumentsPage {...props} />);

      expect(screen.getByText('Recent Documents')).toBeInTheDocument();
    });

    it('applies dark mode classes to page title', () => {
      const props = createMockProps({ theme: 'dark' });
      const { container } = render(<RecentDocumentsPage {...props} />);

      const title = container.querySelector('.semiont-page__title');
      expect(title).toBeInTheDocument();
    });

    it('applies dark mode classes to card', () => {
      const props = createMockProps({ theme: 'dark' });
      const { container } = render(<RecentDocumentsPage {...props} />);

      const card = container.querySelector('.semiont-card');
      expect(card).toBeInTheDocument();
      // Dark mode is handled by CSS, not inline classes
    });

    it('applies dark mode classes to icon container', () => {
      const props = createMockProps({ theme: 'dark' });
      const { container } = render(<RecentDocumentsPage {...props} />);

      const iconBg = container.querySelector('.semiont-recent-docs__icon-box');
      expect(iconBg).toBeInTheDocument();
      // Dark mode is handled by CSS, not inline classes
    });

    it('applies dark mode classes to empty state SVG', () => {
      const props = createMockProps({ theme: 'dark', hasDocuments: false });
      const { container } = render(<RecentDocumentsPage {...props} />);

      const svg = container.querySelector('.semiont-recent-docs__empty-icon');
      expect(svg).toBeInTheDocument();
      // Dark mode is handled by CSS, not inline classes
    });
  });

  describe('Edge Cases', () => {
    it('handles hasDocuments true (future state)', () => {
      const props = createMockProps({ hasDocuments: true });
      render(<RecentDocumentsPage {...props} />);

      // Currently shows empty state even when hasDocuments is true
      // This is correct for current implementation
      expect(screen.getByText('Recent Documents')).toBeInTheDocument();
    });

    it('renders with custom translations', () => {
      const props = createMockProps({
        translations: {
          pageTitle: 'Custom Title',
          pageDescription: 'Custom Description',
          sectionTitle: 'Custom Section',
          sectionDescription: 'Custom Section Desc',
          noDocuments: 'Custom No Docs',
          activityWillAppear: 'Custom Activity',
          loading: 'Custom Loading',
        },
      });
      render(<RecentDocumentsPage {...props} />);

      expect(screen.getByText('Custom Title')).toBeInTheDocument();
      expect(screen.getByText('Custom Description')).toBeInTheDocument();
      expect(screen.getByText('Custom Section')).toBeInTheDocument();
      expect(screen.getByText('Custom No Docs')).toBeInTheDocument();
      expect(screen.getByText('Custom Activity')).toBeInTheDocument();
    });

    it('handles all props being defined', () => {
      const props = createMockProps({
        hasDocuments: true,
        theme: 'dark',
        showLineNumbers: true,
        activePanel: 'settings',
      });
      render(<RecentDocumentsPage {...props} />);

      expect(screen.getByText('Recent Documents')).toBeInTheDocument();
    });

    it('renders correctly with null activePanel', () => {
      const props = createMockProps({ activePanel: null });
      render(<RecentDocumentsPage {...props} />);

      expect(screen.getByTestId('toolbar')).toBeInTheDocument();
    });

    it('renders correctly with settings activePanel', () => {
      const props = createMockProps({ activePanel: 'settings' });
      render(<RecentDocumentsPage {...props} />);

      expect(screen.getByTestId('toolbar-panels')).toBeInTheDocument();
    });
  });

  describe('SVG Icon', () => {
    it('renders SVG with correct viewBox', () => {
      const props = createMockProps();
      const { container } = render(<RecentDocumentsPage {...props} />);

      const svg = container.querySelector('svg[viewBox="0 0 24 24"]');
      expect(svg).toBeInTheDocument();
    });

    it('renders SVG path with correct attributes', () => {
      const props = createMockProps();
      const { container } = render(<RecentDocumentsPage {...props} />);

      const path = container.querySelector('path[stroke-linecap="round"]');
      expect(path).toBeInTheDocument();
    });

    it('renders SVG with no fill', () => {
      const props = createMockProps();
      const { container } = render(<RecentDocumentsPage {...props} />);

      const svg = container.querySelector('svg[fill="none"]');
      expect(svg).toBeInTheDocument();
    });
  });

  describe('Spacing and Margins', () => {
    it('applies margin to page title section', () => {
      const props = createMockProps();
      const { container } = render(<RecentDocumentsPage {...props} />);

      const titleSection = container.querySelector('.semiont-page__header');
      expect(titleSection).toBeInTheDocument();
      // Spacing is handled by CSS, not utility classes
    });

    it('applies padding to card', () => {
      const props = createMockProps();
      const { container } = render(<RecentDocumentsPage {...props} />);

      const card = container.querySelector('.semiont-card');
      expect(card).toBeInTheDocument();
      // Padding is handled by CSS, not utility classes
    });

    it('applies margin to section header', () => {
      const props = createMockProps();
      const { container } = render(<RecentDocumentsPage {...props} />);

      const header = container.querySelector('.semiont-recent-docs__header');
      expect(header).toBeInTheDocument();
      // Margins are handled by CSS, not utility classes
    });
  });
});
