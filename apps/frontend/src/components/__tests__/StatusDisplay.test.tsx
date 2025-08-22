import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { StatusDisplay } from '../StatusDisplay';

// Mock the useBackendStatus hook
vi.mock('@/hooks/useAPI', () => ({
  useBackendStatus: vi.fn()
}));

// Mock the useAuth hook
vi.mock('@/hooks/useAuth', () => ({
  useAuth: vi.fn()
}));

// Import mocked functions
import { useBackendStatus } from '@/hooks/useAPI';
import { useAuth } from '@/hooks/useAuth';

// Type the mocked functions
const mockUseBackendStatus = useBackendStatus as vi.MockedFunction<typeof useBackendStatus>;
const mockUseAuth = useAuth as vi.MockedFunction<typeof useAuth>;

// Test data fixtures
const mockStatusStates = {
  loading: {
    data: null,
    isLoading: true,
    error: null
  },
  success: {
    data: { status: 'healthy', version: '1.2.3' },
    isLoading: false,
    error: null
  },
  successWithDifferentStatus: {
    data: { status: 'operational', version: '2.0.0' },
    isLoading: false,
    error: null
  },
  error: {
    data: null,
    isLoading: false,
    error: new Error('Connection failed')
  },
  errorWithDetails: {
    data: null,
    isLoading: false,
    error: new Error('Network timeout')
  },
  unknown: {
    data: null,
    isLoading: false,
    error: null
  },
  malformedData: {
    data: { status: null, version: undefined },
    isLoading: false,
    error: null
  },
  partialData: {
    data: { status: 'healthy' }, // Missing version
    isLoading: false,
    error: null
  },
  longVersionData: {
    data: { status: 'healthy', version: '1.2.3-alpha.beta.rc.build.12345' },
    isLoading: false,
    error: null
  },
  specialCharacterData: {
    data: { status: 'healthy-🚀', version: '1.2.3-β' },
    isLoading: false,
    error: null
  }
};

describe('StatusDisplay Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default to authenticated state for most tests
    mockUseAuth.mockReturnValue({
      isFullyAuthenticated: true,
      session: { backendToken: 'test-token' },
      isLoading: false,
      isAuthenticated: true,
      hasValidBackendToken: true,
      user: null,
      backendUser: null,
      userDomain: null,
      displayName: 'Test User',
      avatarUrl: null,
      isAdmin: false
    } as any);
  });

  describe('Backend Status State Tests', () => {
    it('should display loading state with correct content and styling', () => {
      mockUseBackendStatus.mockReturnValue(mockStatusStates.loading);

      render(<StatusDisplay />);

      expect(screen.getByText('🚀 Frontend Status: Ready • Backend: Connecting...')).toBeInTheDocument();
      
      const statusSection = screen.getByRole('status');
      expect(statusSection).toHaveClass('bg-yellow-50', 'dark:bg-yellow-900/20');
      
      const statusText = screen.getByText(/Frontend Status: Ready/);
      expect(statusText).toHaveClass('text-yellow-800', 'dark:text-yellow-200');
    });

    it('should display success state with backend data', () => {
      mockUseBackendStatus.mockReturnValue(mockStatusStates.success);

      render(<StatusDisplay />);

      expect(screen.getByText('🚀 Frontend Status: Ready • Backend: healthy (v1.2.3)')).toBeInTheDocument();
      
      const statusSection = screen.getByRole('status');
      expect(statusSection).toHaveClass('bg-blue-50', 'dark:bg-blue-900/20');
      
      const statusText = screen.getByText(/Frontend Status: Ready/);
      expect(statusText).toHaveClass('text-blue-800', 'dark:text-blue-200');
    });

    it('should display error state with connection failure', () => {
      mockUseBackendStatus.mockReturnValue(mockStatusStates.error);

      render(<StatusDisplay />);

      expect(screen.getByText('🚀 Frontend Status: Ready • Backend: Connection failed')).toBeInTheDocument();
      
      const statusSection = screen.getByRole('status');
      expect(statusSection).toHaveClass('bg-red-50', 'dark:bg-red-900/20');
      
      const statusText = screen.getByText(/Frontend Status: Ready/);
      expect(statusText).toHaveClass('text-red-800', 'dark:text-red-200');
    });

    it('should display unknown state when no data, loading, or error', () => {
      mockUseBackendStatus.mockReturnValue(mockStatusStates.unknown);

      render(<StatusDisplay />);

      expect(screen.getByText('🚀 Frontend Status: Ready • Backend: Unknown')).toBeInTheDocument();
      
      const statusSection = screen.getByRole('status');
      expect(statusSection).toHaveClass('bg-red-50', 'dark:bg-red-900/20');
      
      const statusText = screen.getByText(/Frontend Status: Ready/);
      expect(statusText).toHaveClass('text-red-800', 'dark:text-red-200');
    });

    it('should handle different backend status values', () => {
      mockUseBackendStatus.mockReturnValue(mockStatusStates.successWithDifferentStatus);

      render(<StatusDisplay />);

      expect(screen.getByText('🚀 Frontend Status: Ready • Backend: operational (v2.0.0)')).toBeInTheDocument();
    });

    it('should always show frontend as Ready regardless of backend state', () => {
      // Test with loading state
      mockUseBackendStatus.mockReturnValue(mockStatusStates.loading);
      const { rerender } = render(<StatusDisplay />);
      expect(screen.getByText(/Frontend Status: Ready/)).toBeInTheDocument();

      // Test with error state
      mockUseBackendStatus.mockReturnValue(mockStatusStates.error);
      rerender(<StatusDisplay />);
      expect(screen.getByText(/Frontend Status: Ready/)).toBeInTheDocument();

      // Test with success state
      mockUseBackendStatus.mockReturnValue(mockStatusStates.success);
      rerender(<StatusDisplay />);
      expect(screen.getByText(/Frontend Status: Ready/)).toBeInTheDocument();
    });

    it('should handle state transitions correctly', () => {
      // Start with loading
      mockUseBackendStatus.mockReturnValue(mockStatusStates.loading);
      const { rerender } = render(<StatusDisplay />);
      
      expect(screen.getByText(/Connecting\.\.\./)).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveClass('bg-yellow-50');

      // Transition to success
      mockUseBackendStatus.mockReturnValue(mockStatusStates.success);
      rerender(<StatusDisplay />);
      
      expect(screen.getByText(/healthy \(v1\.2\.3\)/)).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveClass('bg-blue-50');

      // Transition to error
      mockUseBackendStatus.mockReturnValue(mockStatusStates.error);
      rerender(<StatusDisplay />);
      
      expect(screen.getByText(/Connection failed/)).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveClass('bg-red-50');
    });

    it('should call useBackendStatus with correct parameters', () => {
      mockUseBackendStatus.mockReturnValue(mockStatusStates.success);

      render(<StatusDisplay />);

      expect(mockUseBackendStatus).toHaveBeenCalledWith({
        pollingInterval: 30000,
        enabled: true
      });
    });
  });

  describe('Content and Styling Tests', () => {
    it('should generate correct status content for loading state', () => {
      mockUseBackendStatus.mockReturnValue(mockStatusStates.loading);

      render(<StatusDisplay />);

      const content = screen.getByText('🚀 Frontend Status: Ready • Backend: Connecting...');
      expect(content).toBeInTheDocument();
    });

    it('should generate correct status content for success state', () => {
      mockUseBackendStatus.mockReturnValue(mockStatusStates.success);

      render(<StatusDisplay />);

      const content = screen.getByText('🚀 Frontend Status: Ready • Backend: healthy (v1.2.3)');
      expect(content).toBeInTheDocument();
    });

    it('should generate correct status content for error state', () => {
      mockUseBackendStatus.mockReturnValue(mockStatusStates.error);

      render(<StatusDisplay />);

      const content = screen.getByText('🚀 Frontend Status: Ready • Backend: Connection failed');
      expect(content).toBeInTheDocument();
    });

    it('should generate correct status content for unknown state', () => {
      mockUseBackendStatus.mockReturnValue(mockStatusStates.unknown);

      render(<StatusDisplay />);

      const content = screen.getByText('🚀 Frontend Status: Ready • Backend: Unknown');
      expect(content).toBeInTheDocument();
    });

    it('should apply correct text colors for each state', () => {
      // Success state - blue
      mockUseBackendStatus.mockReturnValue(mockStatusStates.success);
      const { rerender } = render(<StatusDisplay />);
      let statusText = screen.getByText(/Frontend Status: Ready/);
      expect(statusText).toHaveClass('text-blue-800', 'dark:text-blue-200');

      // Loading state - yellow
      mockUseBackendStatus.mockReturnValue(mockStatusStates.loading);
      rerender(<StatusDisplay />);
      statusText = screen.getByText(/Frontend Status: Ready/);
      expect(statusText).toHaveClass('text-yellow-800', 'dark:text-yellow-200');

      // Error state - red
      mockUseBackendStatus.mockReturnValue(mockStatusStates.error);
      rerender(<StatusDisplay />);
      statusText = screen.getByText(/Frontend Status: Ready/);
      expect(statusText).toHaveClass('text-red-800', 'dark:text-red-200');

      // Unknown state - red
      mockUseBackendStatus.mockReturnValue(mockStatusStates.unknown);
      rerender(<StatusDisplay />);
      statusText = screen.getByText(/Frontend Status: Ready/);
      expect(statusText).toHaveClass('text-red-800', 'dark:text-red-200');
    });

    it('should apply correct background colors for each state', () => {
      // Success state - blue background
      mockUseBackendStatus.mockReturnValue(mockStatusStates.success);
      const { rerender } = render(<StatusDisplay />);
      let statusSection = screen.getByRole('status');
      expect(statusSection).toHaveClass('bg-blue-50', 'dark:bg-blue-900/20');

      // Loading state - yellow background
      mockUseBackendStatus.mockReturnValue(mockStatusStates.loading);
      rerender(<StatusDisplay />);
      statusSection = screen.getByRole('status');
      expect(statusSection).toHaveClass('bg-yellow-50', 'dark:bg-yellow-900/20');

      // Error state - red background
      mockUseBackendStatus.mockReturnValue(mockStatusStates.error);
      rerender(<StatusDisplay />);
      statusSection = screen.getByRole('status');
      expect(statusSection).toHaveClass('bg-red-50', 'dark:bg-red-900/20');

      // Unknown state - red background
      mockUseBackendStatus.mockReturnValue(mockStatusStates.unknown);
      rerender(<StatusDisplay />);
      statusSection = screen.getByRole('status');
      expect(statusSection).toHaveClass('bg-red-50', 'dark:bg-red-900/20');
    });

    it('should include rocket emoji in all states', () => {
      const states = [mockStatusStates.success, mockStatusStates.loading, mockStatusStates.error, mockStatusStates.unknown];
      
      states.forEach((state) => {
        mockUseBackendStatus.mockReturnValue(state);
        const { unmount } = render(<StatusDisplay />);
        
        const emojiText = screen.getByText(/🚀/);
        expect(emojiText).toBeInTheDocument();
        
        unmount(); // Clean up between renders
      });
    });

    it('should display version information when available', () => {
      mockUseBackendStatus.mockReturnValue(mockStatusStates.success);

      render(<StatusDisplay />);

      expect(screen.getByText(/v1\.2\.3/)).toBeInTheDocument();
    });

    it('should not display error message when status is successful', () => {
      mockUseBackendStatus.mockReturnValue(mockStatusStates.success);

      render(<StatusDisplay />);

      expect(screen.queryByText(/Check that the backend server is running/)).not.toBeInTheDocument();
    });

    it('should not display error message when loading', () => {
      mockUseBackendStatus.mockReturnValue(mockStatusStates.loading);

      render(<StatusDisplay />);

      expect(screen.queryByText(/Check that the backend server is running/)).not.toBeInTheDocument();
    });
  });

  describe('Accessibility and Error Handling Tests', () => {
    it('should have proper ARIA role="status" attribute', () => {
      mockUseBackendStatus.mockReturnValue(mockStatusStates.success);

      render(<StatusDisplay />);

      const statusSection = screen.getByRole('status');
      expect(statusSection).toBeInTheDocument();
      expect(statusSection).toHaveAttribute('role', 'status');
    });

    it('should have ARIA aria-live="polite" for status updates', () => {
      mockUseBackendStatus.mockReturnValue(mockStatusStates.success);

      render(<StatusDisplay />);

      const statusSection = screen.getByRole('status');
      expect(statusSection).toHaveAttribute('aria-live', 'polite');
    });

    it('should have ARIA aria-label for screen readers', () => {
      mockUseBackendStatus.mockReturnValue(mockStatusStates.success);

      render(<StatusDisplay />);

      const statusSection = screen.getByRole('status');
      expect(statusSection).toHaveAttribute('aria-label', 'System status information');
    });

    it('should include screen reader only text for status', () => {
      mockUseBackendStatus.mockReturnValue(mockStatusStates.success);

      render(<StatusDisplay />);

      const srOnlyText = screen.getByText('System status:');
      expect(srOnlyText).toBeInTheDocument();
      expect(srOnlyText).toHaveClass('sr-only');
    });

    it('should show error alert with proper role when error occurs', () => {
      mockUseBackendStatus.mockReturnValue(mockStatusStates.error);

      render(<StatusDisplay />);

      const errorAlert = screen.getByRole('alert');
      expect(errorAlert).toBeInTheDocument();
      expect(errorAlert).toHaveAttribute('role', 'alert');
      expect(errorAlert).toHaveTextContent('Check that the backend server is running and accessible');
    });

    it('should include screen reader only text for errors', () => {
      mockUseBackendStatus.mockReturnValue(mockStatusStates.error);

      render(<StatusDisplay />);

      const errorSrText = screen.getByText('Error:');
      expect(errorSrText).toBeInTheDocument();
      expect(errorSrText).toHaveClass('sr-only');
    });

    it('should have proper error message styling', () => {
      mockUseBackendStatus.mockReturnValue(mockStatusStates.error);

      render(<StatusDisplay />);

      const errorMessage = screen.getByRole('alert');
      expect(errorMessage).toHaveClass('text-xs', 'text-red-600', 'dark:text-red-400', 'mt-1');
    });

    it('should maintain semantic HTML structure', () => {
      mockUseBackendStatus.mockReturnValue(mockStatusStates.success);

      const { container } = render(<StatusDisplay />);

      // Should be a section element
      const section = container.querySelector('section');
      expect(section).toBeInTheDocument();
      expect(section).toHaveAttribute('role', 'status');

      // Should contain a paragraph for the main status
      const statusParagraph = section?.querySelector('p');
      expect(statusParagraph).toBeInTheDocument();
    });
  });

  describe('Hook Integration Tests', () => {
    it('should call useBackendStatus with polling interval of 30 seconds', () => {
      mockUseBackendStatus.mockReturnValue(mockStatusStates.success);

      render(<StatusDisplay />);

      expect(mockUseBackendStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          pollingInterval: 30000
        })
      );
    });

    it('should call useBackendStatus with enabled: true', () => {
      mockUseBackendStatus.mockReturnValue(mockStatusStates.success);

      render(<StatusDisplay />);

      expect(mockUseBackendStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: true
        })
      );
    });

    it('should handle hook return value data property', () => {
      mockUseBackendStatus.mockReturnValue(mockStatusStates.success);

      render(<StatusDisplay />);

      expect(screen.getByText(/healthy/)).toBeInTheDocument();
      expect(screen.getByText(/v1\.2\.3/)).toBeInTheDocument();
    });

    it('should handle hook return value isLoading property', () => {
      mockUseBackendStatus.mockReturnValue(mockStatusStates.loading);

      render(<StatusDisplay />);

      expect(screen.getByText(/Connecting\.\.\./)).toBeInTheDocument();
    });

    it('should handle hook return value error property', () => {
      mockUseBackendStatus.mockReturnValue(mockStatusStates.error);

      render(<StatusDisplay />);

      expect(screen.getByText(/Connection failed/)).toBeInTheDocument();
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    it('should be called exactly once per render', () => {
      mockUseBackendStatus.mockReturnValue(mockStatusStates.success);

      render(<StatusDisplay />);

      expect(mockUseBackendStatus).toHaveBeenCalledTimes(1);
    });
  });

  describe('Edge Cases and Robustness Tests', () => {
    it('should handle malformed backend response data', () => {
      mockUseBackendStatus.mockReturnValue(mockStatusStates.malformedData);

      render(<StatusDisplay />);

      // Should still render something reasonable when data is malformed
      expect(screen.getByText(/Frontend Status: Ready/)).toBeInTheDocument();
      expect(screen.getByText(/Backend: null \(vundefined\)/)).toBeInTheDocument();
    });

    it('should handle missing version information gracefully', () => {
      mockUseBackendStatus.mockReturnValue(mockStatusStates.partialData);

      render(<StatusDisplay />);

      expect(screen.getByText('🚀 Frontend Status: Ready • Backend: healthy (vundefined)')).toBeInTheDocument();
    });

    it('should handle missing status information', () => {
      const missingStatusData = {
        data: { version: '1.2.3' },
        isLoading: false,
        error: null
      };
      mockUseBackendStatus.mockReturnValue(missingStatusData);

      render(<StatusDisplay />);

      expect(screen.getByText('🚀 Frontend Status: Ready • Backend: undefined (v1.2.3)')).toBeInTheDocument();
    });

    it('should handle null data gracefully', () => {
      const nullData = {
        data: null,
        isLoading: false,
        error: null
      };
      mockUseBackendStatus.mockReturnValue(nullData);

      render(<StatusDisplay />);

      expect(screen.getByText('🚀 Frontend Status: Ready • Backend: Unknown')).toBeInTheDocument();
    });

    it('should handle long version strings without breaking layout', () => {
      mockUseBackendStatus.mockReturnValue(mockStatusStates.longVersionData);

      render(<StatusDisplay />);

      expect(screen.getByText(/v1\.2\.3-alpha\.beta\.rc\.build\.12345/)).toBeInTheDocument();
    });

    it('should handle special characters in status and version', () => {
      mockUseBackendStatus.mockReturnValue(mockStatusStates.specialCharacterData);

      render(<StatusDisplay />);

      expect(screen.getByText(/healthy-🚀/)).toBeInTheDocument();
      expect(screen.getByText(/v1\.2\.3-β/)).toBeInTheDocument();
    });

    it('should handle different error types', () => {
      mockUseBackendStatus.mockReturnValue(mockStatusStates.errorWithDetails);

      render(<StatusDisplay />);

      expect(screen.getByText(/Connection failed/)).toBeInTheDocument();
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    it('should maintain consistent structure across all states', () => {
      const states = [mockStatusStates.success, mockStatusStates.loading, mockStatusStates.error, mockStatusStates.unknown];
      
      states.forEach((state) => {
        mockUseBackendStatus.mockReturnValue(state);
        const { container, unmount } = render(<StatusDisplay />);
        
        // Should always have a section with role="status"
        expect(container.querySelector('section[role="status"]')).toBeInTheDocument();
        
        // Should always have the main status paragraph
        expect(container.querySelector('section p')).toBeInTheDocument();
        
        unmount(); // Clean up between renders
      });
    });

    it('should not crash with unexpected hook return values', () => {
      // Mock an unexpected return value
      const unexpectedReturn = {
        data: 'not an object',
        isLoading: 'not a boolean',
        error: 'not an error object'
      };
      mockUseBackendStatus.mockReturnValue(unexpectedReturn as any);

      expect(() => render(<StatusDisplay />)).not.toThrow();
      expect(screen.getByRole('status')).toBeInTheDocument();
    });
  });

  describe('Authentication State Tests', () => {
    it('should display authentication required message when not authenticated', () => {
      // Mock unauthenticated state
      mockUseAuth.mockReturnValue({
        isFullyAuthenticated: false,
        session: null,
        isLoading: false,
        isAuthenticated: false,
        hasValidBackendToken: false,
        user: null,
        backendUser: null,
        userDomain: null,
        displayName: null,
        avatarUrl: null,
        isAdmin: false
      } as any);
      
      mockUseBackendStatus.mockReturnValue(mockStatusStates.unknown);

      render(<StatusDisplay />);

      expect(screen.getByText('🚀 Frontend Status: Ready • Backend: Authentication required')).toBeInTheDocument();
      expect(screen.getByText('Sign in to view backend status')).toBeInTheDocument();
      
      const statusSection = screen.getByRole('status');
      expect(statusSection).toHaveClass('bg-gray-50', 'dark:bg-gray-900/20');
      
      const statusText = screen.getByText(/Frontend Status: Ready/);
      expect(statusText).toHaveClass('text-gray-800', 'dark:text-gray-200');
    });

    it('should display authenticated message when partially authenticated', () => {
      // Mock partially authenticated state (no backend token)
      mockUseAuth.mockReturnValue({
        isFullyAuthenticated: false,
        session: { user: { email: 'test@example.com' } },
        isLoading: false,
        isAuthenticated: true,
        hasValidBackendToken: false,
        user: { email: 'test@example.com' },
        backendUser: null,
        userDomain: 'example.com',
        displayName: 'Test User',
        avatarUrl: null,
        isAdmin: false
      } as any);
      
      mockUseBackendStatus.mockReturnValue(mockStatusStates.unknown);

      render(<StatusDisplay />);

      expect(screen.getByText('🚀 Frontend Status: Ready • Backend: Authentication required')).toBeInTheDocument();
      expect(screen.getByText('Sign in to view backend status')).toBeInTheDocument();
    });

    it('should display backend status when fully authenticated', () => {
      // Use default authenticated state from beforeEach
      mockUseBackendStatus.mockReturnValue(mockStatusStates.success);

      render(<StatusDisplay />);

      expect(screen.getByText('🚀 Frontend Status: Ready • Backend: healthy (v1.2.3)')).toBeInTheDocument();
      expect(screen.queryByText('Sign in to view backend status')).not.toBeInTheDocument();
      
      const statusSection = screen.getByRole('status');
      expect(statusSection).toHaveClass('bg-blue-50', 'dark:bg-blue-900/20');
    });

    it('should show error message for authenticated user with backend error', () => {
      // Use default authenticated state from beforeEach
      mockUseBackendStatus.mockReturnValue(mockStatusStates.error);

      render(<StatusDisplay />);

      expect(screen.getByText('🚀 Frontend Status: Ready • Backend: Connection failed')).toBeInTheDocument();
      expect(screen.getByText('Check that the backend server is running and accessible')).toBeInTheDocument();
      expect(screen.queryByText('Sign in to view backend status')).not.toBeInTheDocument();
      
      const errorAlert = screen.getByRole('alert');
      expect(errorAlert).toBeInTheDocument();
    });

    it('should not show error alert when not authenticated', () => {
      // Mock unauthenticated state
      mockUseAuth.mockReturnValue({
        isFullyAuthenticated: false,
        session: null,
        isLoading: false,
        isAuthenticated: false,
        hasValidBackendToken: false,
        user: null,
        backendUser: null,
        userDomain: null,
        displayName: null,
        avatarUrl: null,
        isAdmin: false
      } as any);
      
      // Even with an error, should not show error alert when not authenticated
      mockUseBackendStatus.mockReturnValue(mockStatusStates.error);

      render(<StatusDisplay />);

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByText('Sign in to view backend status')).toBeInTheDocument();
    });
  });
});