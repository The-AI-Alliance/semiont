import { describe, it, expect, beforeEach, vi } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { Footer } from '../Footer'

// Mock CookiePreferences component
vi.mock('@/components/CookiePreferences', () => ({
  CookiePreferences: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) => (
    isOpen ? (
      <div data-testid="cookie-preferences-modal">
        <button onClick={onClose}>Close Cookie Preferences</button>
      </div>
    ) : null
  )
}))

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href, className }: any) => (
    <a href={href} className={className}>
      {children}
    </a>
  )
}))

describe('Footer Component', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Basic Rendering', () => {
    it('should render footer with all required elements', () => {
      render(<Footer />)

      // Footer should be rendered
      const footer = screen.getByRole('contentinfo')
      expect(footer).toBeInTheDocument()
      expect(footer).toHaveClass('bg-gray-50', 'border-t', 'border-gray-200', 'mt-auto')
    })

    it('should display copyright text with current year', () => {
      render(<Footer />)

      const currentYear = new Date().getFullYear()
      const copyrightText = `© ${currentYear} Semiont. All rights reserved.`
      
      expect(screen.getByText(copyrightText)).toBeInTheDocument()
    })

    it('should render all footer links', () => {
      render(<Footer />)

      expect(screen.getByText('Privacy Policy')).toBeInTheDocument()
      expect(screen.getByText('Cookie Preferences')).toBeInTheDocument()
      expect(screen.getByText('Terms of Service')).toBeInTheDocument()
    })
  })

  describe('Links and Navigation', () => {
    it('should have correct href for Privacy Policy link', () => {
      render(<Footer />)

      const privacyLink = screen.getByText('Privacy Policy').closest('a')
      expect(privacyLink).toHaveAttribute('href', '/privacy')
    })

    it('should have correct href for Terms of Service link', () => {
      render(<Footer />)

      const termsLink = screen.getByText('Terms of Service').closest('a')
      expect(termsLink).toHaveAttribute('href', '/terms')
    })

    it('should apply hover styles to links', () => {
      render(<Footer />)

      const privacyLink = screen.getByText('Privacy Policy')
      expect(privacyLink).toHaveClass('text-gray-500', 'hover:text-gray-700', 'transition-colors')

      const termsLink = screen.getByText('Terms of Service')
      expect(termsLink).toHaveClass('text-gray-500', 'hover:text-gray-700', 'transition-colors')
    })
  })

  describe('Cookie Preferences Modal', () => {
    it('should not show cookie preferences modal initially', () => {
      render(<Footer />)

      expect(screen.queryByTestId('cookie-preferences-modal')).not.toBeInTheDocument()
    })

    it('should open cookie preferences modal when button is clicked', () => {
      render(<Footer />)

      const cookieButton = screen.getByText('Cookie Preferences')
      fireEvent.click(cookieButton)

      expect(screen.getByTestId('cookie-preferences-modal')).toBeInTheDocument()
    })

    it('should close cookie preferences modal when onClose is called', () => {
      render(<Footer />)

      // Open modal
      const cookieButton = screen.getByText('Cookie Preferences')
      fireEvent.click(cookieButton)

      expect(screen.getByTestId('cookie-preferences-modal')).toBeInTheDocument()

      // Close modal
      const closeButton = screen.getByText('Close Cookie Preferences')
      fireEvent.click(closeButton)

      expect(screen.queryByTestId('cookie-preferences-modal')).not.toBeInTheDocument()
    })

    it('should render Cookie Preferences button as a button element', () => {
      render(<Footer />)

      const cookieButton = screen.getByText('Cookie Preferences')
      expect(cookieButton.tagName).toBe('BUTTON')
      expect(cookieButton).toHaveClass('text-gray-500', 'hover:text-gray-700', 'transition-colors')
    })
  })

  describe('Responsive Layout', () => {
    it('should have responsive flex layout classes', () => {
      render(<Footer />)

      const container = screen.getByText(/© \d{4} Semiont/).closest('div')?.parentElement
      expect(container).toHaveClass(
        'flex',
        'flex-col',
        'sm:flex-row',
        'justify-between',
        'items-center',
        'space-y-4',
        'sm:space-y-0'
      )
    })

    it('should have proper container styling', () => {
      render(<Footer />)

      const innerContainer = screen.getByText(/© \d{4} Semiont/).closest('div')?.parentElement?.parentElement
      expect(innerContainer).toHaveClass(
        'max-w-7xl',
        'mx-auto',
        'py-6',
        'px-4',
        'sm:px-6',
        'lg:px-8'
      )
    })

    it('should have proper spacing between links', () => {
      render(<Footer />)

      const linksContainer = screen.getByText('Privacy Policy').closest('div')
      expect(linksContainer).toHaveClass('flex', 'space-x-6', 'text-sm')
    })
  })

  describe('Accessibility', () => {
    it('should have proper semantic HTML structure', () => {
      render(<Footer />)

      const footer = screen.getByRole('contentinfo')
      expect(footer.tagName).toBe('FOOTER')
    })

    it('should have accessible link text', () => {
      render(<Footer />)

      expect(screen.getByRole('link', { name: 'Privacy Policy' })).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Terms of Service' })).toBeInTheDocument()
    })

    it('should have accessible button for cookie preferences', () => {
      render(<Footer />)

      const cookieButton = screen.getByRole('button', { name: 'Cookie Preferences' })
      expect(cookieButton).toBeInTheDocument()
    })

    it('should maintain focus management when opening modal', () => {
      render(<Footer />)

      const cookieButton = screen.getByText('Cookie Preferences')
      cookieButton.focus()
      expect(document.activeElement).toBe(cookieButton)

      fireEvent.click(cookieButton)

      // Modal should be open
      expect(screen.getByTestId('cookie-preferences-modal')).toBeInTheDocument()
    })
  })

  describe('State Management', () => {
    it('should manage showCookiePreferences state correctly', () => {
      render(<Footer />)

      // Initially closed
      expect(screen.queryByTestId('cookie-preferences-modal')).not.toBeInTheDocument()

      // Open
      fireEvent.click(screen.getByText('Cookie Preferences'))
      expect(screen.getByTestId('cookie-preferences-modal')).toBeInTheDocument()

      // Close
      fireEvent.click(screen.getByText('Close Cookie Preferences'))
      expect(screen.queryByTestId('cookie-preferences-modal')).not.toBeInTheDocument()

      // Open again
      fireEvent.click(screen.getByText('Cookie Preferences'))
      expect(screen.getByTestId('cookie-preferences-modal')).toBeInTheDocument()
    })
  })

  describe('Year Updates', () => {
    it('should display correct year even when year changes', () => {
      // Save the original Date constructor
      const OriginalDate = Date
      
      // Mock Date to return a specific year
      global.Date = class extends OriginalDate {
        constructor(...args: any[]) {
          if (args.length === 0) {
            super('2025-01-01')
          } else {
            super(...(args as []))
          }
        }

        override getFullYear() {
          return 2025
        }
      } as any

      render(<Footer />)
      expect(screen.getByText('© 2025 Semiont. All rights reserved.')).toBeInTheDocument()

      // Restore Date
      global.Date = OriginalDate
    })

    it('should handle year transition correctly', () => {
      // Save the original Date constructor  
      const OriginalDate = Date
      
      // Mock for 2024
      global.Date = class extends OriginalDate {
        constructor(...args: any[]) {
          super(...(args as []))
        }

        override getFullYear() {
          return 2024
        }
      } as any

      const { rerender } = render(<Footer />)
      expect(screen.getByText('© 2024 Semiont. All rights reserved.')).toBeInTheDocument()

      // Mock for 2025
      global.Date = class extends OriginalDate {
        constructor(...args: any[]) {
          super(...(args as []))
        }

        override getFullYear() {
          return 2025
        }
      } as any

      rerender(<Footer />)
      expect(screen.getByText('© 2025 Semiont. All rights reserved.')).toBeInTheDocument()

      // Restore Date
      global.Date = OriginalDate
    })
  })

  describe('Integration with CookiePreferences', () => {
    it('should pass correct props to CookiePreferences component', () => {
      render(<Footer />)

      // Initially closed
      const modalContainer = document.querySelector('[data-testid="cookie-preferences-modal"]')
      expect(modalContainer).not.toBeInTheDocument()

      // Click to open
      fireEvent.click(screen.getByText('Cookie Preferences'))

      // Should pass isOpen=true
      expect(screen.getByTestId('cookie-preferences-modal')).toBeInTheDocument()

      // Click close button (which calls onClose prop)
      fireEvent.click(screen.getByText('Close Cookie Preferences'))

      // Should pass isOpen=false
      expect(screen.queryByTestId('cookie-preferences-modal')).not.toBeInTheDocument()
    })
  })

  describe('Error Handling', () => {
    it('should handle rapid clicks on cookie preferences button', () => {
      render(<Footer />)

      const cookieButton = screen.getByText('Cookie Preferences')
      
      // Rapid clicks
      fireEvent.click(cookieButton)
      fireEvent.click(cookieButton)
      fireEvent.click(cookieButton)

      // Should still show only one modal
      expect(screen.getAllByTestId('cookie-preferences-modal')).toHaveLength(1)
    })
  })

  describe('Styling and CSS Classes', () => {
    it('should have correct text styling for copyright', () => {
      render(<Footer />)

      const copyrightDiv = screen.getByText(/© \d{4} Semiont/).closest('div')
      expect(copyrightDiv).toHaveClass('text-sm', 'text-gray-500')
    })

    it('should have consistent link styling', () => {
      render(<Footer />)

      const links = [
        screen.getByText('Privacy Policy'),
        screen.getByText('Terms of Service')
      ]

      links.forEach(link => {
        expect(link).toHaveClass('text-gray-500', 'hover:text-gray-700', 'transition-colors')
      })

      // Cookie Preferences button should have same styling
      const cookieButton = screen.getByText('Cookie Preferences')
      expect(cookieButton).toHaveClass('text-gray-500', 'hover:text-gray-700', 'transition-colors')
    })
  })
})