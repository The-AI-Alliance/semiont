import { describe, it, expect, beforeEach, vi } from 'vitest'
import React from 'react'
import { render } from '@testing-library/react'
import { redirect } from 'next/navigation'
import AdminPage from '../page'

// Mock next/navigation
vi.mock('next/navigation')
const mockRedirect = redirect as vi.MockedFunction<typeof redirect>

describe('Admin Page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should redirect to admin dashboard', () => {
    // Render the admin page component
    render(<AdminPage />)

    // Should call redirect to dashboard
    expect(mockRedirect).toHaveBeenCalledWith('/admin/dashboard')
    expect(mockRedirect).toHaveBeenCalledTimes(1)
  })

  it('should not render any content that could leak information', () => {
    const { container } = render(<AdminPage />)

    // Should have no visible content since it just redirects
    expect(container.innerHTML).toBe('')
  })
})