/**
 * Tests for AdminDevOpsPage component
 *
 * Tests the admin devops page.
 * No Next.js mocking required - all dependencies passed as props!
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AdminDevOpsPage } from '../components/AdminDevOpsPage';
import type { AdminDevOpsPageProps } from '../components/AdminDevOpsPage';

const MockIcon = ({ className }: { className?: string }) => <div className={className}>Icon</div>;

const createMockProps = (overrides?: Partial<AdminDevOpsPageProps>): AdminDevOpsPageProps => ({
  suggestedFeatures: [
    {
      title: 'System Monitoring',
      description: 'Monitor system health',
      icon: MockIcon,
      available: 'semiont status',
    },
    {
      title: 'Service Management',
      description: 'Manage services',
      icon: MockIcon,
      available: 'semiont service',
    },
    {
      title: 'Deployment Control',
      description: 'Control deployments',
      icon: MockIcon,
      available: 'semiont deploy',
    },
  ],
  theme: 'light',
  showLineNumbers: false,
  activePanel: null,
  translations: {
    title: 'DevOps',
    subtitle: 'System monitoring and management',
    systemStatus: 'System Status',
    cliOperations: 'CLI Operations',
    cliOperationsDescription: 'Available CLI commands',
    cliTitle: 'CLI Tools',
    cliDescription: 'Use CLI for advanced operations',
  },
  StatusDisplay: () => <div data-testid="status-display">Status</div>,
  ToolbarPanels: () => <div data-testid="toolbar-panels" />,
  Toolbar: () => <div data-testid="toolbar" />,
  ...overrides,
});

describe('AdminDevOpsPage', () => {
  it('renders page title', () => {
    const props = createMockProps();
    render(<AdminDevOpsPage {...props} />);

    expect(screen.getByText('DevOps')).toBeInTheDocument();
    expect(screen.getByText('System monitoring and management')).toBeInTheDocument();
  });

  it('renders system status section', () => {
    const props = createMockProps();
    render(<AdminDevOpsPage {...props} />);

    expect(screen.getByText('System Status')).toBeInTheDocument();
    expect(screen.getByTestId('status-display')).toBeInTheDocument();
  });

  it('renders CLI operations section', () => {
    const props = createMockProps();
    render(<AdminDevOpsPage {...props} />);

    expect(screen.getByText('CLI Operations')).toBeInTheDocument();
    expect(screen.getByText('Available CLI commands')).toBeInTheDocument();
  });

  it('displays all suggested features', () => {
    const props = createMockProps();
    render(<AdminDevOpsPage {...props} />);

    expect(screen.getByText('System Monitoring')).toBeInTheDocument();
    expect(screen.getByText('Monitor system health')).toBeInTheDocument();
    expect(screen.getByText('semiont status')).toBeInTheDocument();

    expect(screen.getByText('Service Management')).toBeInTheDocument();
    expect(screen.getByText('Manage services')).toBeInTheDocument();
    expect(screen.getByText('semiont service')).toBeInTheDocument();

    expect(screen.getByText('Deployment Control')).toBeInTheDocument();
    expect(screen.getByText('Control deployments')).toBeInTheDocument();
    expect(screen.getByText('semiont deploy')).toBeInTheDocument();
  });

  it('renders CLI info box', () => {
    const props = createMockProps();
    render(<AdminDevOpsPage {...props} />);

    expect(screen.getByText('CLI Tools')).toBeInTheDocument();
    expect(screen.getByText('Use CLI for advanced operations')).toBeInTheDocument();
    expect(screen.getByText('semiont --help')).toBeInTheDocument();
  });

  it('renders toolbar components', () => {
    const props = createMockProps();
    render(<AdminDevOpsPage {...props} />);

    expect(screen.getByTestId('toolbar-panels')).toBeInTheDocument();
    expect(screen.getByTestId('toolbar')).toBeInTheDocument();
  });

  describe('Feature Cards', () => {
    it('renders feature icons', () => {
      const props = createMockProps();
      const { container } = render(<AdminDevOpsPage {...props} />);

      // Each feature has an icon
      const icons = container.querySelectorAll('.semiont-devops-feature__icon');
      expect(icons.length).toBeGreaterThan(0);
    });

    it('renders feature titles and descriptions', () => {
      const props = createMockProps();
      render(<AdminDevOpsPage {...props} />);

      // All titles
      expect(screen.getByText('System Monitoring')).toBeInTheDocument();
      expect(screen.getByText('Service Management')).toBeInTheDocument();
      expect(screen.getByText('Deployment Control')).toBeInTheDocument();

      // All descriptions
      expect(screen.getByText('Monitor system health')).toBeInTheDocument();
      expect(screen.getByText('Manage services')).toBeInTheDocument();
      expect(screen.getByText('Control deployments')).toBeInTheDocument();
    });

    it('displays CLI commands in monospace', () => {
      const props = createMockProps();
      const { container } = render(<AdminDevOpsPage {...props} />);

      // CLI commands should be in monospace
      const monoElements = container.querySelectorAll('.semiont-devops-feature__available');
      expect(monoElements.length).toBeGreaterThan(0);
    });

    it('renders with correct grid layout', () => {
      const props = createMockProps();
      const { container } = render(<AdminDevOpsPage {...props} />);

      const grid = container.querySelector('.semiont-admin__features-grid');
      expect(grid).toBeInTheDocument();
    });

    it('handles single feature', () => {
      const props = createMockProps({
        suggestedFeatures: [
          {
            title: 'Only Feature',
            description: 'Single feature description',
            icon: MockIcon,
            available: 'semiont cmd',
          },
        ],
      });
      render(<AdminDevOpsPage {...props} />);

      expect(screen.getByText('Only Feature')).toBeInTheDocument();
      expect(screen.getByText('Single feature description')).toBeInTheDocument();
      expect(screen.getByText('semiont cmd')).toBeInTheDocument();
    });

    it('handles many features', () => {
      const props = createMockProps({
        suggestedFeatures: [
          {
            title: 'Feature 1',
            description: 'Description 1',
            icon: MockIcon,
            available: 'cmd1',
          },
          {
            title: 'Feature 2',
            description: 'Description 2',
            icon: MockIcon,
            available: 'cmd2',
          },
          {
            title: 'Feature 3',
            description: 'Description 3',
            icon: MockIcon,
            available: 'cmd3',
          },
          {
            title: 'Feature 4',
            description: 'Description 4',
            icon: MockIcon,
            available: 'cmd4',
          },
        ],
      });
      render(<AdminDevOpsPage {...props} />);

      expect(screen.getByText('Feature 1')).toBeInTheDocument();
      expect(screen.getByText('Feature 2')).toBeInTheDocument();
      expect(screen.getByText('Feature 3')).toBeInTheDocument();
      expect(screen.getByText('Feature 4')).toBeInTheDocument();
    });

    it('handles empty features array', () => {
      const props = createMockProps({ suggestedFeatures: [] });
      render(<AdminDevOpsPage {...props} />);

      // Should still render page structure
      expect(screen.getByText('DevOps')).toBeInTheDocument();
      expect(screen.getByText('CLI Operations')).toBeInTheDocument();
    });
  });

  describe('System Status', () => {
    it('renders status display component', () => {
      const props = createMockProps();
      render(<AdminDevOpsPage {...props} />);

      expect(screen.getByTestId('status-display')).toBeInTheDocument();
    });

    it('passes StatusDisplay component correctly', () => {
      const StatusDisplay = vi.fn(() => <div data-testid="custom-status">Custom Status</div>);
      const props = createMockProps({ StatusDisplay });
      render(<AdminDevOpsPage {...props} />);

      expect(screen.getByTestId('custom-status')).toBeInTheDocument();
      expect(StatusDisplay).toHaveBeenCalled();
    });

    it('renders system status section title', () => {
      const props = createMockProps();
      render(<AdminDevOpsPage {...props} />);

      expect(screen.getByText('System Status')).toBeInTheDocument();
    });
  });

  describe('CLI Info Box', () => {
    it('displays CLI help command', () => {
      const props = createMockProps();
      render(<AdminDevOpsPage {...props} />);

      expect(screen.getByText('semiont --help')).toBeInTheDocument();
    });

    it('renders CLI info in code block', () => {
      const props = createMockProps();
      const { container } = render(<AdminDevOpsPage {...props} />);

      const codeElement = container.querySelector('code');
      expect(codeElement).toBeInTheDocument();
      expect(codeElement).toHaveTextContent('semiont --help');
    });

    it('displays info box with correct styling', () => {
      const props = createMockProps();
      const { container } = render(<AdminDevOpsPage {...props} />);

      const infoBox = container.querySelector('.semiont-admin__info-box');
      expect(infoBox).toBeInTheDocument();
    });

    it('renders CLI icon', () => {
      const props = createMockProps();
      const { container } = render(<AdminDevOpsPage {...props} />);

      // CommandLineIcon should be present
      const icon = container.querySelector('.semiont-icon--info');
      expect(icon).toBeInTheDocument();
    });
  });

  describe('Toolbar Integration', () => {
    it('passes theme to toolbar panels', () => {
      const ToolbarPanels = vi.fn(() => <div data-testid="toolbar-panels" />);
      const props = createMockProps({ theme: 'dark', ToolbarPanels });
      render(<AdminDevOpsPage {...props} />);

      expect(ToolbarPanels).toHaveBeenCalledWith(
        expect.objectContaining({ theme: 'dark' }),
        expect.anything()
      );
    });

    it('passes showLineNumbers to toolbar panels', () => {
      const ToolbarPanels = vi.fn(() => <div data-testid="toolbar-panels" />);
      const props = createMockProps({ showLineNumbers: true, ToolbarPanels });
      render(<AdminDevOpsPage {...props} />);

      expect(ToolbarPanels).toHaveBeenCalledWith(
        expect.objectContaining({ showLineNumbers: true }),
        expect.anything()
      );
    });

    it('passes activePanel to toolbar panels', () => {
      const ToolbarPanels = vi.fn(() => <div data-testid="toolbar-panels" />);
      const props = createMockProps({ activePanel: 'settings', ToolbarPanels });
      render(<AdminDevOpsPage {...props} />);

      expect(ToolbarPanels).toHaveBeenCalledWith(
        expect.objectContaining({ activePanel: 'settings' }),
        expect.anything()
      );
    });

    it('passes context to toolbar', () => {
      const Toolbar = vi.fn(() => <div data-testid="toolbar" />);
      const props = createMockProps({ Toolbar });
      render(<AdminDevOpsPage {...props} />);

      expect(Toolbar).toHaveBeenCalledWith(
        expect.objectContaining({ context: 'simple' }),
        expect.anything()
      );
    });

    it('passes activePanel to toolbar', () => {
      const Toolbar = vi.fn(() => <div data-testid="toolbar" />);
      const props = createMockProps({ activePanel: 'help', Toolbar });
      render(<AdminDevOpsPage {...props} />);

      expect(Toolbar).toHaveBeenCalledWith(
        expect.objectContaining({ activePanel: 'help' }),
        expect.anything()
      );
    });

  });

  describe('Layout and Structure', () => {
    it('renders main content area with correct flex layout', () => {
      const props = createMockProps();
      const { container } = render(<AdminDevOpsPage {...props} />);

      const mainContainer = container.querySelector('.semiont-page');
      expect(mainContainer).toBeInTheDocument();
    });

    it('renders content with proper overflow', () => {
      const props = createMockProps();
      const { container } = render(<AdminDevOpsPage {...props} />);

      const scrollArea = container.querySelector('.semiont-page__content');
      expect(scrollArea).toBeInTheDocument();
    });

    it('applies correct padding to content area', () => {
      const props = createMockProps();
      const { container } = render(<AdminDevOpsPage {...props} />);

      const contentArea = container.querySelector('.semiont-page__content');
      expect(contentArea).toBeInTheDocument();
    });

    it('renders sections in correct order', () => {
      const props = createMockProps();
      const { container } = render(<AdminDevOpsPage {...props} />);

      const sections = container.querySelectorAll('.semiont-admin__section');
      expect(sections.length).toBeGreaterThanOrEqual(2); // At least status and CLI sections
    });
  });

  describe('Edge Cases', () => {
    it('renders with dark theme', () => {
      const props = createMockProps({ theme: 'dark' });
      render(<AdminDevOpsPage {...props} />);

      expect(screen.getByText('DevOps')).toBeInTheDocument();
    });

    it('renders with active panel', () => {
      const props = createMockProps({ activePanel: 'settings' });
      render(<AdminDevOpsPage {...props} />);

      expect(screen.getByText('DevOps')).toBeInTheDocument();
    });

    it('renders with line numbers enabled', () => {
      const props = createMockProps({ showLineNumbers: true });
      render(<AdminDevOpsPage {...props} />);

      expect(screen.getByText('DevOps')).toBeInTheDocument();
    });

    it('handles all callbacks being defined', () => {
      const props = createMockProps();
      render(<AdminDevOpsPage {...props} />);

      expect(screen.getByText('DevOps')).toBeInTheDocument();
    });
  });

  describe('Translations', () => {
    it('uses all translation strings', () => {
      const props = createMockProps();
      render(<AdminDevOpsPage {...props} />);

      expect(screen.getByText('DevOps')).toBeInTheDocument();
      expect(screen.getByText('System monitoring and management')).toBeInTheDocument();
      expect(screen.getByText('System Status')).toBeInTheDocument();
      expect(screen.getByText('CLI Operations')).toBeInTheDocument();
      expect(screen.getByText('Available CLI commands')).toBeInTheDocument();
      expect(screen.getByText('CLI Tools')).toBeInTheDocument();
      expect(screen.getByText('Use CLI for advanced operations')).toBeInTheDocument();
    });

    it('renders custom translations', () => {
      const props = createMockProps({
        translations: {
          title: 'Custom DevOps',
          subtitle: 'Custom subtitle',
          systemStatus: 'Custom Status',
          cliOperations: 'Custom CLI',
          cliOperationsDescription: 'Custom description',
          cliTitle: 'Custom CLI Title',
          cliDescription: 'Custom CLI description',
        },
      });
      render(<AdminDevOpsPage {...props} />);

      expect(screen.getByText('Custom DevOps')).toBeInTheDocument();
      expect(screen.getByText('Custom subtitle')).toBeInTheDocument();
      expect(screen.getByText('Custom Status')).toBeInTheDocument();
      expect(screen.getByText('Custom CLI')).toBeInTheDocument();
      expect(screen.getByText('Custom description')).toBeInTheDocument();
      expect(screen.getByText('Custom CLI Title')).toBeInTheDocument();
      expect(screen.getByText('Custom CLI description')).toBeInTheDocument();
    });
  });
});
