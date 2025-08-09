import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@testing-library/jest-dom'
import AdminSecurity from '../client'
import { api } from '@/lib/api-client'

// Mock the API client
vi.mock('@/lib/api-client', () => ({
  api: {
    admin: {
      oauth: {
        config: {
          useQuery: vi.fn()
        }
      }
    }
  }
}))

// Mock environment variables
const originalEnv = process.env

// Test wrapper with React Query client
function TestWrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  })

  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  )
}

describe('AdminSecurity Page', () => {
  const mockUseQuery = api.admin.oauth.config.useQuery as vi.MockedFunction<typeof api.admin.oauth.config.useQuery>

  beforeEach(() => {
    vi.clearAllMocks()
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  describe('Page Structure and Header', () => {
    it('should render page title and description', () => {
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: null,
        isError: false,
      } as any)

      render(
        <TestWrapper>
          <AdminSecurity />
        </TestWrapper>
      )

      expect(screen.getByText('Security Settings')).toBeInTheDocument()
      expect(screen.getByText('Manage OAuth providers and authentication settings')).toBeInTheDocument()
    })

    it('should render security status section', () => {
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: null,
        isError: false,
      } as any)

      render(
        <TestWrapper>
          <AdminSecurity />
        </TestWrapper>
      )

      expect(screen.getByText('Security Status')).toBeInTheDocument()
      expect(screen.getByText('System Secure')).toBeInTheDocument()
      expect(screen.getByText('OAuth authentication is properly configured')).toBeInTheDocument()
    })

    it('should render all main configuration sections', () => {
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: null,
        isError: false,
      } as any)

      render(
        <TestWrapper>
          <AdminSecurity />
        </TestWrapper>
      )

      expect(screen.getByText('OAuth Providers')).toBeInTheDocument()
      expect(screen.getByText('Domain Access Control')).toBeInTheDocument()
      expect(screen.getByText('Session Configuration')).toBeInTheDocument()
      expect(screen.getByText('Secrets Management')).toBeInTheDocument()
    })
  })

  describe('OAuth Providers Section', () => {
    it('should show loading state while fetching OAuth config', () => {
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: true,
        error: null,
        isError: false,
      } as any)

      render(
        <TestWrapper>
          <AdminSecurity />
        </TestWrapper>
      )

      expect(screen.getByText('OAuth Providers')).toBeInTheDocument()
      
      // Should show loading skeletons
      const skeletons = document.querySelectorAll('.animate-pulse')
      expect(skeletons.length).toBeGreaterThan(0)
    })

    it('should render OAuth providers when not loading', () => {
      mockUseQuery.mockReturnValue({
        data: {
          success: true,
          providers: [
            { name: 'google', clientId: 'test-client-id', isConfigured: true },
            { name: 'github', clientId: undefined, isConfigured: false }
          ],
          allowedDomains: ['example.com']
        },
        isLoading: false,
        error: null,
        isError: false,
      } as any)

      process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID = 'test-google-client-id'

      render(
        <TestWrapper>
          <AdminSecurity />
        </TestWrapper>
      )

      expect(screen.getByText('Google OAuth')).toBeInTheDocument()
      expect(screen.getByText('GitHub OAuth')).toBeInTheDocument()
      expect(screen.getByText('OAuth provider for Google authentication')).toBeInTheDocument()
      expect(screen.getByText('OAuth provider for GitHub authentication')).toBeInTheDocument()
    })

    it('should show Google OAuth as configured when client ID is present', () => {
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: null,
        isError: false,
      } as any)

      process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID = 'test-google-client-id-12345678901234567890'

      render(
        <TestWrapper>
          <AdminSecurity />
        </TestWrapper>
      )

      expect(screen.getByText('Configured')).toBeInTheDocument()
      expect(screen.getByText('Client ID: test-google-client-i...')).toBeInTheDocument()
    })

    it('should show GitHub OAuth as not configured', () => {
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: null,
        isError: false,
      } as any)

      // Set Google as configured to differentiate from GitHub
      process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID = 'google-client-id'

      render(
        <TestWrapper>
          <AdminSecurity />
        </TestWrapper>
      )

      expect(screen.getByText('GitHub OAuth')).toBeInTheDocument()
      expect(screen.getAllByText('Not Configured')).toHaveLength(1) // Only GitHub should be not configured
    })

    it('should display AWS Secrets Manager configuration notice', () => {
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: null,
        isError: false,
      } as any)

      render(
        <TestWrapper>
          <AdminSecurity />
        </TestWrapper>
      )

      expect(screen.getByText('Configuration Note')).toBeInTheDocument()
      expect(screen.getAllByText(/OAuth credentials are securely stored in AWS Secrets Manager/)).toHaveLength(2) // Appears in both notice and main section
      expect(screen.getAllByText('semiont/oauth/google')).toHaveLength(2) // Appears in both notice and secrets sections
      expect(screen.getAllByText('semiont/oauth/github')).toHaveLength(2)
    })
  })

  describe('Domain Access Control Section', () => {
    it('should display domain access control section', () => {
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: null,
        isError: false,
      } as any)

      render(
        <TestWrapper>
          <AdminSecurity />
        </TestWrapper>
      )

      expect(screen.getByText('Domain Access Control')).toBeInTheDocument()
      expect(screen.getByText('Domains allowed to access the system via OAuth')).toBeInTheDocument()
    })

    it('should show domain configuration information', () => {
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: null,
        isError: false,
      } as any)

      render(
        <TestWrapper>
          <AdminSecurity />
        </TestWrapper>
      )

      expect(screen.getByText('Environment Variable: NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS')).toBeInTheDocument()
      // The component will show either domain list or "No Domain Restrictions" depending on env
    })

    it('should show warning when no domain restrictions are configured', () => {
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: null,
        isError: false,
      } as any)

      // Ensure NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS is not set
      delete process.env.NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS

      render(
        <TestWrapper>
          <AdminSecurity />
        </TestWrapper>
      )

      expect(screen.getByRole('heading', { name: /No Domain Restrictions/i })).toBeInTheDocument()
      expect(screen.getByText(/No domain restrictions are configured/i)).toBeInTheDocument()
      expect(screen.getByText(/Any email domain can access the system/i)).toBeInTheDocument()
    })

    it('should display environment variable configuration information', () => {
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: null,
        isError: false,
      } as any)

      process.env.NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS = 'example.com'

      render(
        <TestWrapper>
          <AdminSecurity />
        </TestWrapper>
      )

      expect(screen.getByText('Environment Variable: NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS')).toBeInTheDocument()
      expect(screen.getByText('Current Value: example.com')).toBeInTheDocument()
    })

    it('should show "Not set" when environment variable is undefined', () => {
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: null,
        isError: false,
      } as any)

      // Ensure the env var is not set
      delete process.env.NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS

      render(
        <TestWrapper>
          <AdminSecurity />
        </TestWrapper>
      )

      expect(screen.getByText('Current Value: Not set')).toBeInTheDocument()
    })
  })

  describe('Session Configuration Section', () => {
    it('should display session timeout and storage information', () => {
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: null,
        isError: false,
      } as any)

      render(
        <TestWrapper>
          <AdminSecurity />
        </TestWrapper>
      )

      expect(screen.getByText('Session Configuration')).toBeInTheDocument()
      expect(screen.getByText('Session Timeout')).toBeInTheDocument()
      expect(screen.getByText('8 hours')).toBeInTheDocument()
      expect(screen.getByText('Maximum session duration')).toBeInTheDocument()
      
      expect(screen.getByText('Session Storage')).toBeInTheDocument()
      expect(screen.getByText('JWT Tokens')).toBeInTheDocument()
      expect(screen.getByText('Secure, stateless authentication')).toBeInTheDocument()
    })
  })

  describe('Secrets Management Section', () => {
    it('should display AWS Secrets Manager information', () => {
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: null,
        isError: false,
      } as any)

      render(
        <TestWrapper>
          <AdminSecurity />
        </TestWrapper>
      )

      expect(screen.getByText('Secrets Management')).toBeInTheDocument()
      expect(screen.getAllByText(/OAuth credentials are securely stored in AWS Secrets Manager/)).toHaveLength(2) // Appears in both notice and main section
      expect(screen.getByText('Secret Structure')).toBeInTheDocument()
    })

    it('should show secret structure examples', () => {
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: null,
        isError: false,
      } as any)

      render(
        <TestWrapper>
          <AdminSecurity />
        </TestWrapper>
      )

      expect(screen.getAllByText('semiont/oauth/google')).toHaveLength(2) // Appears in notice and secrets sections
      expect(screen.getAllByText('semiont/oauth/github')).toHaveLength(2)
      
      // Check for JSON structure examples
      expect(screen.getAllByText(/"clientId": "...",/)).toHaveLength(2) // Two providers
      expect(screen.getAllByText(/"clientSecret": "..."/)).toHaveLength(2)
    })

    it('should display security best practice notice', () => {
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: null,
        isError: false,
      } as any)

      render(
        <TestWrapper>
          <AdminSecurity />
        </TestWrapper>
      )

      expect(screen.getByText('Security Best Practice')).toBeInTheDocument()
      expect(screen.getByText(/OAuth client secrets are never exposed to the frontend/)).toBeInTheDocument()
      expect(screen.getByText(/They are fetched server-side from AWS Secrets Manager/)).toBeInTheDocument()
    })
  })

  describe('Error Handling', () => {
    it('should handle OAuth config API errors gracefully', () => {
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: new Error('API Error'),
        isError: true,
      } as any)

      render(
        <TestWrapper>
          <AdminSecurity />
        </TestWrapper>
      )

      // Page should still render basic sections even if API fails
      expect(screen.getByText('Security Settings')).toBeInTheDocument()
      expect(screen.getByText('OAuth Providers')).toBeInTheDocument()
      
      // Should render static provider cards
      expect(screen.getByText('Google OAuth')).toBeInTheDocument()
      expect(screen.getByText('GitHub OAuth')).toBeInTheDocument()
    })

    it('should handle missing environment variables gracefully', () => {
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: null,
        isError: false,
      } as any)

      // Remove all OAuth-related env vars
      delete process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID
      delete process.env.NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS

      render(
        <TestWrapper>
          <AdminSecurity />
        </TestWrapper>
      )

      // Should show both Google and GitHub as not configured (total 2)
      expect(screen.getAllByText('Not Configured')).toHaveLength(2)
      
      // Should show no domain restrictions warning
      expect(screen.getByText('No Domain Restrictions')).toBeInTheDocument()
      expect(screen.getByText('Current Value: Not set')).toBeInTheDocument()
    })
  })

  describe('Accessibility and User Experience', () => {
    it('should have proper heading hierarchy', () => {
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: null,
        isError: false,
      } as any)

      render(
        <TestWrapper>
          <AdminSecurity />
        </TestWrapper>
      )

      // Main page heading
      expect(screen.getByRole('heading', { level: 1, name: 'Security Settings' })).toBeInTheDocument()
      
      // Section headings
      expect(screen.getByRole('heading', { level: 2, name: 'Security Status' })).toBeInTheDocument()
    })

    it('should use semantic HTML elements', () => {
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: null,
        isError: false,
      } as any)

      const { container } = render(
        <TestWrapper>
          <AdminSecurity />
        </TestWrapper>
      )

      // Should use proper semantic elements
      expect(container.querySelector('h1')).toBeInTheDocument()
      expect(container.querySelector('h2')).toBeInTheDocument()
      expect(container.querySelector('h3')).toBeInTheDocument()
    })

    it('should handle empty domain configuration without errors', () => {
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: null,
        isError: false,
      } as any)

      expect(() => {
        render(
          <TestWrapper>
            <AdminSecurity />
          </TestWrapper>
        )
      }).not.toThrow()

      expect(screen.getByText('Domain Access Control')).toBeInTheDocument()
    })

    it('should display domain configuration UI elements', () => {
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: null,
        isError: false,
      } as any)

      render(
        <TestWrapper>
          <AdminSecurity />
        </TestWrapper>
      )

      // Should render the configuration section regardless of domain values
      expect(screen.getByText('Configuration')).toBeInTheDocument()
      expect(screen.getByText('Environment Variable: NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS')).toBeInTheDocument()
    })
  })

  describe('Component Integration', () => {
    it('should render integration between OAuth API and environment variables', () => {
      mockUseQuery.mockReturnValue({
        data: {
          success: true,
          providers: [
            {
              name: 'google',
              clientId: '123456789012-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com',
              isConfigured: true,
              scopes: ['openid', 'email', 'profile']
            },
            {
              name: 'github',
              clientId: undefined,
              isConfigured: false
            }
          ],
          allowedDomains: ['company.com', 'contractor.company.com']
        },
        isLoading: false,
        error: null,
        isError: false,
      } as any)

      render(
        <TestWrapper>
          <AdminSecurity />
        </TestWrapper>
      )

      // Should show Google OAuth provider information
      expect(screen.getByText('Google OAuth')).toBeInTheDocument()
      expect(screen.getByText('GitHub OAuth')).toBeInTheDocument()
      
      // Should display domain access control section
      expect(screen.getByText('Domain Access Control')).toBeInTheDocument()
    })

    it('should display loading state properly during API fetch', async () => {
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: true,
        error: null,
        isError: false,
      } as any)

      render(
        <TestWrapper>
          <AdminSecurity />
        </TestWrapper>
      )

      // Should show loading skeletons for OAuth providers
      await waitFor(() => {
        const loadingElements = document.querySelectorAll('.animate-pulse')
        expect(loadingElements.length).toBeGreaterThan(0)
      })

      // Should still show static sections
      expect(screen.getByText('Session Configuration')).toBeInTheDocument()
      expect(screen.getByText('Secrets Management')).toBeInTheDocument()
    })
  })
})