/**
 * Tests for AdminSecurityPage component
 *
 * Tests the admin security configuration page.
 * No Next.js mocking required - all dependencies passed as props!
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AdminSecurityPage } from '../components/AdminSecurityPage';
import type { AdminSecurityPageProps, OAuthProvider } from '../components/AdminSecurityPage';

const createMockProvider = (overrides?: Partial<OAuthProvider>): OAuthProvider => ({
  name: 'google',
  clientId: 'test-client-id',
  ...overrides,
});

const createMockProps = (overrides?: Partial<AdminSecurityPageProps>): AdminSecurityPageProps => ({
  providers: [createMockProvider()],
  allowedDomains: ['example.com'],
  isLoading: false,
  theme: 'light',
  onThemeChange: vi.fn(),
  showLineNumbers: false,
  onLineNumbersToggle: vi.fn(),
  activePanel: null,
  onPanelToggle: vi.fn(),
  translations: {
    title: 'Security Settings',
    subtitle: 'Configure authentication and authorization',
    oauthProviders: 'OAuth Providers',
    oauthProvidersDescription: 'Configured OAuth providers',
    clientId: 'Client ID',
    configured: 'Configured',
    noProvidersConfigured: 'No providers configured',
    allowedDomains: 'Allowed Domains',
    allowedDomainsDescription: 'Domains allowed to sign in',
    noDomainsConfigured: 'No domains configured',
    configManagementTitle: 'Configuration Management',
    configManagementDescription: 'How to manage these settings',
    configLocalDev: 'Use .env.local for development',
    configCloudDeploy: 'Use',
    configCloudDeployCommand: 'semiont config set',
    configCloudDeployEnd: 'for cloud deployments',
    configAWS: 'Use AWS Secrets Manager for production',
  },
  ToolbarPanels: () => <div data-testid="toolbar-panels" />,
  Toolbar: () => <div data-testid="toolbar" />,
  ...overrides,
});

describe('AdminSecurityPage', () => {
  it('renders page title', () => {
    const props = createMockProps();
    render(<AdminSecurityPage {...props} />);

    expect(screen.getByText('Security Settings')).toBeInTheDocument();
    expect(screen.getByText('Configure authentication and authorization')).toBeInTheDocument();
  });

  it('renders OAuth providers section', () => {
    const props = createMockProps();
    render(<AdminSecurityPage {...props} />);

    expect(screen.getByText('OAuth Providers')).toBeInTheDocument();
    expect(screen.getByText('Configured OAuth providers')).toBeInTheDocument();
  });

  it('displays configured providers', () => {
    const props = createMockProps({
      providers: [
        createMockProvider({ name: 'google', clientId: 'google-client' }),
        createMockProvider({ name: 'github', clientId: 'github-client' }),
      ],
    });
    render(<AdminSecurityPage {...props} />);

    expect(screen.getByText('google')).toBeInTheDocument();
    expect(screen.getByText(/google-client/)).toBeInTheDocument();
    expect(screen.getByText('github')).toBeInTheDocument();
    expect(screen.getByText(/github-client/)).toBeInTheDocument();
  });

  it('shows empty state when no providers', () => {
    const props = createMockProps({ providers: [] });
    render(<AdminSecurityPage {...props} />);

    expect(screen.getByText('No providers configured')).toBeInTheDocument();
  });

  it('renders allowed domains section', () => {
    const props = createMockProps();
    render(<AdminSecurityPage {...props} />);

    expect(screen.getByText('Allowed Domains')).toBeInTheDocument();
    expect(screen.getByText('Domains allowed to sign in')).toBeInTheDocument();
  });

  it('displays configured domains', () => {
    const props = createMockProps({
      allowedDomains: ['example.com', 'test.org'],
    });
    render(<AdminSecurityPage {...props} />);

    expect(screen.getByText('@example.com')).toBeInTheDocument();
    expect(screen.getByText('@test.org')).toBeInTheDocument();
  });

  it('shows empty state when no domains', () => {
    const props = createMockProps({ allowedDomains: [] });
    render(<AdminSecurityPage {...props} />);

    expect(screen.getByText('No domains configured')).toBeInTheDocument();
  });

  it('shows loading state', () => {
    const props = createMockProps({ isLoading: true });
    const { container } = render(<AdminSecurityPage {...props} />);

    const skeletons = container.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('renders configuration info box', () => {
    const props = createMockProps();
    render(<AdminSecurityPage {...props} />);

    expect(screen.getByText('Configuration Management')).toBeInTheDocument();
    expect(screen.getByText('Use .env.local for development')).toBeInTheDocument();
  });

  it('renders toolbar components', () => {
    const props = createMockProps();
    render(<AdminSecurityPage {...props} />);

    expect(screen.getByTestId('toolbar-panels')).toBeInTheDocument();
    expect(screen.getByTestId('toolbar')).toBeInTheDocument();
  });

  describe('Provider Display Details', () => {
    it('displays provider without client ID', () => {
      const props = createMockProps({
        providers: [{ name: 'github' }],
      });
      render(<AdminSecurityPage {...props} />);

      expect(screen.getByText('github')).toBeInTheDocument();
      expect(screen.queryByText(/Client ID:/)).not.toBeInTheDocument();
    });

    it('capitalizes provider names', () => {
      const props = createMockProps({
        providers: [createMockProvider({ name: 'google' })],
      });
      const { container } = render(<AdminSecurityPage {...props} />);

      // Provider name should be capitalized via CSS
      const providerElement = container.querySelector('.capitalize');
      expect(providerElement).toBeInTheDocument();
      expect(providerElement).toHaveTextContent('google');
    });

    it('shows configured badge for all providers', () => {
      const props = createMockProps({
        providers: [
          createMockProvider({ name: 'google' }),
          createMockProvider({ name: 'github' }),
        ],
      });
      render(<AdminSecurityPage {...props} />);

      const badges = screen.getAllByText('Configured');
      expect(badges).toHaveLength(2);
    });

    it('displays multiple providers correctly', () => {
      const props = createMockProps({
        providers: [
          createMockProvider({ name: 'google', clientId: 'google-123' }),
          createMockProvider({ name: 'github', clientId: 'github-456' }),
          createMockProvider({ name: 'microsoft', clientId: 'ms-789' }),
        ],
      });
      render(<AdminSecurityPage {...props} />);

      expect(screen.getByText('google')).toBeInTheDocument();
      expect(screen.getByText(/google-123/)).toBeInTheDocument();
      expect(screen.getByText('github')).toBeInTheDocument();
      expect(screen.getByText(/github-456/)).toBeInTheDocument();
      expect(screen.getByText('microsoft')).toBeInTheDocument();
      expect(screen.getByText(/ms-789/)).toBeInTheDocument();
    });
  });

  describe('Domain Display Details', () => {
    it('formats single domain with @ prefix', () => {
      const props = createMockProps({
        allowedDomains: ['example.com'],
      });
      render(<AdminSecurityPage {...props} />);

      expect(screen.getByText('@example.com')).toBeInTheDocument();
    });

    it('displays multiple domains', () => {
      const props = createMockProps({
        allowedDomains: ['example.com', 'test.org', 'demo.net'],
      });
      render(<AdminSecurityPage {...props} />);

      expect(screen.getByText('@example.com')).toBeInTheDocument();
      expect(screen.getByText('@test.org')).toBeInTheDocument();
      expect(screen.getByText('@demo.net')).toBeInTheDocument();
    });

    it('displays domain badges with correct styling', () => {
      const props = createMockProps({
        allowedDomains: ['example.com'],
      });
      const { container } = render(<AdminSecurityPage {...props} />);

      const domainBadge = container.querySelector('.semiont-tag');
      expect(domainBadge).toBeInTheDocument();
      expect(domainBadge).toHaveTextContent('@example.com');
    });
  });

  describe('Loading States', () => {
    it('shows loading skeleton for providers section', () => {
      const props = createMockProps({ isLoading: true });
      const { container } = render(<AdminSecurityPage {...props} />);

      // Should have loading skeletons
      const skeletons = container.querySelectorAll('.animate-pulse');
      expect(skeletons.length).toBeGreaterThan(0);
    });

    it('shows loading skeleton for domains section', () => {
      const props = createMockProps({ isLoading: true });
      const { container } = render(<AdminSecurityPage {...props} />);

      // Multiple loading skeletons for both sections
      const skeletons = container.querySelectorAll('.animate-pulse');
      expect(skeletons.length).toBeGreaterThan(1);
    });

    it('hides data when loading', () => {
      const props = createMockProps({
        isLoading: true,
        providers: [createMockProvider()],
        allowedDomains: ['example.com'],
      });
      render(<AdminSecurityPage {...props} />);

      // Should not show actual data while loading
      expect(screen.queryByText('google')).not.toBeInTheDocument();
      expect(screen.queryByText('@example.com')).not.toBeInTheDocument();
    });
  });

  describe('Configuration Info', () => {
    it('displays all configuration instructions', () => {
      const props = createMockProps();
      render(<AdminSecurityPage {...props} />);

      expect(screen.getByText('Configuration Management')).toBeInTheDocument();
      expect(screen.getByText('How to manage these settings')).toBeInTheDocument();
      expect(screen.getByText('Use .env.local for development')).toBeInTheDocument();
      expect(screen.getByText('semiont config set')).toBeInTheDocument();
      expect(screen.getByText('Use AWS Secrets Manager for production')).toBeInTheDocument();
    });

    it('renders config command in code format', () => {
      const props = createMockProps();
      const { container } = render(<AdminSecurityPage {...props} />);

      const codeElement = container.querySelector('code');
      expect(codeElement).toBeInTheDocument();
      expect(codeElement).toHaveTextContent('semiont config set');
    });

    it('displays info box with correct styling', () => {
      const props = createMockProps();
      const { container } = render(<AdminSecurityPage {...props} />);

      const infoBox = container.querySelector('.bg-blue-50');
      expect(infoBox).toBeInTheDocument();
    });
  });

  describe('Toolbar Integration', () => {
    it('passes theme to toolbar panels', () => {
      const ToolbarPanels = vi.fn(({ theme }: any) => <div data-testid="toolbar-panels">{theme}</div>);
      const props = createMockProps({ theme: 'dark', ToolbarPanels });
      render(<AdminSecurityPage {...props} />);

      expect(ToolbarPanels).toHaveBeenCalledWith(
        expect.objectContaining({ theme: 'dark' }),
        expect.anything()
      );
    });

    it('passes active panel to toolbar', () => {
      const Toolbar = vi.fn(() => <div data-testid="toolbar" />);
      const props = createMockProps({ activePanel: 'settings', Toolbar });
      render(<AdminSecurityPage {...props} />);

      expect(Toolbar).toHaveBeenCalledWith(
        expect.objectContaining({ activePanel: 'settings' }),
        expect.anything()
      );
    });

    it('passes context to toolbar', () => {
      const Toolbar = vi.fn(() => <div data-testid="toolbar" />);
      const props = createMockProps({ Toolbar });
      render(<AdminSecurityPage {...props} />);

      expect(Toolbar).toHaveBeenCalledWith(
        expect.objectContaining({ context: 'simple' }),
        expect.anything()
      );
    });
  });

  describe('Edge Cases', () => {
    it('handles empty providers and domains gracefully', () => {
      const props = createMockProps({
        providers: [],
        allowedDomains: [],
      });
      render(<AdminSecurityPage {...props} />);

      expect(screen.getByText('No providers configured')).toBeInTheDocument();
      expect(screen.getByText('No domains configured')).toBeInTheDocument();
    });

    it('renders with dark theme', () => {
      const props = createMockProps({ theme: 'dark' });
      render(<AdminSecurityPage {...props} />);

      // Should render without errors
      expect(screen.getByText('Security Settings')).toBeInTheDocument();
    });

    it('renders with active panel', () => {
      const props = createMockProps({ activePanel: 'settings' });
      render(<AdminSecurityPage {...props} />);

      expect(screen.getByText('Security Settings')).toBeInTheDocument();
    });

    it('renders with line numbers enabled', () => {
      const props = createMockProps({ showLineNumbers: true });
      render(<AdminSecurityPage {...props} />);

      expect(screen.getByText('Security Settings')).toBeInTheDocument();
    });
  });
});
