import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Mock, MockedFunction } from 'vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'
import { getServerSession } from 'next-auth'
import { notFound } from 'next/navigation'
import { AdminAuthWrapper } from '../AdminAuthWrapper'

// Mock next-auth
vi.mock('next-auth')
const mockGetServerSession = getServerSession as MockedFunction<typeof getServerSession>

// Mock next/navigation
vi.mock('next/navigation', () => ({
  notFound: vi.fn()
}))
const mockNotFound = notFound as MockedFunction<typeof notFound>

describe('AdminAuthWrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should call notFound for unauthenticated users', async () => {
    // Mock no session (unauthenticated)
    mockGetServerSession.mockResolvedValue(null)

    const TestComponent = () => <div>Admin Content</div>
    
    await AdminAuthWrapper({ children: <TestComponent /> })

    // Should call notFound
    expect(mockNotFound).toHaveBeenCalledTimes(1)
  })

  it('should call notFound for authenticated non-admin users', async () => {
    // Mock session for non-admin user
    mockGetServerSession.mockResolvedValue({
      user: { email: 'user@example.com' },
      backendUser: { 
        id: '1',
        email: 'user@example.com',
        name: 'Test User',
        domain: 'example.com',
        provider: 'google',
        isAdmin: false,
        isActive: true,
        lastLogin: null,
        created: '2024-01-01',
        updatedAt: '2024-01-01'
      },
      expires: '2024-12-31'
    } as any)

    const TestComponent = () => <div>Admin Content</div>
    
    await AdminAuthWrapper({ children: <TestComponent /> })

    // Should call notFound
    expect(mockNotFound).toHaveBeenCalledTimes(1)
  })

  it('should render children for authenticated admin users', async () => {
    // Mock session for admin user
    mockGetServerSession.mockResolvedValue({
      user: { email: 'admin@example.com' },
      backendUser: { 
        id: '2',
        email: 'admin@example.com',
        name: 'Admin User',
        domain: 'example.com',
        provider: 'google',
        isAdmin: true,
        isActive: true,
        lastLogin: null,
        created: '2024-01-01',
        updatedAt: '2024-01-01'
      },
      expires: '2024-12-31'
    } as any)

    const TestComponent = () => <div>Admin Content</div>
    
    const { container } = render(
      await AdminAuthWrapper({ children: <TestComponent /> })
    )

    // Should NOT call notFound
    expect(mockNotFound).not.toHaveBeenCalled()
    
    // Should show admin content
    expect(screen.getByText('Admin Content')).toBeInTheDocument()
  })

  it('should handle missing backendUser data', async () => {
    // Mock session without backendUser
    mockGetServerSession.mockResolvedValue({
      user: { email: 'user@example.com' },
      expires: '2024-12-31'
    } as any)

    const TestComponent = () => <div>Admin Content</div>
    
    await AdminAuthWrapper({ children: <TestComponent /> })

    // Should call notFound (no backendUser means not admin)
    expect(mockNotFound).toHaveBeenCalledTimes(1)
  })

  describe('Security regression tests', () => {
    it('should never expose admin content to non-admins', async () => {
      // Test various non-admin scenarios
      const nonAdminScenarios = [
        null, // No session
        { user: { email: 'test@example.com' } }, // No backendUser
        { user: { email: 'test@example.com' }, backendUser: { isAdmin: false } }, // Explicitly not admin
        { user: { email: 'test@example.com' }, backendUser: { } }, // Missing isAdmin field
      ]

      for (const session of nonAdminScenarios) {
        mockGetServerSession.mockResolvedValue(session as any)
        mockNotFound.mockClear()

        await AdminAuthWrapper({ children: <div>Sensitive Admin Data</div> })
        
        expect(mockNotFound).toHaveBeenCalledTimes(1)
      }
    })

    it('should only allow access when explicitly admin', async () => {
      // Only this exact scenario should allow access
      mockGetServerSession.mockResolvedValue({
        user: { email: 'admin@example.com' },
        backendUser: { isAdmin: true },
        expires: '2024-12-31'
      } as any)

      const { container } = render(
        await AdminAuthWrapper({ children: <div>Admin Panel</div> })
      )

      expect(mockNotFound).not.toHaveBeenCalled()
      expect(screen.getByText('Admin Panel')).toBeInTheDocument()
    })
  })
})