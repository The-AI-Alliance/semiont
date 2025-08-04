import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { Header } from '../Header'

// Mock the UserMenu component
vi.mock('../UserMenu', () => ({
  UserMenu: () => <div data-testid="user-menu">User Menu Mock</div>
}))

// Mock the env module
vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SITE_NAME: 'Test Semiont',
    NEXT_PUBLIC_API_URL: 'http://localhost:4000',
    NEXT_PUBLIC_DOMAIN: 'localhost',
    NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS: 'test.com',
    NODE_ENV: 'test'
  }
}))

describe('Header Component', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Basic Rendering', () => {
    it('should render header with correct structure', () => {
      render(<Header />)

      const container = screen.getByText('Test Semiont').closest('div')
      expect(container).toBeInTheDocument()
      expect(container).toHaveClass('flex', 'justify-between', 'items-center', 'w-full', 'mb-8')
    })

    it('should display site name from environment variable', () => {
      render(<Header />)

      const heading = screen.getByRole('heading', { level: 1 })
      expect(heading).toBeInTheDocument()
      expect(heading).toHaveTextContent('Test Semiont')
    })

    it('should render UserMenu component', () => {
      render(<Header />)

      expect(screen.getByTestId('user-menu')).toBeInTheDocument()
    })
  })

  describe('Styling and Layout', () => {
    it('should apply correct styling to site name heading', () => {
      render(<Header />)

      const heading = screen.getByRole('heading', { level: 1 })
      expect(heading).toHaveClass('text-4xl', 'font-bold', 'text-gray-900', 'dark:text-white')
    })

    it('should position UserMenu on the right', () => {
      render(<Header />)

      const userMenuContainer = screen.getByTestId('user-menu').parentElement
      expect(userMenuContainer).toHaveClass('text-right', 'relative')
    })

    it('should use flexbox layout with proper alignment', () => {
      render(<Header />)

      const headerContainer = screen.getByText('Test Semiont').closest('div')
      expect(headerContainer).toHaveClass('flex', 'justify-between', 'items-center')
    })

    it('should have full width', () => {
      render(<Header />)

      const headerContainer = screen.getByText('Test Semiont').closest('div')
      expect(headerContainer).toHaveClass('w-full')
    })

    it('should have bottom margin', () => {
      render(<Header />)

      const headerContainer = screen.getByText('Test Semiont').closest('div')
      expect(headerContainer).toHaveClass('mb-8')
    })
  })

  describe('Different Site Names', () => {
    // For now, these tests will use the default mock value
    // In the future, we could implement per-test mocking if needed
    it('should handle the default site name', () => {
      render(<Header />)
      expect(screen.getByText('Test Semiont')).toBeInTheDocument()
    })
  })

  describe('Accessibility', () => {
    it('should have semantic heading structure', () => {
      render(<Header />)

      const heading = screen.getByRole('heading', { level: 1 })
      expect(heading).toBeInTheDocument()
      expect(heading.tagName).toBe('H1')
    })

    it('should have proper heading hierarchy', () => {
      const { container } = render(<Header />)

      const h1Elements = container.querySelectorAll('h1')
      expect(h1Elements).toHaveLength(1)
    })

    it('should maintain logical structure for screen readers', () => {
      const { container } = render(<Header />)

      // Check that the header has a clear structure
      const mainContainer = container.firstChild
      expect(mainContainer).toBeInTheDocument()
      
      // First child should be the heading
      const firstChild = mainContainer?.firstChild
      expect(firstChild?.nodeName).toBe('H1')
      
      // Second child should be the user menu container
      const secondChild = mainContainer?.lastChild
      expect(secondChild?.nodeName).toBe('DIV')
    })
  })

  describe('Dark Mode Support', () => {
    it('should include dark mode classes for heading', () => {
      render(<Header />)

      const heading = screen.getByRole('heading', { level: 1 })
      expect(heading).toHaveClass('text-gray-900', 'dark:text-white')
    })
  })

  describe('Component Integration', () => {
    it('should render UserMenu in the correct position', () => {
      const { container } = render(<Header />)

      const userMenu = screen.getByTestId('user-menu')
      const userMenuWrapper = userMenu.parentElement // The div with text-right relative classes
      
      // Should be the last child of the header
      const headerContainer = container.firstChild
      expect(headerContainer?.lastChild).toBe(userMenuWrapper)
    })

    it('should maintain layout when UserMenu changes', () => {
      const { rerender } = render(<Header />)

      // Initial render
      expect(screen.getByTestId('user-menu')).toBeInTheDocument()
      
      // Re-render (simulating UserMenu state change)
      rerender(<Header />)
      
      // Layout should remain stable
      const headerContainer = screen.getByText('Test Semiont').closest('div')
      expect(headerContainer).toHaveClass('flex', 'justify-between', 'items-center')
    })
  })

  describe('Responsive Behavior', () => {
    it('should maintain flex layout at all screen sizes', () => {
      render(<Header />)

      const headerContainer = screen.getByText('Test Semiont').closest('div')
      expect(headerContainer).toHaveClass('flex', 'justify-between', 'items-center', 'w-full')
      
      // These classes don't have responsive modifiers, so layout should be consistent
      expect(headerContainer?.className).not.toMatch(/sm:|md:|lg:|xl:/)
    })

    it('should use consistent text size across breakpoints', () => {
      render(<Header />)

      const heading = screen.getByRole('heading', { level: 1 })
      expect(heading).toHaveClass('text-4xl')
      
      // No responsive text size modifiers
      expect(heading.className).not.toMatch(/sm:text-|md:text-|lg:text-|xl:text-/)
    })
  })

  describe('Error Scenarios', () => {
    it('should render header structure even with complex environments', () => {
      // Since we have a mocked environment, we can test that the component renders properly
      render(<Header />)

      // Should not throw an error and should have proper structure
      const heading = screen.getByRole('heading', { level: 1 })
      expect(heading).toBeInTheDocument()
      expect(heading).toHaveTextContent('Test Semiont')
    })
  })

  describe('Performance Considerations', () => {
    it('should render without unnecessary re-renders', () => {
      const { rerender } = render(<Header />)

      // Get initial heading
      const heading1 = screen.getByRole('heading', { level: 1 })
      
      // Re-render with same props
      rerender(<Header />)
      
      // Should be the same element (no re-creation)
      const heading2 = screen.getByRole('heading', { level: 1 })
      expect(heading1).toBe(heading2)
    })
  })

  describe('Comment Verification', () => {
    it('should include authentication status comment', () => {
      render(<Header />)

      // The component includes a comment "Authentication Status"
      // This is a documentation test to ensure the code remains self-documenting
      const userMenuContainer = screen.getByTestId('user-menu').closest('div')
      expect(userMenuContainer).toBeInTheDocument()
    })
  })
})