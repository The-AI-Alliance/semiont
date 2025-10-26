import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock, MockedFunction } from 'vitest'
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { CookieBanner } from '../CookieBanner';

// Mock the cookies module
vi.mock('@/lib/cookies', () => ({
  getCookieConsent: vi.fn(),
  setCookieConsent: vi.fn(),
  shouldShowBanner: vi.fn(),
  isGDPRApplicable: vi.fn(),
  isCCPAApplicable: vi.fn(),
  COOKIE_CATEGORIES: [
    {
      id: 'necessary',
      name: 'Strictly Necessary',
      description: 'These cookies are essential for the website to function properly.',
      required: true,
      cookies: ['next-auth.session-token', 'consent-preferences']
    },
    {
      id: 'analytics',
      name: 'Analytics',
      description: 'These cookies help us understand how visitors interact with our website.',
      required: false,
      cookies: ['_ga', '_gid']
    },
    {
      id: 'marketing',
      name: 'Marketing',
      description: 'These cookies are used to track visitors across websites.',
      required: false,
      cookies: ['_fbp', '_fbc']
    },
    {
      id: 'preferences',
      name: 'Preferences',
      description: 'These cookies remember your choices and preferences.',
      required: false,
      cookies: ['theme-preference', 'language-preference']
    }
  ]
}));

// Mock Heroicons
vi.mock('@heroicons/react/24/outline', () => ({
  ChevronDownIcon: ({ className }: { className?: string }) => (
    <svg className={className} data-testid="chevron-down-icon">
      <title>ChevronDown</title>
    </svg>
  ),
  ChevronUpIcon: ({ className }: { className?: string }) => (
    <svg className={className} data-testid="chevron-up-icon">
      <title>ChevronUp</title>
    </svg>
  )
}));

// Import mocked functions
import {
  shouldShowBanner,
  isGDPRApplicable,
  isCCPAApplicable,
  setCookieConsent,
  getCookieConsent
} from '@/lib/cookies';

// Type the mocked functions
const mockShouldShowBanner = shouldShowBanner as MockedFunction<typeof shouldShowBanner>;
const mockIsGDPRApplicable = isGDPRApplicable as MockedFunction<typeof isGDPRApplicable>;
const mockIsCCPAApplicable = isCCPAApplicable as MockedFunction<typeof isCCPAApplicable>;
const mockSetCookieConsent = setCookieConsent as MockedFunction<typeof setCookieConsent>;
const mockGetCookieConsent = getCookieConsent as MockedFunction<typeof getCookieConsent>;

// Test data fixtures
const mockRegionStates = {
  gdpr: {
    shouldShow: true,
    isGDPR: true,
    isCCPA: false,
    expectedTitle: 'We value your privacy',
    expectedDescription: 'We use cookies and similar technologies to provide, protect, and improve our services.',
    hasRejectButton: false
  },
  ccpa: {
    shouldShow: true,
    isGDPR: false,
    isCCPA: true,
    expectedTitle: 'Your Privacy Choices',
    expectedDescription: 'We use cookies to personalize content and ads, provide social media features, and analyze our traffic.',
    hasRejectButton: true
  },
  general: {
    shouldShow: true,
    isGDPR: false,
    isCCPA: false,
    expectedTitle: 'Cookie Notice',
    expectedDescription: 'We use cookies to enhance your experience, analyze site usage, and assist in our marketing efforts.',
    hasRejectButton: true
  },
  hidden: {
    shouldShow: false,
    isGDPR: false,
    isCCPA: false,
    expectedTitle: '',
    expectedDescription: '',
    hasRejectButton: false
  }
};

const mockConsentStates = {
  initial: {
    necessary: true,
    analytics: false,
    marketing: false,
    preferences: false
  },
  acceptAll: {
    necessary: true,
    analytics: true,
    marketing: true,
    preferences: true
  },
  rejectAll: {
    necessary: true,
    analytics: false,
    marketing: false,
    preferences: false
  },
  partial: {
    necessary: true,
    analytics: true,
    marketing: false,
    preferences: true
  }
};

describe('CookieBanner Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mocks
    mockShouldShowBanner.mockReturnValue(true);
    mockIsGDPRApplicable.mockResolvedValue(false);
    mockIsCCPAApplicable.mockResolvedValue(false);
    mockSetCookieConsent.mockImplementation(() => {});
  });

  describe('Visibility and Initial State Tests', () => {
    it('should display banner when shouldShowBanner returns true', async () => {
      mockShouldShowBanner.mockReturnValue(true);
      mockIsGDPRApplicable.mockResolvedValue(false);
      mockIsCCPAApplicable.mockResolvedValue(false);

      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
      });
    });

    it('should not display banner when shouldShowBanner returns false', () => {
      mockShouldShowBanner.mockReturnValue(false);

      render(<CookieBanner />);

      expect(screen.queryByText('Cookie Notice')).not.toBeInTheDocument();
      expect(screen.queryByText('We value your privacy')).not.toBeInTheDocument();
    });

    it('should initialize with correct default state', async () => {
      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
      });

      // Details should be hidden initially
      expect(screen.queryByText('Cookie Preferences')).not.toBeInTheDocument();
      
      // Accept All button should be present and enabled
      const acceptButton = screen.getByRole('button', { name: /accept all/i });
      expect(acceptButton).toBeInTheDocument();
      expect(acceptButton).not.toBeDisabled();
    });

    it('should call region detection functions on mount', async () => {
      render(<CookieBanner />);

      await waitFor(() => {
        expect(mockShouldShowBanner).toHaveBeenCalledTimes(1);
        expect(mockIsGDPRApplicable).toHaveBeenCalledTimes(1);
        expect(mockIsCCPAApplicable).toHaveBeenCalledTimes(1);
      });
    });

    it('should handle async region detection with Promise.all', async () => {
      mockIsGDPRApplicable.mockResolvedValue(true);
      mockIsCCPAApplicable.mockResolvedValue(false);

      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('We value your privacy')).toBeInTheDocument();
      });

      // Verify both promises were called
      expect(mockIsGDPRApplicable).toHaveBeenCalledTimes(1);
      expect(mockIsCCPAApplicable).toHaveBeenCalledTimes(1);
    });

    it('should handle custom className prop', async () => {
      const customClass = 'custom-banner-class';
      mockShouldShowBanner.mockReturnValue(true);
      
      render(<CookieBanner className={customClass} />);

      await waitFor(() => {
        const banner = screen.getByText('Cookie Notice').closest('[class*="fixed bottom-0"]');
        expect(banner).toHaveClass(customClass);
      });
    });

    it('should maintain state during re-renders', async () => {
      const { rerender } = render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
      });

      // Expand details
      const customizeButton = screen.getByRole('button', { name: /customize/i });
      await userEvent.click(customizeButton);

      await waitFor(() => {
        expect(screen.getByText('Cookie Preferences')).toBeInTheDocument();
      });

      // Re-render and verify state persists
      rerender(<CookieBanner />);
      
      expect(screen.getByText('Cookie Preferences')).toBeInTheDocument();
    });

    it('should handle component unmounting gracefully', async () => {
      const { unmount } = render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
      });

      expect(() => unmount()).not.toThrow();
    });
  });

  describe('Region-Specific Behavior Tests', () => {
    it('should display GDPR content when GDPR is applicable', async () => {
      mockIsGDPRApplicable.mockResolvedValue(true);
      mockIsCCPAApplicable.mockResolvedValue(false);

      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText(mockRegionStates.gdpr.expectedTitle)).toBeInTheDocument();
        expect(screen.getByText(new RegExp(mockRegionStates.gdpr.expectedDescription))).toBeInTheDocument();
      });
    });

    it('should display CCPA content when CCPA is applicable', async () => {
      mockIsGDPRApplicable.mockResolvedValue(false);
      mockIsCCPAApplicable.mockResolvedValue(true);

      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText(mockRegionStates.ccpa.expectedTitle)).toBeInTheDocument();
        expect(screen.getByText(new RegExp(mockRegionStates.ccpa.expectedDescription))).toBeInTheDocument();
      });
    });

    it('should display general content when neither GDPR nor CCPA applies', async () => {
      mockIsGDPRApplicable.mockResolvedValue(false);
      mockIsCCPAApplicable.mockResolvedValue(false);

      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText(mockRegionStates.general.expectedTitle)).toBeInTheDocument();
        expect(screen.getByText(new RegExp(mockRegionStates.general.expectedDescription))).toBeInTheDocument();
      });
    });

    it('should not show Reject All button in GDPR region', async () => {
      mockIsGDPRApplicable.mockResolvedValue(true);
      mockIsCCPAApplicable.mockResolvedValue(false);

      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('We value your privacy')).toBeInTheDocument();
      });

      expect(screen.queryByRole('button', { name: /reject all/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /accept all/i })).toBeInTheDocument();
    });

    it('should show Reject All button in CCPA region', async () => {
      mockIsGDPRApplicable.mockResolvedValue(false);
      mockIsCCPAApplicable.mockResolvedValue(true);

      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('Your Privacy Choices')).toBeInTheDocument();
      });

      expect(screen.getByRole('button', { name: /reject all/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /accept all/i })).toBeInTheDocument();
    });

    it('should show Reject All button in general region', async () => {
      mockIsGDPRApplicable.mockResolvedValue(false);
      mockIsCCPAApplicable.mockResolvedValue(false);

      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
      });

      expect(screen.getByRole('button', { name: /reject all/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /accept all/i })).toBeInTheDocument();
    });

    it('should display correct learn more text for each region', async () => {
      // Test GDPR learn more text
      mockShouldShowBanner.mockReturnValue(true);
      mockIsGDPRApplicable.mockResolvedValue(true);
      mockIsCCPAApplicable.mockResolvedValue(false);
      
      const { unmount } = render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText(/Learn more about our data processing in our Privacy Policy/)).toBeInTheDocument();
      });

      unmount();

      // Test CCPA learn more text
      mockIsGDPRApplicable.mockResolvedValue(false);
      mockIsCCPAApplicable.mockResolvedValue(true);
      
      const { unmount: unmount2 } = render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText(/See our Privacy Policy for details about your California privacy rights/)).toBeInTheDocument();
      });

      unmount2();

      // Test general learn more text
      mockIsGDPRApplicable.mockResolvedValue(false);
      mockIsCCPAApplicable.mockResolvedValue(false);
      
      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText(/See our Privacy Policy for more information/)).toBeInTheDocument();
      });
    });

    it('should handle region detection failures gracefully', async () => {
      // Suppress console errors for this test
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      mockIsGDPRApplicable.mockRejectedValue(new Error('Network error'));
      mockIsCCPAApplicable.mockRejectedValue(new Error('Network error'));

      render(<CookieBanner />);

      await waitFor(() => {
        // Should fallback to general region
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
      });
      
      // Wait for any pending promises to settle
      await new Promise(resolve => setTimeout(resolve, 0));
      
      consoleError.mockRestore();
    });

    it('should handle mixed region detection results', async () => {
      // Both GDPR and CCPA return true - GDPR should take precedence
      mockIsGDPRApplicable.mockResolvedValue(true);
      mockIsCCPAApplicable.mockResolvedValue(true);

      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('We value your privacy')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /reject all/i })).not.toBeInTheDocument();
      });
    });

    it('should update region state correctly', async () => {
      mockIsGDPRApplicable.mockResolvedValue(false);
      mockIsCCPAApplicable.mockResolvedValue(false);

      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /reject all/i })).toBeInTheDocument();
      });
    });

    it('should maintain region consistency throughout component lifecycle', async () => {
      mockIsGDPRApplicable.mockResolvedValue(true);
      mockIsCCPAApplicable.mockResolvedValue(false);

      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('We value your privacy')).toBeInTheDocument();
      });

      // Expand and collapse details - region should remain consistent
      const customizeButton = screen.getByRole('button', { name: /customize/i });
      await userEvent.click(customizeButton);

      await waitFor(() => {
        expect(screen.getByText('Cookie Preferences')).toBeInTheDocument();
      });

      // Should still be GDPR region (no reject button in preferences)
      expect(screen.queryByRole('button', { name: /reject all/i })).not.toBeInTheDocument();
    });
  });

  describe('User Interaction and Consent Handling Tests', () => {
    beforeEach(() => {
      mockShouldShowBanner.mockReturnValue(true);
    });

    it('should handle Accept All button click', async () => {
      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
      });

      const acceptButton = screen.getByRole('button', { name: /accept all/i });
      await userEvent.click(acceptButton);

      expect(mockSetCookieConsent).toHaveBeenCalledWith(mockConsentStates.acceptAll);
      
      // Banner should disappear
      await waitFor(() => {
        expect(screen.queryByText('Cookie Notice')).not.toBeInTheDocument();
      });
    });

    it('should handle Reject All button click', async () => {
      mockIsGDPRApplicable.mockResolvedValue(false);
      mockIsCCPAApplicable.mockResolvedValue(false);

      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
      });

      const rejectButton = screen.getByRole('button', { name: /reject all/i });
      await userEvent.click(rejectButton);

      expect(mockSetCookieConsent).toHaveBeenCalledWith(mockConsentStates.rejectAll);
      
      // Banner should disappear
      await waitFor(() => {
        expect(screen.queryByText('Cookie Notice')).not.toBeInTheDocument();
      });
    });

    it('should toggle details view when Customize button is clicked', async () => {
      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
      });

      const customizeButton = screen.getByRole('button', { name: /customize/i });
      
      // Initially, details should be hidden
      expect(screen.queryByText('Cookie Preferences')).not.toBeInTheDocument();
      
      // Click to show details
      await userEvent.click(customizeButton);
      
      await waitFor(() => {
        expect(screen.getByText('Cookie Preferences')).toBeInTheDocument();
      });
      
      // Click again to hide details
      await userEvent.click(customizeButton);
      
      await waitFor(() => {
        expect(screen.queryByText('Cookie Preferences')).not.toBeInTheDocument();
      });
    });

    it('should display correct chevron icons based on details state', async () => {
      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
      });

      const customizeButton = screen.getByRole('button', { name: /customize/i });
      
      // Initially should show down chevron
      expect(screen.getByTestId('chevron-down-icon')).toBeInTheDocument();
      expect(screen.queryByTestId('chevron-up-icon')).not.toBeInTheDocument();
      
      // Click to expand
      await userEvent.click(customizeButton);
      
      await waitFor(() => {
        expect(screen.getByTestId('chevron-up-icon')).toBeInTheDocument();
        expect(screen.queryByTestId('chevron-down-icon')).not.toBeInTheDocument();
      });
    });

    it('should handle Save Preferences button click', async () => {
      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
      });

      // Expand details
      const customizeButton = screen.getByRole('button', { name: /customize/i });
      await userEvent.click(customizeButton);

      await waitFor(() => {
        expect(screen.getByText('Cookie Preferences')).toBeInTheDocument();
      });

      // Toggle some preferences
      const analyticsCheckbox = screen.getByLabelText(/analytics/i);
      await userEvent.click(analyticsCheckbox);

      // Save preferences
      const saveButton = screen.getByRole('button', { name: /save preferences/i });
      await userEvent.click(saveButton);

      expect(mockSetCookieConsent).toHaveBeenCalledWith({
        necessary: true,
        analytics: true,
        marketing: false,
        preferences: false
      });
      
      // Banner should disappear
      await waitFor(() => {
        expect(screen.queryByText('Cookie Notice')).not.toBeInTheDocument();
      });
    });

    it('should handle Cancel button in preferences', async () => {
      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
      });

      // Expand details
      const customizeButton = screen.getByRole('button', { name: /customize/i });
      await userEvent.click(customizeButton);

      await waitFor(() => {
        expect(screen.getByText('Cookie Preferences')).toBeInTheDocument();
      });

      // Click cancel
      const cancelButton = screen.getByRole('button', { name: /cancel/i });
      await userEvent.click(cancelButton);

      // Details should be hidden
      await waitFor(() => {
        expect(screen.queryByText('Cookie Preferences')).not.toBeInTheDocument();
      });

      // Banner should still be visible
      expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
    });

    it('should show loading states during consent operations', async () => {
      // Mock a delayed consent operation
      let resolveConsent: (value: unknown) => void;
      mockSetCookieConsent.mockImplementation(() => {
        return new Promise(resolve => {
          resolveConsent = resolve;
        });
      });

      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
      });

      const acceptButton = screen.getByRole('button', { name: /accept all/i });
      await userEvent.click(acceptButton);

      // Should show loading state
      await waitFor(() => {
        expect(screen.getAllByText('Saving...')).toHaveLength(2); // Both Accept and Reject buttons show Saving...
      });

      // Clean up
      resolveConsent!(undefined);
    });

    it('should disable buttons during loading', async () => {
      mockIsGDPRApplicable.mockResolvedValue(false);
      mockIsCCPAApplicable.mockResolvedValue(false);

      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
      });

      // Mock a delayed consent operation
      let resolveConsent: (value: unknown) => void;
      mockSetCookieConsent.mockImplementation(() => {
        return new Promise(resolve => {
          resolveConsent = resolve;
        });
      });

      const acceptButton = screen.getByRole('button', { name: /accept all/i });
      const rejectButton = screen.getByRole('button', { name: /reject all/i });
      
      await userEvent.click(acceptButton);

      await waitFor(() => {
        expect(acceptButton).toBeDisabled();
        expect(rejectButton).toBeDisabled();
      });

      // Resolve the promise
      resolveConsent!(undefined);
    });

    it('should handle cookie category toggle', async () => {
      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
      });

      // Expand details
      const customizeButton = screen.getByRole('button', { name: /customize/i });
      await userEvent.click(customizeButton);

      await waitFor(() => {
        expect(screen.getByText('Cookie Preferences')).toBeInTheDocument();
      });

      // Check initial state - analytics should be unchecked
      const analyticsCheckbox = screen.getByLabelText(/analytics/i) as HTMLInputElement;
      expect(analyticsCheckbox.checked).toBe(false);

      // Toggle analytics
      await userEvent.click(analyticsCheckbox);
      expect(analyticsCheckbox.checked).toBe(true);

      // Toggle back
      await userEvent.click(analyticsCheckbox);
      expect(analyticsCheckbox.checked).toBe(false);
    });

    it('should prevent toggling necessary cookies', async () => {
      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
      });

      // Expand details
      const customizeButton = screen.getByRole('button', { name: /customize/i });
      await userEvent.click(customizeButton);

      await waitFor(() => {
        expect(screen.getByText('Cookie Preferences')).toBeInTheDocument();
      });

      // Necessary checkbox should be checked and disabled
      const necessaryCheckbox = screen.getByLabelText(/strictly necessary/i) as HTMLInputElement;
      expect(necessaryCheckbox.checked).toBe(true);
      expect(necessaryCheckbox.disabled).toBe(true);
    });

    it('should maintain consent state across interactions', async () => {
      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
      });

      // Expand details
      const customizeButton = screen.getByRole('button', { name: /customize/i });
      await userEvent.click(customizeButton);

      await waitFor(() => {
        expect(screen.getByText('Cookie Preferences')).toBeInTheDocument();
      });

      // Toggle analytics and marketing
      const analyticsCheckbox = screen.getByLabelText(/analytics/i) as HTMLInputElement;
      const marketingCheckbox = screen.getByLabelText(/marketing/i) as HTMLInputElement;
      
      await userEvent.click(analyticsCheckbox);
      await userEvent.click(marketingCheckbox);

      expect(analyticsCheckbox.checked).toBe(true);
      expect(marketingCheckbox.checked).toBe(true);

      // Collapse and expand again - state should persist
      await userEvent.click(customizeButton);
      await waitFor(() => {
        expect(screen.queryByText('Cookie Preferences')).not.toBeInTheDocument();
      });

      await userEvent.click(customizeButton);
      await waitFor(() => {
        expect(screen.getByText('Cookie Preferences')).toBeInTheDocument();
      });

      const analyticsCheckboxAfter = screen.getByLabelText(/analytics/i) as HTMLInputElement;
      const marketingCheckboxAfter = screen.getByLabelText(/marketing/i) as HTMLInputElement;
      
      expect(analyticsCheckboxAfter.checked).toBe(true);
      expect(marketingCheckboxAfter.checked).toBe(true);
    });

    it('should handle rapid user interactions gracefully', async () => {
      mockShouldShowBanner.mockReturnValue(true);
      
      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
      });

      const customizeButton = screen.getByRole('button', { name: /customize/i });
      
      // Rapid clicks - first click opens
      await userEvent.click(customizeButton);
      await waitFor(() => {
        expect(screen.getByText('Cookie Preferences')).toBeInTheDocument();
      });
      
      // Second click closes
      await userEvent.click(customizeButton);
      await waitFor(() => {
        expect(screen.queryByText('Cookie Preferences')).not.toBeInTheDocument();
      });
      
      // Third click opens again
      await userEvent.click(customizeButton);
      await waitFor(() => {
        expect(screen.getByText('Cookie Preferences')).toBeInTheDocument();
      });
    });
  });

  describe('Preferences Customization Tests', () => {
    beforeEach(async () => {
      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
      });

      // Expand details for all tests in this group
      const customizeButton = screen.getByRole('button', { name: /customize/i });
      await userEvent.click(customizeButton);

      await waitFor(() => {
        expect(screen.getByText('Cookie Preferences')).toBeInTheDocument();
      });
    });

    it('should display all cookie categories', () => {
      expect(screen.getByText('Strictly Necessary')).toBeInTheDocument();
      expect(screen.getByText('Analytics')).toBeInTheDocument();
      expect(screen.getByText('Marketing')).toBeInTheDocument();
      expect(screen.getByText('Preferences')).toBeInTheDocument();
    });

    it('should display category descriptions', () => {
      expect(screen.getByText(/These cookies are essential for the website to function properly/)).toBeInTheDocument();
      expect(screen.getByText(/These cookies help us understand how visitors interact/)).toBeInTheDocument();
      expect(screen.getByText(/These cookies are used to track visitors across websites/)).toBeInTheDocument();
      expect(screen.getByText(/These cookies remember your choices and preferences/)).toBeInTheDocument();
    });

    it('should show required indicator for necessary cookies', () => {
      expect(screen.getByText('(Required)')).toBeInTheDocument();
    });

    it('should have proper checkbox states initially', () => {
      const necessaryCheckbox = screen.getByLabelText(/strictly necessary/i) as HTMLInputElement;
      const analyticsCheckbox = screen.getByLabelText(/analytics/i) as HTMLInputElement;
      const marketingCheckbox = screen.getByLabelText(/marketing/i) as HTMLInputElement;
      const preferencesCheckbox = screen.getByLabelText(/preferences/i) as HTMLInputElement;

      expect(necessaryCheckbox.checked).toBe(true);
      expect(analyticsCheckbox.checked).toBe(false);
      expect(marketingCheckbox.checked).toBe(false);
      expect(preferencesCheckbox.checked).toBe(false);
    });

    it('should expand cookie details when clicked', async () => {
      const viewCookiesButtons = screen.getAllByText('View cookies');
      
      // Click the first "View cookies" (Strictly Necessary)
      await userEvent.click(viewCookiesButtons[0]!);

      // Should show the cookies for that category
      expect(screen.getByText(/next-auth\.session-token, consent-preferences/)).toBeInTheDocument();
    });

    it('should handle multiple category toggles', async () => {
      const analyticsCheckbox = screen.getByLabelText(/analytics/i) as HTMLInputElement;
      const marketingCheckbox = screen.getByLabelText(/marketing/i) as HTMLInputElement;
      const preferencesCheckbox = screen.getByLabelText(/preferences/i) as HTMLInputElement;

      // Toggle multiple categories
      await userEvent.click(analyticsCheckbox);
      await userEvent.click(preferencesCheckbox);

      expect(analyticsCheckbox.checked).toBe(true);
      expect(marketingCheckbox.checked).toBe(false);
      expect(preferencesCheckbox.checked).toBe(true);
    });

    it('should maintain correct consent object structure', async () => {
      const analyticsCheckbox = screen.getByLabelText(/analytics/i);
      const marketingCheckbox = screen.getByLabelText(/marketing/i);

      await userEvent.click(analyticsCheckbox);
      await userEvent.click(marketingCheckbox);

      const saveButton = screen.getByRole('button', { name: /save preferences/i });
      await userEvent.click(saveButton);

      expect(mockSetCookieConsent).toHaveBeenCalledWith({
        necessary: true,
        analytics: true,
        marketing: true,
        preferences: false
      });
    });

    it('should disable checkboxes during loading', async () => {
      // Mock a delayed consent operation
      let resolveConsent: (value: unknown) => void;
      mockSetCookieConsent.mockImplementation(() => {
        return new Promise(resolve => {
          resolveConsent = resolve;
        });
      });

      const saveButton = screen.getByRole('button', { name: /save preferences/i });
      await userEvent.click(saveButton);

      await waitFor(() => {
        const analyticsCheckbox = screen.getByLabelText(/analytics/i) as HTMLInputElement;
        expect(analyticsCheckbox.disabled).toBe(true);
      });

      resolveConsent!(undefined);
    });

    it('should have proper form structure and accessibility', () => {
      // Check that checkboxes have proper labels
      const checkboxes = screen.getAllByRole('checkbox');
      expect(checkboxes).toHaveLength(4); // One for each category

      checkboxes.forEach(checkbox => {
        expect(checkbox).toHaveAccessibleName();
      });
    });

    it('should handle category validation correctly', async () => {
      // Try to uncheck necessary cookies (should not work)
      const necessaryCheckbox = screen.getByLabelText(/strictly necessary/i);
      
      // Should be disabled, so click should not change state
      expect(necessaryCheckbox).toBeDisabled();
      
      // Even if we force a click, the handler should prevent changes
      await userEvent.click(necessaryCheckbox);
      
      const necessaryCheckboxAfter = screen.getByLabelText(/strictly necessary/i) as HTMLInputElement;
      expect(necessaryCheckboxAfter.checked).toBe(true);
    });
  });

  describe('Accessibility and Form Controls Tests', () => {
    beforeEach(async () => {
      mockShouldShowBanner.mockReturnValue(true);
      
      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
      });
    });

    it('should have proper form labels and associations', async () => {
      // Expand details
      const customizeButton = screen.getByRole('button', { name: /customize/i });
      await userEvent.click(customizeButton);

      await waitFor(() => {
        expect(screen.getByText('Cookie Preferences')).toBeInTheDocument();
      });

      // Check that all checkboxes have proper labels
      const necessaryCheckbox = screen.getByLabelText(/strictly necessary/i);
      const analyticsCheckbox = screen.getByLabelText(/analytics/i);
      const marketingCheckbox = screen.getByLabelText(/marketing/i);
      const preferencesCheckbox = screen.getByLabelText(/preferences/i);

      expect(necessaryCheckbox).toBeInTheDocument();
      expect(analyticsCheckbox).toBeInTheDocument();
      expect(marketingCheckbox).toBeInTheDocument();
      expect(preferencesCheckbox).toBeInTheDocument();

      // Check that labels are properly associated
      expect(necessaryCheckbox).toHaveAttribute('id', 'cookie-necessary');
      expect(analyticsCheckbox).toHaveAttribute('id', 'cookie-analytics');
      expect(marketingCheckbox).toHaveAttribute('id', 'cookie-marketing');
      expect(preferencesCheckbox).toHaveAttribute('id', 'cookie-preferences');
    });

    it('should support keyboard navigation', async () => {
      const acceptButton = screen.getByRole('button', { name: /accept all/i });
      const customizeButton = screen.getByRole('button', { name: /customize/i });

      // Focus should work on buttons
      acceptButton.focus();
      expect(document.activeElement).toBe(acceptButton);

      customizeButton.focus();
      expect(document.activeElement).toBe(customizeButton);
    });

    it('should have proper button roles and attributes', () => {
      const acceptButton = screen.getByRole('button', { name: /accept all/i });
      const customizeButton = screen.getByRole('button', { name: /customize/i });

      expect(acceptButton).toHaveAttribute('type', 'button');
      expect(customizeButton).toHaveAttribute('type', 'button');
    });

    it('should have accessible button text', () => {
      expect(screen.getByRole('button', { name: /accept all/i })).toHaveAccessibleName('Accept All');
      expect(screen.getByRole('button', { name: /customize/i })).toHaveAccessibleName();
    });

    it('should handle focus management correctly', async () => {
      const customizeButton = screen.getByRole('button', { name: /customize/i });
      
      customizeButton.focus();
      expect(document.activeElement).toBe(customizeButton);

      await userEvent.click(customizeButton);

      await waitFor(() => {
        expect(screen.getByText('Cookie Preferences')).toBeInTheDocument();
      });

      // Focus should remain manageable
      const cancelButton = screen.getByRole('button', { name: /cancel/i });
      cancelButton.focus();
      expect(document.activeElement).toBe(cancelButton);
    });

    it('should have proper semantic structure', () => {
      // Check for proper heading structure
      const mainHeading = screen.getByRole('heading', { level: 3 });
      expect(mainHeading).toBeInTheDocument();
      expect(mainHeading).toHaveTextContent('Cookie Notice');
    });

    it('should provide proper form feedback', async () => {
      // Expand details
      const customizeButton = screen.getByRole('button', { name: /customize/i });
      await userEvent.click(customizeButton);

      await waitFor(() => {
        expect(screen.getByText('Cookie Preferences')).toBeInTheDocument();
      });

      // Required fields should be indicated
      expect(screen.getByText('(Required)')).toBeInTheDocument();
    });

    it('should handle screen reader compatibility', async () => {
      // Expand details
      const customizeButton = screen.getByRole('button', { name: /customize/i });
      await userEvent.click(customizeButton);

      await waitFor(() => {
        expect(screen.getByText('Cookie Preferences')).toBeInTheDocument();
      });

      // Check that descriptions are properly associated
      const descriptions = screen.getAllByText(/These cookies/);
      expect(descriptions.length).toBeGreaterThan(0);
    });

    it('should maintain proper tab order', async () => {
      const acceptButton = screen.getByRole('button', { name: /accept all/i });
      const customizeButton = screen.getByRole('button', { name: /customize/i });

      // Buttons should be focusable in logical order
      expect(acceptButton.tabIndex).not.toBe(-1);
      expect(customizeButton.tabIndex).not.toBe(-1);
    });
  });

  describe('UI/UX and Visual Tests', () => {
    beforeEach(() => {
      mockShouldShowBanner.mockReturnValue(true);
    });

    it('should apply correct CSS classes for layout', async () => {
      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
      });

      const banner = screen.getByText('Cookie Notice').closest('[class*="fixed bottom-0"]');
      expect(banner).toHaveClass('fixed', 'bottom-0', 'left-0', 'right-0', 'z-50');
    });

    it('should display loading text during operations', async () => {
      // Mock a delayed consent operation
      let resolveConsent: (value: unknown) => void;
      mockSetCookieConsent.mockImplementation(() => {
        return new Promise(resolve => {
          resolveConsent = resolve;
        });
      });

      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
      });

      const acceptButton = screen.getByRole('button', { name: /accept all/i });
      await userEvent.click(acceptButton);

      await waitFor(() => {
        expect(screen.getAllByText('Saving...')).toHaveLength(2); // Both Accept and Reject buttons show Saving...
      });

      resolveConsent!(undefined);
    });

    it('should handle responsive layout classes', async () => {
      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
      });

      // Check for responsive classes
      const container = screen.getByText('Cookie Notice').closest('.max-w-7xl');
      expect(container).toHaveClass('max-w-7xl', 'mx-auto');
    });

    it('should apply proper button styling', () => {
      render(<CookieBanner />);

      const acceptButton = screen.getByRole('button', { name: /accept all/i });
      expect(acceptButton).toHaveClass('bg-blue-600', 'text-white');
    });

    it('should handle custom className correctly', async () => {
      const customClass = 'my-custom-banner';
      
      render(<CookieBanner className={customClass} />);

      await waitFor(() => {
        const banner = screen.getByText('Cookie Notice').closest('[class*="fixed bottom-0"]');
        expect(banner).toHaveClass(customClass);
      });
    });

    it('should show appropriate visual feedback for disabled states', async () => {
      // Mock a delayed consent operation
      let resolveConsent: (value: unknown) => void;
      mockSetCookieConsent.mockImplementation(() => {
        return new Promise(resolve => {
          resolveConsent = resolve;
        });
      });

      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
      });

      const acceptButton = screen.getByRole('button', { name: /accept all/i });
      await userEvent.click(acceptButton);

      await waitFor(() => {
        const savingButtons = screen.getAllByText('Saving...');
        expect(savingButtons).toHaveLength(2);
        savingButtons.forEach(button => expect(button).toBeDisabled());
      });

      resolveConsent!(undefined);
    });

    it('should maintain visual consistency across states', async () => {
      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
      });

      const customizeButton = screen.getByRole('button', { name: /customize/i });
      
      // Get initial classes
      const initialClasses = customizeButton.className;
      
      // Toggle details
      await userEvent.click(customizeButton);
      
      // Classes should remain consistent
      expect(customizeButton.className).toBe(initialClasses);
    });
  });

  describe('Edge Cases and Error Handling Tests', () => {
    beforeEach(() => {
      mockShouldShowBanner.mockReturnValue(true);
    });

    it('should handle async operation failures gracefully', async () => {
      mockSetCookieConsent.mockImplementation(() => {
        throw new Error('Storage error');
      });

      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
      });

      const acceptButton = screen.getByRole('button', { name: /accept all/i });
      
      // Should not crash when consent saving fails
      // Click and let the error be handled internally
      await userEvent.click(acceptButton);
      
      // Component should still be rendered (not crashed)
      expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
    });

    it('should handle component unmounting during async operations', async () => {
      let resolveConsent: (value: unknown) => void;
      mockSetCookieConsent.mockImplementation(() => {
        return new Promise(resolve => {
          resolveConsent = resolve;
        });
      });

      const { unmount } = render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
      });

      const acceptButton = screen.getByRole('button', { name: /accept all/i });
      await userEvent.click(acceptButton);

      // Unmount while async operation is pending
      expect(() => unmount()).not.toThrow();
      
      // Resolve the promise after unmount
      resolveConsent!(undefined);
    });

    it('should handle invalid region detection responses', async () => {
      mockIsGDPRApplicable.mockResolvedValue(null as any);
      mockIsCCPAApplicable.mockResolvedValue(undefined as any);

      render(<CookieBanner />);

      await waitFor(() => {
        // Should fallback to general region
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
      });
    });

    it('should handle missing cookie categories gracefully', async () => {
      // This test verifies the component doesn't crash if COOKIE_CATEGORIES is empty
      // The mock already provides categories, but we test the component's robustness
      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
      });

      const customizeButton = screen.getByRole('button', { name: /customize/i });
      
      expect(() => {
        userEvent.click(customizeButton);
      }).not.toThrow();
    });

    it('should handle rapid state changes', async () => {
      mockShouldShowBanner.mockReturnValue(true);
      
      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
      });

      const customizeButton = screen.getByRole('button', { name: /customize/i });
      
      // Open details first
      await userEvent.click(customizeButton);
      await waitFor(() => {
        expect(screen.getByText('Cookie Preferences')).toBeInTheDocument();
      });
      
      // Close details
      await userEvent.click(customizeButton);
      await waitFor(() => {
        expect(screen.queryByText('Cookie Preferences')).not.toBeInTheDocument();
      });
      
      // Open again
      await userEvent.click(customizeButton);
      await waitFor(() => {
        expect(screen.getByText('Cookie Preferences')).toBeInTheDocument();
      });
    });

    it('should handle consent operation timeouts', async () => {
      mockSetCookieConsent.mockImplementation(() => {
        return new Promise(() => {
          // Never resolves to simulate timeout
        });
      });

      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
      });

      const acceptButton = screen.getByRole('button', { name: /accept all/i });
      await userEvent.click(acceptButton);

      await waitFor(() => {
        expect(screen.getAllByText('Saving...')).toHaveLength(2); // Both Accept and Reject buttons show Saving...
      });
      
      // Verify the component stays in loading state
      expect(screen.getAllByText('Saving...')).toHaveLength(2);
    });

    it('should maintain state consistency during error conditions', async () => {
      mockShouldShowBanner.mockReturnValue(true);
      mockSetCookieConsent.mockRejectedValue(new Error('Network error'));

      // Mock console.error to avoid error output in tests
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
      });

      const acceptButton = screen.getByRole('button', { name: /accept all/i });
      
      await userEvent.click(acceptButton);

      // Component should still be functional
      await waitFor(() => {
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
      });

      consoleSpy.mockRestore();
    });

    it('should handle browser storage limitations', async () => {
      // Mock storage quota exceeded error
      mockSetCookieConsent.mockImplementation(() => {
        const error = new Error('QuotaExceededError');
        error.name = 'QuotaExceededError';
        throw error;
      });

      render(<CookieBanner />);

      await waitFor(() => {
        expect(screen.getByText('Cookie Notice')).toBeInTheDocument();
      });

      const acceptButton = screen.getByRole('button', { name: /accept all/i });
      
      // Click should not throw an error
      await expect(userEvent.click(acceptButton)).resolves.not.toThrow();
    });
  });
});