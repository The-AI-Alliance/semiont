import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
      description: 'Essential cookies',
      required: true,
      cookies: ['session']
    },
    {
      id: 'analytics', 
      name: 'Analytics',
      description: 'Analytics cookies',
      required: false,
      cookies: ['_ga']
    },
    {
      id: 'marketing',
      name: 'Marketing',
      description: 'Marketing cookies',
      required: false,
      cookies: ['_fbp']
    },
    {
      id: 'preferences',
      name: 'Preferences',
      description: 'Preference cookies',
      required: false,
      cookies: ['theme']
    }
  ]
}));

// Mock DOM APIs for file downloads
global.URL.createObjectURL = vi.fn(() => 'mock-blob-url');
global.URL.revokeObjectURL = vi.fn();
global.Blob = vi.fn();

describe('CookiePreferences - Comprehensive Tests', () => {
  const mockOnClose = vi.fn();
  
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should not render when isOpen is false', () => {
    render(<CookiePreferences isOpen={false} onClose={mockOnClose} />);
    
    expect(screen.queryByText('Cookie Preferences')).not.toBeInTheDocument();
  });

  it('should render basic content when isOpen is true', async () => {
    const cookiesModule = await import('@/lib/cookies');
    vi.mocked(cookiesModule.getCookieConsent).mockReturnValue({
      necessary: true,
      analytics: false,
      marketing: false,
      preferences: false,
      timestamp: '2023-01-01T00:00:00.000Z',
      version: '1.0'
    });

    render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
    
    expect(screen.getByText('Cookie Preferences')).toBeInTheDocument();
  });

  it('should call onClose when cancel is clicked', async () => {
    const cookiesModule = await import('@/lib/cookies');
    vi.mocked(cookiesModule.getCookieConsent).mockReturnValue({
      necessary: true,
      analytics: false,
      marketing: false,
      preferences: false,
      timestamp: '2023-01-01T00:00:00.000Z',
      version: '1.0'
    });

    render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
    
    const cancelButton = screen.getByText('Cancel');
    fireEvent.click(cancelButton);
    
    expect(mockOnClose).toHaveBeenCalled();
  });

  it('should show all cookie categories with correct states', async () => {
    const cookiesModule = await import('@/lib/cookies');
    vi.mocked(cookiesModule.getCookieConsent).mockReturnValue({
      necessary: true,
      analytics: true,
      marketing: false,
      preferences: false,
      timestamp: '2023-01-01T00:00:00.000Z',
      version: '1.0'
    });

    render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
    
    expect(screen.getByText('Strictly Necessary')).toBeInTheDocument();
    expect(screen.getByText('Analytics')).toBeInTheDocument();
    expect(screen.getByText('Marketing')).toBeInTheDocument();
    expect(screen.getByText('Preferences')).toBeInTheDocument();

    // Check checkbox states
    const necessaryCheckbox = screen.getByLabelText(/Strictly Necessary/);
    const analyticsCheckbox = screen.getByLabelText(/Analytics/);
    const marketingCheckbox = screen.getByLabelText(/Marketing/);
    
    expect(necessaryCheckbox).toBeChecked();
    expect(necessaryCheckbox).toBeDisabled(); // Required category
    expect(analyticsCheckbox).toBeChecked();
    expect(marketingCheckbox).not.toBeChecked();
  });

  it('should toggle cookie preferences', async () => {
    const cookiesModule = await import('@/lib/cookies');
    vi.mocked(cookiesModule.getCookieConsent).mockReturnValue({
      necessary: true,
      analytics: false,
      marketing: false,
      preferences: false,
      timestamp: '2023-01-01T00:00:00.000Z',
      version: '1.0'
    });

    render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
    
    const analyticsCheckbox = screen.getByLabelText(/Analytics/);
    expect(analyticsCheckbox).not.toBeChecked();
    
    fireEvent.click(analyticsCheckbox);
    expect(analyticsCheckbox).toBeChecked();
  });

  it('should save preferences and close modal', async () => {
    const cookiesModule = await import('@/lib/cookies');
    const mockGetCookieConsent = vi.mocked(cookiesModule.getCookieConsent);
    const mockSetCookieConsent = vi.mocked(cookiesModule.setCookieConsent);
    
    mockGetCookieConsent.mockReturnValue({
      necessary: true,
      analytics: false,
      marketing: false,
      preferences: false,
      timestamp: '2023-01-01T00:00:00.000Z',
      version: '1.0'
    });

    render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
    
    const saveButton = screen.getByText('Save Changes');
    fireEvent.click(saveButton);
    
    await waitFor(() => {
      expect(mockSetCookieConsent).toHaveBeenCalled();
      expect(mockOnClose).toHaveBeenCalled();
    });
  });

  it('should handle data export', async () => {
    const cookiesModule = await import('@/lib/cookies');
    const mockGetCookieConsent = vi.mocked(cookiesModule.getCookieConsent);
    const mockExportUserData = vi.mocked(cookiesModule.exportUserData);
    
    mockGetCookieConsent.mockReturnValue({
      necessary: true,
      analytics: false,
      marketing: false,
      preferences: false,
      timestamp: '2023-01-01T00:00:00.000Z',
      version: '1.0'
    });
    mockExportUserData.mockReturnValue({ data: 'test' });

    render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
    
    const exportButton = screen.getByText('Export My Data');
    fireEvent.click(exportButton);
    
    expect(mockExportUserData).toHaveBeenCalled();
    expect(global.Blob).toHaveBeenCalled();
  });

  it('should show delete confirmation modal', async () => {
    const cookiesModule = await import('@/lib/cookies');
    vi.mocked(cookiesModule.getCookieConsent).mockReturnValue({
      necessary: true,
      analytics: false,
      marketing: false,
      preferences: false,
      timestamp: '2023-01-01T00:00:00.000Z',
      version: '1.0'
    });

    render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
    
    const deleteButtons = screen.getAllByText('Delete All Data');
    fireEvent.click(deleteButtons[0]); // Click first delete button
    
    // Should have more instances now (button, title, modal button)
    expect(screen.getAllByText('Delete All Data').length).toBeGreaterThan(1);
    expect(screen.getByText(/This will permanently delete all your data/)).toBeInTheDocument();
  });

  it('should handle delete confirmation', async () => {
    const cookiesModule = await import('@/lib/cookies');
    const mockGetCookieConsent = vi.mocked(cookiesModule.getCookieConsent);
    const mockDeleteAllUserData = vi.mocked(cookiesModule.deleteAllUserData);
    
    mockGetCookieConsent.mockReturnValue({
      necessary: true,
      analytics: false,
      marketing: false,
      preferences: false,
      timestamp: '2023-01-01T00:00:00.000Z',
      version: '1.0'
    });

    render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
    
    // Open delete modal
    const deleteButtons = screen.getAllByText('Delete All Data');
    fireEvent.click(deleteButtons[0]);
    
    // Find and click the actual confirm button in the modal (should be the last one)
    const allDeleteButtons = screen.getAllByText('Delete All Data');
    const confirmButton = allDeleteButtons[allDeleteButtons.length - 1]; // Last button is the confirm button
    fireEvent.click(confirmButton);
    
    expect(mockDeleteAllUserData).toHaveBeenCalled();
  });

  it('should display current settings info', async () => {
    const cookiesModule = await import('@/lib/cookies');
    vi.mocked(cookiesModule.getCookieConsent).mockReturnValue({
      necessary: true,
      analytics: false,
      marketing: false,
      preferences: false,
      timestamp: '2023-06-15T10:30:00.000Z',
      version: '1.0'
    });

    render(<CookiePreferences isOpen={true} onClose={mockOnClose} />);
    
    expect(screen.getByText('Current Settings')).toBeInTheDocument();
    expect(screen.getByText('Version: 1.0')).toBeInTheDocument();
    expect(screen.getByText(/Last updated:/)).toBeInTheDocument();
  });
});