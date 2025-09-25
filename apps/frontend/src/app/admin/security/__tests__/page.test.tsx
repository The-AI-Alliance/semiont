import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { MockedFunction } from 'vitest'
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

// Mock the useSecureAPI hook
vi.mock('@/hooks/useSecureAPI', () => ({
  useSecureAPI: () => ({ hasValidToken: true })
}))

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
  const mockUseQuery = api.admin.oauth.config.useQuery as MockedFunction<typeof api.admin.oauth.config.useQuery>

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  describe('Page Structure and Header', () => {
    it('should render page title and description', () => {
      mockUseQuery.mockReturnValue({
        data: { providers: [], allowedDomains: [] },
        isLoading: false,
        error: null,
      } as any)

      render(
        <TestWrapper>
          <AdminSecurity />
        </TestWrapper>
      )

      expect(screen.getByText('OAuth Configuration')).toBeInTheDocument()
      expect(screen.getByText('View OAuth providers and allowed domains')).toBeInTheDocument()
    })

    it('should render OAuth providers section', () => {
      mockUseQuery.mockReturnValue({
        data: { providers: [], allowedDomains: [] },
        isLoading: false,
        error: null,
      } as any)

      render(
        <TestWrapper>
          <AdminSecurity />
        </TestWrapper>
      )

      expect(screen.getByText('OAuth Providers')).toBeInTheDocument()
      expect(screen.getByText('Configured authentication providers')).toBeInTheDocument()
    })

    it('should render allowed domains section', () => {
      mockUseQuery.mockReturnValue({
        data: { providers: [], allowedDomains: [] },
        isLoading: false,
        error: null,
      } as any)

      render(
        <TestWrapper>
          <AdminSecurity />
        </TestWrapper>
      )

      expect(screen.getByText('Allowed Email Domains')).toBeInTheDocument()
      expect(screen.getByText('Users from these domains can sign in')).toBeInTheDocument()
    })
  })

  describe('OAuth Providers Section', () => {
    it('should show loading state when fetching data', () => {
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: true,
        error: null,
      } as any)

      render(
        <TestWrapper>
          <AdminSecurity />
        </TestWrapper>
      )

      // Should show loading animations
      const loadingElements = document.querySelectorAll('.animate-pulse')
      expect(loadingElements.length).toBeGreaterThan(0)
    })

    it('should show Google OAuth as configured when present', () => {
      mockUseQuery.mockReturnValue({
        data: {
          providers: [
            { name: 'google', clientId: 'test-client-id.apps.googleusercontent.com' }
          ],
          allowedDomains: []
        },
        isLoading: false,
        error: null,
      } as any)

      render(
        <TestWrapper>
          <AdminSecurity />
        </TestWrapper>
      )

      // Provider name is capitalized by the component - use exact text match
      expect(screen.getByText('google')).toBeInTheDocument()
      expect(screen.getByText(/Client ID:.*test-client-id/)).toBeInTheDocument()
      expect(screen.getByText('Configured')).toBeInTheDocument()
    })

    it('should show no providers message when empty', () => {
      mockUseQuery.mockReturnValue({
        data: { providers: [], allowedDomains: [] },
        isLoading: false,
        error: null,
      } as any)

      render(
        <TestWrapper>
          <AdminSecurity />
        </TestWrapper>
      )

      expect(screen.getByText('No OAuth providers configured')).toBeInTheDocument()
    })
  })

  describe('Allowed Domains Section', () => {
    it('should display allowed domains when configured', () => {
      mockUseQuery.mockReturnValue({
        data: {
          providers: [],
          allowedDomains: ['example.com', 'test.org']
        },
        isLoading: false,
        error: null,
      } as any)

      render(
        <TestWrapper>
          <AdminSecurity />
        </TestWrapper>
      )

      expect(screen.getByText('@example.com')).toBeInTheDocument()
      expect(screen.getByText('@test.org')).toBeInTheDocument()
    })

    it('should show warning when no domains are configured', () => {
      mockUseQuery.mockReturnValue({
        data: { providers: [], allowedDomains: [] },
        isLoading: false,
        error: null,
      } as any)

      render(
        <TestWrapper>
          <AdminSecurity />
        </TestWrapper>
      )

      expect(screen.getByText('No allowed domains configured - all sign-ins will be rejected')).toBeInTheDocument()
    })
  })

  describe('Information Notice', () => {
    it('should display configuration information notice', () => {
      mockUseQuery.mockReturnValue({
        data: { providers: [], allowedDomains: [] },
        isLoading: false,
        error: null,
      } as any)

      render(
        <TestWrapper>
          <AdminSecurity />
        </TestWrapper>
      )

      expect(screen.getByText(/OAuth settings are managed through environment variables/)).toBeInTheDocument()
      // Check for configuration instructions
      expect(screen.getByText(/For local development: Update your .env files/)).toBeInTheDocument()
    })
  })

  describe('Error Handling', () => {
    it('should handle OAuth config API errors gracefully', async () => {
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: new Error('Failed to fetch OAuth config'),
      } as any)

      render(
        <TestWrapper>
          <AdminSecurity />
        </TestWrapper>
      )

      // Should still show the page structure
      expect(screen.getByText('OAuth Configuration')).toBeInTheDocument()
      
      // Should show error state or fallback to empty state
      await waitFor(() => {
        expect(screen.getByText('No OAuth providers configured')).toBeInTheDocument()
      })
    })
  })
})