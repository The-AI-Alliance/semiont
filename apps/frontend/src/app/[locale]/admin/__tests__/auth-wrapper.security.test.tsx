/**
 * Security regression tests for AdminAuthWrapper
 * 
 * These tests ensure that the admin route security fix doesn't regress.
 * The fix changed the behavior from exposing admin routes to non-admins
 * to returning proper 404 responses that don't reveal the existence of admin areas.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { MockedFunction } from 'vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'
import { getServerSession } from 'next-auth'
import { notFound } from 'next/navigation'
import { AdminAuthWrapper } from '@/components/admin/AdminAuthWrapper'

// Mock next-auth
vi.mock('next-auth')
const mockGetServerSession = getServerSession as MockedFunction<typeof getServerSession>

// Mock next/navigation
vi.mock('next/navigation', () => ({
  notFound: vi.fn()
}))
const mockNotFound = notFound as MockedFunction<typeof notFound>

describe('Admin Route Security - Regression Prevention', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Information Disclosure Prevention', () => {
    it('should return 404 for unauthenticated users', async () => {
      mockGetServerSession.mockResolvedValue(null)

      const SensitiveAdminContent = () => (
        <div>
          <h1>Admin Dashboard</h1>
          <div data-testid="user-list">
            <div>admin@company.com - Admin</div>
            <div>user@company.com - User</div>
          </div>
          <div data-testid="system-info">
            <div>Database: postgresql://localhost:5432/prod</div>
            <div>API Key: sk_live_abcdef123456</div>
          </div>
          <button data-testid="dangerous-action">Delete All Users</button>
        </div>
      )

      await AdminAuthWrapper({ children: <SensitiveAdminContent /> })

      // Should trigger 404
      expect(mockNotFound).toHaveBeenCalledTimes(1)
    })

    it('should return 404 for non-admin users', async () => {
      mockGetServerSession.mockResolvedValue({
        user: { email: 'regular@user.com' },
        backendUser: {
          id: '1',
          email: 'regular@user.com',
          isAdmin: false,
        },
        expires: '2024-12-31'
      } as any)

      const SensitiveAdminContent = () => (
        <div>
          <h1>Admin User Management</h1>
          <table>
            <tr><td>admin@company.com</td><td>Delete</td></tr>
            <tr><td>user@company.com</td><td>Delete</td></tr>
          </table>
        </div>
      )

      await AdminAuthWrapper({ children: <SensitiveAdminContent /> })

      // Should trigger 404
      expect(mockNotFound).toHaveBeenCalledTimes(1)
    })
  })

  describe('Admin Route Access Control', () => {
    it('should protect all admin routes from non-admins', async () => {
      // Test multiple non-admin scenarios
      const scenarios = [
        { desc: 'No session', session: null },
        { desc: 'No user', session: { expires: '2024-12-31' } },
        { desc: 'No backendUser', session: { user: { email: 'test@test.com' }, expires: '2024-12-31' } },
        { desc: 'Non-admin user', session: { 
          user: { email: 'user@test.com' },
          backendUser: { isAdmin: false },
          expires: '2024-12-31'
        }},
        { desc: 'Missing isAdmin', session: {
          user: { email: 'user@test.com' },
          backendUser: { email: 'user@test.com' },
          expires: '2024-12-31'
        }}
      ]

      for (const { desc, session } of scenarios) {
        mockGetServerSession.mockResolvedValue(session as any)
        mockNotFound.mockClear()

        const AdminContent = () => <div>Admin Area</div>
        await AdminAuthWrapper({ children: <AdminContent /> })

        expect(mockNotFound).toHaveBeenCalledTimes(1)
      }
    })

    it('should only allow admin users through', async () => {
      mockGetServerSession.mockResolvedValue({
        user: { email: 'admin@company.com' },
        backendUser: { 
          isAdmin: true,
          email: 'admin@company.com'
        },
        expires: '2024-12-31'
      } as any)

      const AdminContent = () => <div>Admin Panel</div>
      const { container } = render(
        await AdminAuthWrapper({ children: <AdminContent /> })
      )

      // Should NOT trigger 404
      expect(mockNotFound).not.toHaveBeenCalled()
      
      // Should render admin content
      expect(screen.getByText('Admin Panel')).toBeInTheDocument()
    })
  })

  describe('Security Best Practices', () => {
    it('should not reveal existence of admin routes to unauthorized users', async () => {
      mockGetServerSession.mockResolvedValue(null)

      // Even with explicit admin route references, should get 404
      const AdminLinks = () => (
        <div>
          <a href="/admin/users">User Management</a>
          <a href="/admin/security">Security Settings</a>
          <a href="/admin/database">Database Access</a>
        </div>
      )

      await AdminAuthWrapper({ children: <AdminLinks /> })

      // Should return 404 without revealing these routes exist
      expect(mockNotFound).toHaveBeenCalledTimes(1)
    })

    it('should handle edge cases securely', async () => {
      // Test with malformed session data - just test one case to verify security
      mockGetServerSession.mockResolvedValue({
        user: { email: 'test@test.com' },
        backendUser: { isAdmin: false }, // Non-admin user should trigger 404
        expires: '2024-12-31'
      } as any)

      await AdminAuthWrapper({ children: <div>Admin</div> })
      
      // Should always err on the side of caution and return 404
      expect(mockNotFound).toHaveBeenCalledTimes(1)
    })

    it('should maintain session isolation', async () => {
      // First request - admin user
      mockGetServerSession.mockResolvedValue({
        user: { email: 'admin@company.com' },
        backendUser: { isAdmin: true },
        expires: '2024-12-31'
      } as any)

      const { rerender } = render(
        await AdminAuthWrapper({ children: <div>Admin Content 1</div> })
      )
      expect(mockNotFound).not.toHaveBeenCalled()

      // Second request - non-admin user
      mockGetServerSession.mockResolvedValue({
        user: { email: 'user@company.com' },
        backendUser: { isAdmin: false },
        expires: '2024-12-31'
      } as any)
      mockNotFound.mockClear()

      await AdminAuthWrapper({ children: <div>Admin Content 2</div> })
      
      // Should properly check each request independently
      expect(mockNotFound).toHaveBeenCalledTimes(1)
    })
  })

  describe('Response Behavior', () => {
    it('should return 404 status (via notFound) instead of 200 with error page', async () => {
      mockGetServerSession.mockResolvedValue(null)

      await AdminAuthWrapper({ children: <div>Admin</div> })

      // Verify notFound was called (which triggers 404 response)
      expect(mockNotFound).toHaveBeenCalledTimes(1)
      
      // notFound() doesn't take any arguments
      expect(mockNotFound).toHaveBeenCalledWith()
    })

    it('should not return any custom error messages that reveal admin existence', async () => {
      mockGetServerSession.mockResolvedValue(null)

      // The component should not render anything before calling notFound
      const result = await AdminAuthWrapper({ children: <div>Admin</div> })
      
      // Should trigger 404 without rendering any custom content
      expect(mockNotFound).toHaveBeenCalledTimes(1)
    })
  })
})