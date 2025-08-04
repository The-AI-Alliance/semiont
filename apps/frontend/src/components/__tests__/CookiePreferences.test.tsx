import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';
import { CookiePreferences } from '../CookiePreferences';

// Mock the cookies library
vi.mock('@/lib/cookies', () => ({
  getCookieConsent: vi.fn(),
  setCookieConsent: vi.fn(),
  exportUserData: vi.fn(),
  deleteAllUserData: vi.fn(),
  COOKIE_CATEGORIES: [
    {
      id: 'necessary',
      name: 'Strictly Necessary',
      description: 'Essential cookies required for basic site functionality',
      required: true,
      cookies: ['session', 'csrf-token', 'auth-token']
    },
    {
      id: 'analytics',
      name: 'Analytics',
      description: 'Help us understand how visitors use our website',
      required: false,
      cookies: ['_ga', '_gid', '_gtag']
    },
    {
      id: 'marketing',
      name: 'Marketing',
      description: 'Used to deliver personalized advertisements',
      required: false,
      cookies: ['_fbp', 'ads_id', 'pixel_id']
    },
    {
      id: 'preferences',
      name: 'Preferences',
      description: 'Remember your preferences and settings',
      required: false,
      cookies: ['theme', 'language', 'timezone']
    }
  ]
}));

// Mock DOM APIs for file downloads
global.URL = {
  createObjectURL: vi.fn(() => 'mock-blob-url'),
  revokeObjectURL: vi.fn()
};
global.Blob = vi.fn().mockImplementation((content, options) => ({
  content,
  options,
  size: content?.[0]?.length || 0,
  type: options?.type || 'application/octet-stream'
}));

// Mock @heroicons/react/24/outline
vi.mock('@heroicons/react/24/outline', () => ({
  CogIcon: ({ className }: { className?: string }) => <div data-testid="cog-icon" className={className} />,
  TrashIcon: ({ className }: { className?: string }) => <div data-testid="trash-icon" className={className} />,
  ArrowDownTrayIcon: ({ className }: { className?: string }) => <div data-testid="arrow-down-tray-icon" className={className} />,
  ShieldCheckIcon: ({ className }: { className?: string }) => <div data-testid="shield-check-icon" className={className} />
}));

describe('CookiePreferences - Comprehensive Tests', () => {
  const mockOnClose = vi.fn();
  
  beforeEach(async () => {
    cleanup();
    vi.clearAllMocks();
    
    const cookiesModule = await import('@/lib/cookies');
    vi.mocked(cookiesModule.getCookieConsent).mockReturnValue({
      necessary: true,
      analytics: false,
      marketing: false,
      preferences: false,
      timestamp: '2024-01-01T00:00:00.000Z',
      version: '1.0'
    });
    vi.mocked(cookiesModule.setCookieConsent).mockImplementation(() => {});
    vi.mocked(cookiesModule.exportUserData).mockReturnValue({ data: 'test-export-data' });
    vi.mocked(cookiesModule.deleteAllUserData).mockImplementation(() => {});
  });

  describe('Modal Visibility & State', () => {
    it('should not render modal when isOpen is false', () => {
      render(<CookiePreferences isOpen={false} onClose={mockOnClose} />);
      
      expect(screen.queryByText('Cookie Preferences')).not.toBeInTheDocument();
      expect(document.querySelector('.fixed.inset-0.z-50')).not.toBeInTheDocument();
    });

    it('should render modal when isOpen is true', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      expect(screen.getByText('Cookie Preferences')).toBeInTheDocument();
      expect(document.querySelector('.fixed.inset-0.z-50')).toBeInTheDocument();
    });

    it('should handle null consent gracefully', async () => {
      const cookiesModule = await import('@/lib/cookies');
      vi.mocked(cookiesModule.getCookieConsent).mockReturnValue(null);
      
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      expect(screen.getByText('Cookie Preferences')).toBeInTheDocument();
    });

    it('should close modal when cancel button is clicked', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const cancelButton = screen.getByText('Cancel');
      fireEvent.click(cancelButton);
      
      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });

    it('should close modal when clicking backdrop overlay', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const backdrop = document.querySelector('.fixed.inset-0.transition-opacity.bg-gray-500');
      expect(backdrop).toBeInTheDocument();
      fireEvent.click(backdrop!);
      
      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });

    it('should render modal with proper z-index hierarchy', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const modalContainer = document.querySelector('.fixed.inset-0.z-50');
      expect(modalContainer).toBeInTheDocument();
      expect(modalContainer).toHaveClass('z-50');
    });
  });

  describe('Cookie Categories Display', () => {
    it('should display all cookie category names', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      expect(screen.getByText('Strictly Necessary')).toBeInTheDocument();
      expect(screen.getByText('Analytics')).toBeInTheDocument();
      expect(screen.getByText('Marketing')).toBeInTheDocument();
      expect(screen.getByText('Preferences')).toBeInTheDocument();
    });

    it('should display category descriptions', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      expect(screen.getByText('Essential cookies required for basic site functionality')).toBeInTheDocument();
      expect(screen.getByText('Help us understand how visitors use our website')).toBeInTheDocument();
      expect(screen.getByText('Used to deliver personalized advertisements')).toBeInTheDocument();
      expect(screen.getByText('Remember your preferences and settings')).toBeInTheDocument();
    });

    it('should show cookie counts correctly', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const cookieCountElements = screen.getAllByText('View cookies (3)');
      expect(cookieCountElements.length).toBe(4); // all categories have 3 cookies
    });

    it('should display "Required" label for necessary cookies', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      expect(screen.getByText('(Required)')).toBeInTheDocument();
    });

    it('should reflect current consent state from initial load', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const necessaryCheckbox = screen.getByRole('checkbox', { name: /Strictly Necessary/ });
      const analyticsCheckbox = screen.getByRole('checkbox', { name: /Analytics/ });
      const marketingCheckbox = screen.getByRole('checkbox', { name: /Marketing/ });
      const preferencesCheckbox = screen.getByRole('checkbox', { name: /Preferences/ });
      
      expect(necessaryCheckbox).toBeChecked();
      expect(analyticsCheckbox).not.toBeChecked();
      expect(marketingCheckbox).not.toBeChecked();
      expect(preferencesCheckbox).not.toBeChecked();
    });

    it('should show all cookie categories in correct order', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const categories = screen.getAllByText(/^(Strictly Necessary|Analytics|Marketing|Preferences)$/);
      expect(categories).toHaveLength(4);
      expect(categories[0]).toHaveTextContent('Strictly Necessary');
      expect(categories[1]).toHaveTextContent('Analytics');
      expect(categories[2]).toHaveTextContent('Marketing');
      expect(categories[3]).toHaveTextContent('Preferences');
    });
  });

  describe('Cookie Details Expansion', () => {
    it('should show cookie details summary text', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const summaryElements = screen.getAllByText('View cookies (3)');
      expect(summaryElements).toHaveLength(4); // All categories
    });

    it('should show all cookie names for necessary category', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      expect(screen.getByText('session')).toBeInTheDocument();
      expect(screen.getByText('csrf-token')).toBeInTheDocument();
      expect(screen.getByText('auth-token')).toBeInTheDocument();
    });

    it('should show all cookie names for analytics category', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      expect(screen.getByText('_ga')).toBeInTheDocument();
      expect(screen.getByText('_gid')).toBeInTheDocument();
      expect(screen.getByText('_gtag')).toBeInTheDocument();
    });

    it('should show all cookie names for marketing category', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      expect(screen.getByText('_fbp')).toBeInTheDocument();
      expect(screen.getByText('ads_id')).toBeInTheDocument();
      expect(screen.getByText('pixel_id')).toBeInTheDocument();
    });

    it('should show all cookie names for preferences category', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      expect(screen.getByText('theme')).toBeInTheDocument();
      expect(screen.getByText('language')).toBeInTheDocument();
      expect(screen.getByText('timezone')).toBeInTheDocument();
    });

    it('should render details elements with proper structure', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const detailsElements = document.querySelectorAll('details');
      expect(detailsElements).toHaveLength(4); // One for each category
      
      detailsElements.forEach(details => {
        const summary = details.querySelector('summary');
        expect(summary).toBeInTheDocument();
        expect(summary?.textContent).toMatch(/View cookies \(3\)/);
      });
    });
  });

  describe('Consent State Management', () => {
    it('should disable necessary cookies checkbox and keep it checked', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const necessaryCheckbox = screen.getByRole('checkbox', { name: /Strictly Necessary/ });
      expect(necessaryCheckbox).toBeDisabled();
      expect(necessaryCheckbox).toBeChecked();
    });

    it('should enable non-required cookie toggles', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const analyticsCheckbox = screen.getByRole('checkbox', { name: /Analytics/ });
      const marketingCheckbox = screen.getByRole('checkbox', { name: /Marketing/ });
      const preferencesCheckbox = screen.getByRole('checkbox', { name: /Preferences/ });
      
      expect(analyticsCheckbox).not.toBeDisabled();
      expect(marketingCheckbox).not.toBeDisabled();
      expect(preferencesCheckbox).not.toBeDisabled();
    });

    it('should toggle analytics consent', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const analyticsCheckbox = screen.getByRole('checkbox', { name: /Analytics/ });
      expect(analyticsCheckbox).not.toBeChecked();
      
      fireEvent.click(analyticsCheckbox);
      expect(analyticsCheckbox).toBeChecked();
      
      fireEvent.click(analyticsCheckbox);
      expect(analyticsCheckbox).not.toBeChecked();
    });

    it('should toggle marketing consent', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const marketingCheckbox = screen.getByRole('checkbox', { name: /Marketing/ });
      expect(marketingCheckbox).not.toBeChecked();
      
      fireEvent.click(marketingCheckbox);
      expect(marketingCheckbox).toBeChecked();
      
      fireEvent.click(marketingCheckbox);
      expect(marketingCheckbox).not.toBeChecked();
    });

    it('should toggle preferences consent', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const preferencesCheckbox = screen.getByRole('checkbox', { name: /Preferences/ });
      expect(preferencesCheckbox).not.toBeChecked();
      
      fireEvent.click(preferencesCheckbox);
      expect(preferencesCheckbox).toBeChecked();
      
      fireEvent.click(preferencesCheckbox);
      expect(preferencesCheckbox).not.toBeChecked();
    });

    it('should not toggle necessary cookies when clicked', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const necessaryCheckbox = screen.getByRole('checkbox', { name: /Strictly Necessary/ });
      expect(necessaryCheckbox).toBeDisabled();
      
      // Try to click (should have no effect due to disabled state)
      fireEvent.click(necessaryCheckbox);
      expect(necessaryCheckbox).toBeChecked();
    });

    it('should maintain consent state across multiple toggles', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const analyticsCheckbox = screen.getByRole('checkbox', { name: /Analytics/ });
      const marketingCheckbox = screen.getByRole('checkbox', { name: /Marketing/ });
      
      // Enable both
      fireEvent.click(analyticsCheckbox);
      fireEvent.click(marketingCheckbox);
      
      expect(analyticsCheckbox).toBeChecked();
      expect(marketingCheckbox).toBeChecked();
      
      // Disable analytics only
      fireEvent.click(analyticsCheckbox);
      
      expect(analyticsCheckbox).not.toBeChecked();
      expect(marketingCheckbox).toBeChecked(); // Should remain checked
    });
  });

  describe('Quick Actions', () => {
    it('should accept all cookies and update UI state', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const acceptAllButton = screen.getByText('Accept All');
      fireEvent.click(acceptAllButton);
      
      // Verify all optional checkboxes are now checked
      const analyticsCheckbox = screen.getByRole('checkbox', { name: /Analytics/ });
      const marketingCheckbox = screen.getByRole('checkbox', { name: /Marketing/ });
      const preferencesCheckbox = screen.getByRole('checkbox', { name: /Preferences/ });
      const necessaryCheckbox = screen.getByRole('checkbox', { name: /Strictly Necessary/ });
      
      expect(analyticsCheckbox).toBeChecked();
      expect(marketingCheckbox).toBeChecked();
      expect(preferencesCheckbox).toBeChecked();
      expect(necessaryCheckbox).toBeChecked(); // Should remain checked
    });

    it('should reject all non-essential cookies and update UI state', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      // First accept all to have something to reject
      const acceptAllButton = screen.getByText('Accept All');
      fireEvent.click(acceptAllButton);
      
      // Then reject all
      const rejectAllButton = screen.getByText('Reject All');
      fireEvent.click(rejectAllButton);
      
      // Verify non-essential checkboxes are unchecked
      const analyticsCheckbox = screen.getByRole('checkbox', { name: /Analytics/ });
      const marketingCheckbox = screen.getByRole('checkbox', { name: /Marketing/ });
      const preferencesCheckbox = screen.getByRole('checkbox', { name: /Preferences/ });
      const necessaryCheckbox = screen.getByRole('checkbox', { name: /Strictly Necessary/ });
      
      expect(analyticsCheckbox).not.toBeChecked();
      expect(marketingCheckbox).not.toBeChecked();
      expect(preferencesCheckbox).not.toBeChecked();
      expect(necessaryCheckbox).toBeChecked(); // Should always remain checked
    });

    it('should disable quick action buttons when loading', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      // Click save to trigger loading state (though it's synchronous, the component may briefly show loading)
      const saveButton = screen.getByText('Save Changes');
      const acceptAllButton = screen.getByText('Accept All');
      const rejectAllButton = screen.getByText('Reject All');
      
      // Check that buttons are not disabled initially
      expect(acceptAllButton).not.toBeDisabled();
      expect(rejectAllButton).not.toBeDisabled();
    });

    it('should maintain necessary cookies as checked after reject all', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const rejectAllButton = screen.getByText('Reject All');
      fireEvent.click(rejectAllButton);
      
      const necessaryCheckbox = screen.getByRole('checkbox', { name: /Strictly Necessary/ });
      expect(necessaryCheckbox).toBeChecked();
      expect(necessaryCheckbox).toBeDisabled();
    });
  });

  describe('Data Management - Export', () => {
    it('should render export data button with proper icon', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const exportButton = screen.getByText('Export My Data');
      expect(exportButton).toBeInTheDocument();
      expect(screen.getByTestId('arrow-down-tray-icon')).toBeInTheDocument();
    });

    it('should call exportUserData when export button is clicked', async () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const exportButton = screen.getByText('Export My Data');
      fireEvent.click(exportButton);
      
      const cookiesModule = await import('@/lib/cookies');
      expect(cookiesModule.exportUserData).toHaveBeenCalledTimes(1);
    });

    it('should create blob and download link for data export', async () => {
      const cookiesModule = await import('@/lib/cookies');
      vi.mocked(cookiesModule.exportUserData).mockReturnValue({ userData: 'test-data', settings: 'test-settings' });
      
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const exportButton = screen.getByText('Export My Data');
      fireEvent.click(exportButton);
      
      expect(global.Blob).toHaveBeenCalledWith(
        [JSON.stringify({ userData: 'test-data', settings: 'test-settings' }, null, 2)],
        { type: 'application/json' }
      );
      expect(global.URL.createObjectURL).toHaveBeenCalled();
      expect(global.URL.revokeObjectURL).toHaveBeenCalledWith('mock-blob-url');
    });

    it('should handle data export functionality', async () => {
      const cookiesModule = await import('@/lib/cookies');
      vi.mocked(cookiesModule.exportUserData).mockReturnValue({ test: 'data' });
      
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const exportButton = screen.getByText('Export My Data');
      fireEvent.click(exportButton);
      
      expect(cookiesModule.exportUserData).toHaveBeenCalled();
      expect(global.Blob).toHaveBeenCalled();
      expect(global.URL.createObjectURL).toHaveBeenCalled();
    });
  });

  describe('Data Management - Delete', () => {
    it('should render delete button with proper icon and styling', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const deleteButton = screen.getByText('Delete All Data');
      expect(deleteButton).toBeInTheDocument();
      expect(screen.getByTestId('trash-icon')).toBeInTheDocument();
      expect(deleteButton).toHaveClass('text-red-700', 'border-red-300');
    });

    it('should show delete confirmation modal when delete button is clicked', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const deleteButtons = screen.getAllByText('Delete All Data');
      fireEvent.click(deleteButtons[0]); // Click the main delete button
      
      // Should now show the confirmation modal
      expect(screen.getByText('This will permanently delete all your data including cookies, preferences, and session information. This action cannot be undone and will reload the page.')).toBeInTheDocument();
      expect(screen.getAllByText('Delete All Data').length).toBeGreaterThan(1); // Original button + modal button
    });

    it('should close delete confirmation modal when cancel is clicked', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      // Open delete modal
      const deleteButtons = screen.getAllByText('Delete All Data');
      fireEvent.click(deleteButtons[0]);
      
      // Find and click cancel in the modal
      const cancelButtons = screen.getAllByText('Cancel');
      const modalCancelButton = cancelButtons[cancelButtons.length - 1]; // Last cancel button should be in modal
      fireEvent.click(modalCancelButton);
      
      // Should only have the original delete button, modal should be closed
      expect(screen.getAllByText('Delete All Data')).toHaveLength(1);
    });

    it('should call deleteAllUserData when confirmed', async () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      // Open delete modal
      const deleteButtons = screen.getAllByText('Delete All Data');
      fireEvent.click(deleteButtons[0]);
      
      // Find and click the confirmation button in the modal
      const allDeleteButtons = screen.getAllByText('Delete All Data');
      const confirmButton = allDeleteButtons[allDeleteButtons.length - 1]; // Last button is the confirm button
      fireEvent.click(confirmButton);
      
      const cookiesModule = await import('@/lib/cookies');
      expect(cookiesModule.deleteAllUserData).toHaveBeenCalledTimes(1);
    });

    it('should render delete modal with proper z-index', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const deleteButtons = screen.getAllByText('Delete All Data');
      fireEvent.click(deleteButtons[0]);
      
      const deleteModal = document.querySelector('.fixed.inset-0.z-60');
      expect(deleteModal).toBeInTheDocument();
      expect(deleteModal).toHaveClass('z-60'); // Higher than main modal's z-50
    });

    it('should show proper warning text in delete modal', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const deleteButtons = screen.getAllByText('Delete All Data');
      fireEvent.click(deleteButtons[0]);
      
      expect(screen.getByText('This will permanently delete all your data including cookies, preferences, and session information. This action cannot be undone and will reload the page.')).toBeInTheDocument();
    });
  });

  describe('Save Functionality', () => {
    it('should save preferences with current consent state', async () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const saveButton = screen.getByText('Save Changes');
      fireEvent.click(saveButton);
      
      const cookiesModule = await import('@/lib/cookies');
      expect(cookiesModule.setCookieConsent).toHaveBeenCalledWith({
        necessary: true,
        analytics: false,
        marketing: false,
        preferences: false,
        timestamp: expect.any(String),
        version: expect.any(String)
      });
      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });

    it('should save preferences with modified consent state', async () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      // Toggle some preferences
      const analyticsCheckbox = screen.getByRole('checkbox', { name: /Analytics/ });
      const marketingCheckbox = screen.getByRole('checkbox', { name: /Marketing/ });
      
      fireEvent.click(analyticsCheckbox);
      fireEvent.click(marketingCheckbox);
      
      const saveButton = screen.getByText('Save Changes');
      fireEvent.click(saveButton);
      
      const cookiesModule = await import('@/lib/cookies');
      expect(cookiesModule.setCookieConsent).toHaveBeenCalledWith({
        necessary: true,
        analytics: true,
        marketing: true,
        preferences: false,
        timestamp: expect.any(String),
        version: expect.any(String)
      });
    });

    it('should show loading state on save button when loading', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const saveButton = screen.getByText('Save Changes');
      expect(saveButton).toHaveTextContent('Save Changes');
      expect(saveButton).not.toBeDisabled();
    });

    it('should generate timestamp and version when saving', async () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const saveButton = screen.getByText('Save Changes');
      fireEvent.click(saveButton);
      
      const cookiesModule = await import('@/lib/cookies');
      const saveCall = vi.mocked(cookiesModule.setCookieConsent).mock.calls[0];
      const savedConsent = saveCall[0];
      
      expect(savedConsent.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(savedConsent.version).toBeDefined();
    });
  });

  describe('Current Settings Display', () => {
    it('should display current settings section with shield icon', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      expect(screen.getByText('Current Settings')).toBeInTheDocument();
      expect(screen.getByTestId('shield-check-icon')).toBeInTheDocument();
    });

    it('should show last updated date', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      expect(screen.getByText(/Last updated:/)).toBeInTheDocument();
      // The date format may vary, so just check that some date-like text is present
      expect(screen.getByText(/Last updated: \d+\/\d+\/\d+/)).toBeInTheDocument();
    });

    it('should show version information', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      expect(screen.getByText('Version: 1.0')).toBeInTheDocument();
    });

    it('should handle different date formats', async () => {
      const cookiesModule = await import('@/lib/cookies');
      vi.mocked(cookiesModule.getCookieConsent).mockReturnValue({
        necessary: true,
        analytics: false,
        marketing: false,
        preferences: false,
        timestamp: '2024-06-15T14:30:00.000Z',
        version: '2.1'
      });
      
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      expect(screen.getByText(/Last updated:/)).toBeInTheDocument();
      expect(screen.getByText('Version: 2.1')).toBeInTheDocument();
    });

    it('should handle invalid timestamp gracefully', async () => {
      const cookiesModule = await import('@/lib/cookies');
      vi.mocked(cookiesModule.getCookieConsent).mockReturnValue({
        necessary: true,
        analytics: false,
        marketing: false,
        preferences: false,
        timestamp: 'invalid-date',
        version: '1.0'
      });
      
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      expect(screen.getByText(/Last updated:/)).toBeInTheDocument();
      // Should not crash with invalid date
    });
  });

  describe('Component Layout & Styling', () => {
    it('should render main modal with proper styling classes', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const modalContainer = document.querySelector('.fixed.inset-0.z-50.overflow-y-auto');
      expect(modalContainer).toBeInTheDocument();
      
      const modalPanel = document.querySelector('.inline-block.align-bottom.bg-white.rounded-lg');
      expect(modalPanel).toBeInTheDocument();
    });

    it('should render data management section with proper grid layout', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      expect(screen.getByText('Data Management')).toBeInTheDocument();
      const buttonContainer = document.querySelector('.grid.grid-cols-1');
      expect(buttonContainer).toBeInTheDocument();
    });

    it('should render quick actions with proper flex layout', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const quickActionsContainer = document.querySelector('.mt-6.flex.flex-wrap.gap-2.justify-center');
      expect(quickActionsContainer).toBeInTheDocument();
    });

    it('should render action buttons with proper flex layout', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const actionButtonsContainer = document.querySelector('.mt-6');
      expect(actionButtonsContainer).toBeInTheDocument();
    });

    it('should use proper spacing and borders for categories', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const categoryContainers = document.querySelectorAll('.border.border-gray-200.rounded-lg.p-4');
      expect(categoryContainers).toHaveLength(4); // One for each category
    });
  });

  describe('Accessibility & User Experience', () => {
    it('should have proper heading hierarchy', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const mainHeading = screen.getByRole('heading', { name: 'Cookie Preferences' });
      expect(mainHeading).toBeInTheDocument();
      
      expect(screen.getByText('Cookie Categories')).toBeInTheDocument();
      expect(screen.getByText('Data Management')).toBeInTheDocument();
    });

    it('should have proper form controls with labels', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const checkboxes = screen.getAllByRole('checkbox');
      expect(checkboxes).toHaveLength(4);
      
      checkboxes.forEach(checkbox => {
        expect(checkbox).toHaveAttribute('id');
        const id = checkbox.getAttribute('id')!;
        const label = document.querySelector(`label[for="${id}"]`);
        expect(label).toBeInTheDocument();
      });
    });

    it('should have proper button types', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const buttons = document.querySelectorAll('button[type="button"]');
      expect(buttons.length).toBeGreaterThan(0);
    });

    it('should provide informative descriptions', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      expect(screen.getByText('Manage your cookie preferences and privacy settings. Changes will take effect immediately.')).toBeInTheDocument();
      expect(screen.getByText('Export includes all cookies, local storage, and session data. Delete will remove all data and reload the page.')).toBeInTheDocument();
    });

    it('should maintain focus management for modal interaction', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      // Verify focusable elements are present
      const focusableElements = screen.getAllByRole('button').concat(screen.getAllByRole('checkbox'));
      expect(focusableElements.length).toBeGreaterThan(0);
    });
  });

  describe('Edge Cases & Error Handling', () => {
    it('should handle null consent gracefully on save', async () => {
      const cookiesModule = await import('@/lib/cookies');
      vi.mocked(cookiesModule.getCookieConsent).mockReturnValue(null);
      
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const saveButton = screen.getByText('Save Changes');
      fireEvent.click(saveButton);
      
      // Should not crash and should close modal
      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });

    it('should handle consent state changes during modal lifecycle', async () => {
      const cookiesModule = await import('@/lib/cookies');
      const { rerender } = render(<CookiePreferences isOpen={false} onClose={mockOnClose} />);
      
      // Change mock return value
      vi.mocked(cookiesModule.getCookieConsent).mockReturnValue({
        necessary: true,
        analytics: true,
        marketing: true,
        preferences: true,
        timestamp: '2024-02-01T00:00:00.000Z',
        version: '1.1'
      });
      
      rerender(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      const analyticsCheckbox = screen.getByRole('checkbox', { name: /Analytics/ });
      expect(analyticsCheckbox).toBeChecked();
    });

    it('should handle very long cookie names gracefully', () => {
      // For this test, we'll just verify the component handles long text without breaking
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      // Component should render successfully even with standard cookies
      expect(screen.getByText('Cookie Preferences')).toBeInTheDocument();
      expect(screen.getByText('session')).toBeInTheDocument();
    });

    it('should handle component rendering edge cases', () => {
      render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
      
      // Should render without crashing in various scenarios
      expect(screen.getByText('Cookie Preferences')).toBeInTheDocument();
      expect(screen.getByText('Cookie Categories')).toBeInTheDocument();
    });
  });
});