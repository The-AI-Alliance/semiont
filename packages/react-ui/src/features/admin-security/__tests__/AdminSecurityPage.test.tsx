/**
 * Tests for AdminSecurityPage component
 *
 * The page reports one fact: the issuer this knowledge base trusts, and what it
 * requires in a token's audience. No Next.js mocking required — all
 * dependencies passed as props.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AdminSecurityPage } from '../components/AdminSecurityPage';
import type { AdminSecurityPageProps } from '../components/AdminSecurityPage';

const ISSUER = 'https://keycloak.example/realms/semiont';

const createMockProps = (overrides?: Partial<AdminSecurityPageProps>): AdminSecurityPageProps => ({
  issuer: ISSUER,
  audience: 'semiont-gateway',
  isLoading: false,
  theme: 'light',
  activePanel: null,
  translations: {
    title: 'Security Settings',
    subtitle: 'Configure authentication and authorization',
    oauthProviders: 'OAuth Providers',
    oauthProvidersDescription: 'Configured OAuth providers',
    clientId: 'Client ID',
    configured: 'Configured',
    noProvidersConfigured: 'No providers configured',
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
    render(<AdminSecurityPage {...createMockProps()} />);

    expect(screen.getByText('Security Settings')).toBeInTheDocument();
    expect(screen.getByText('Configure authentication and authorization')).toBeInTheDocument();
  });

  it('renders the identity provider section', () => {
    render(<AdminSecurityPage {...createMockProps()} />);

    expect(screen.getByText('OAuth Providers')).toBeInTheDocument();
    expect(screen.getByText('Configured OAuth providers')).toBeInTheDocument();
  });

  it('displays the trusted issuer and the audience it requires', () => {
    const { container } = render(<AdminSecurityPage {...createMockProps()} />);

    const name = container.querySelector('.semiont-provider-item__name');
    expect(name).toHaveTextContent(ISSUER);
    expect(screen.getByText(/semiont-gateway/)).toBeInTheDocument();
    expect(screen.getByText('Configured')).toBeInTheDocument();
  });

  it('omits the audience line when none is configured', () => {
    render(<AdminSecurityPage {...createMockProps({ audience: null })} />);

    expect(screen.getByText(ISSUER)).toBeInTheDocument();
    expect(screen.queryByText(/Client ID:/)).not.toBeInTheDocument();
  });

  it('shows the empty state when the knowledge base trusts no issuer', () => {
    render(<AdminSecurityPage {...createMockProps({ issuer: null, audience: null })} />);

    expect(screen.getByText('No providers configured')).toBeInTheDocument();
  });

  it('shows loading state', () => {
    const { container } = render(<AdminSecurityPage {...createMockProps({ isLoading: true })} />);

    const skeletons = container.querySelectorAll('.semiont-skeleton');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('hides the issuer while loading', () => {
    render(<AdminSecurityPage {...createMockProps({ isLoading: true })} />);

    expect(screen.queryByText(ISSUER)).not.toBeInTheDocument();
  });

  it('renders configuration info box', () => {
    const { container } = render(<AdminSecurityPage {...createMockProps()} />);

    expect(screen.getByText('Configuration Management')).toBeInTheDocument();
    expect(screen.getByText('How to manage these settings')).toBeInTheDocument();
    expect(screen.getByText('Use .env.local for development')).toBeInTheDocument();
    expect(screen.getByText('Use AWS Secrets Manager for production')).toBeInTheDocument();
    expect(container.querySelector('code')).toHaveTextContent('semiont config set');
    expect(container.querySelector('.semiont-admin__info-box')).toBeInTheDocument();
  });

  it('renders toolbar components', () => {
    render(<AdminSecurityPage {...createMockProps()} />);

    expect(screen.getByTestId('toolbar-panels')).toBeInTheDocument();
    expect(screen.getByTestId('toolbar')).toBeInTheDocument();
  });

  describe('Toolbar Integration', () => {
    it('passes theme to toolbar panels', () => {
      const ToolbarPanels = vi.fn(({ theme }: any) => <div data-testid="toolbar-panels">{theme}</div>);
      render(<AdminSecurityPage {...createMockProps({ theme: 'dark', ToolbarPanels })} />);

      expect(ToolbarPanels).toHaveBeenCalledWith(
        expect.objectContaining({ theme: 'dark' }),
        undefined,
      );
    });

    it('passes active panel to toolbar', () => {
      const Toolbar = vi.fn(() => <div data-testid="toolbar" />);
      render(<AdminSecurityPage {...createMockProps({ activePanel: 'settings', Toolbar })} />);

      expect(Toolbar).toHaveBeenCalledWith(
        expect.objectContaining({ activePanel: 'settings' }),
        undefined,
      );
    });

    it('passes context to toolbar', () => {
      const Toolbar = vi.fn(() => <div data-testid="toolbar" />);
      render(<AdminSecurityPage {...createMockProps({ Toolbar })} />);

      expect(Toolbar).toHaveBeenCalledWith(
        expect.objectContaining({ context: 'simple' }),
        undefined,
      );
    });
  });

  describe('Edge Cases', () => {
    it('renders with dark theme', () => {
      render(<AdminSecurityPage {...createMockProps({ theme: 'dark' })} />);

      expect(screen.getByText('Security Settings')).toBeInTheDocument();
    });

    it('renders with active panel', () => {
      render(<AdminSecurityPage {...createMockProps({ activePanel: 'settings' })} />);

      expect(screen.getByText('Security Settings')).toBeInTheDocument();
    });
  });
});
