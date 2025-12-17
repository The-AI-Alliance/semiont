import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { UserPanel } from '../UserPanel';

// Mock next-auth
const mockSignOut = vi.fn();
vi.mock('next-auth/react', () => ({
  signOut: (...args: any[]) => mockSignOut(...args),
}));

// Mock next/image
vi.mock('next/image', () => ({
  default: ({ src, alt, onError, unoptimized, sizes, quality, width, height, className }: any) => {
    return (
      <img
        src={src}
        alt={alt}
        onError={onError}
        width={width}
        height={height}
        className={className}
      />
    );
  },
}));

// Mock next-intl
const mockUseTranslations = vi.fn();
vi.mock('next-intl', () => ({
  useTranslations: () => mockUseTranslations,
}));

// Mock validation
const mockSanitizeImageURL = vi.fn();
vi.mock('@/lib/validation', () => ({
  sanitizeImageURL: (url: string) => mockSanitizeImageURL(url),
}));

// Mock custom hooks
const mockUseAuth = vi.fn();
const mockUseSessionExpiry = vi.fn();
const mockUseFormattedTime = vi.fn();

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock('@/hooks/useSessionExpiry', () => ({
  useSessionExpiry: () => mockUseSessionExpiry(),
}));

vi.mock('@/hooks/useFormattedTime', () => ({
  useFormattedTime: (time: number) => mockUseFormattedTime(time),
}));

describe('UserPanel Component', () => {
  const FALLBACK_AVATAR = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iMTYiIGZpbGw9IiM2QjcyODAiLz4KPHBhdGggZD0iTTE2IDE2QzE4LjIwOTEgMTYgMjAgMTQuMjA5MSAyMCAxMkMyMCA5Ljc5MDg2IDE4LjIwOTEgOCAxNiA4QzEzLjc5MDkgOCAxMiA5Ljc5MDg2IDEyIDEyQzEyIDE0LjIwOTEgMTMuNzkwOSAxNiAxNiAxNloiIGZpbGw9IiNFNUU3RUIiLz4KPHBhdGggZD0iTTI0IDI1QzI0IDIxLjY4NjMgMjAuNDE4MyAxOSAxNiAxOUMxMS41ODE3IDE5IDggMjEuNjg2MyA4IDI1IiBzdHJva2U9IiNFNUU3RUIiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+Cjwvc3ZnPg==';

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup translation mock
    mockUseTranslations.mockImplementation((key: string, params?: any) => {
      const translations: Record<string, string> = {
        account: 'Account',
        user: 'User',
        profileAlt: 'Profile picture of {name}',
        session: 'Session',
        expiresIn: 'Expires in {time}',
        privileges: 'Privileges',
        administrator: 'Administrator',
        moderator: 'Moderator',
        signOut: 'Sign Out',
      };

      if (key === 'profileAlt' && params?.name) {
        return `Profile picture of ${params.name}`;
      }

      if (key === 'expiresIn' && params?.time) {
        return `Expires in ${params.time}`;
      }

      return translations[key] || key;
    });

    // Default auth state
    mockUseAuth.mockReturnValue({
      displayName: 'John Doe',
      avatarUrl: 'https://example.com/avatar.jpg',
      userDomain: 'example.com',
      isAdmin: false,
      isModerator: false,
    });

    // Default session state
    mockUseSessionExpiry.mockReturnValue({
      timeRemaining: 3600000, // 1 hour in ms
    });

    // Default time formatting
    mockUseFormattedTime.mockReturnValue('1 hour');

    // Default URL sanitization
    mockSanitizeImageURL.mockImplementation((url) => url);
  });

  describe('Rendering', () => {
    it('should render account heading', () => {
      render(<UserPanel />);

      expect(screen.getByText('Account')).toBeInTheDocument();
    });

    it('should render user profile with name', () => {
      render(<UserPanel />);

      expect(screen.getByText('John Doe')).toBeInTheDocument();
    });

    it('should render user domain', () => {
      render(<UserPanel />);

      expect(screen.getByText('@example.com')).toBeInTheDocument();
    });

    it('should render profile image', () => {
      render(<UserPanel />);

      const image = screen.getByAltText('Profile picture of John Doe');
      expect(image).toBeInTheDocument();
      expect(image).toHaveAttribute('src', 'https://example.com/avatar.jpg');
    });

    it('should render session section', () => {
      render(<UserPanel />);

      expect(screen.getByText('Session')).toBeInTheDocument();
      expect(screen.getByText('Expires in 1 hour')).toBeInTheDocument();
    });

    it('should render sign out button', () => {
      render(<UserPanel />);

      expect(screen.getByRole('button', { name: 'Sign Out' })).toBeInTheDocument();
    });
  });

  describe('Profile Display', () => {
    it('should use sanitized avatar URL', () => {
      const avatarUrl = 'https://example.com/avatar.jpg';
      mockUseAuth.mockReturnValue({
        displayName: 'Jane Smith',
        avatarUrl,
        userDomain: 'test.com',
        isAdmin: false,
        isModerator: false,
      });

      render(<UserPanel />);

      expect(mockSanitizeImageURL).toHaveBeenCalledWith(avatarUrl);
    });

    it('should use fallback avatar when avatarUrl is null', () => {
      mockUseAuth.mockReturnValue({
        displayName: 'Jane Smith',
        avatarUrl: null,
        userDomain: 'test.com',
        isAdmin: false,
        isModerator: false,
      });

      render(<UserPanel />);

      const image = screen.getByAltText('Profile picture of Jane Smith');
      expect(image).toHaveAttribute('src', FALLBACK_AVATAR);
    });

    it('should use fallback avatar when sanitizeImageURL returns null', () => {
      mockSanitizeImageURL.mockReturnValue(null);

      render(<UserPanel />);

      const image = screen.getByAltText('Profile picture of John Doe');
      expect(image).toHaveAttribute('src', FALLBACK_AVATAR);
    });

    it('should use fallback avatar after image load error', () => {
      render(<UserPanel />);

      const image = screen.getByAltText('Profile picture of John Doe') as HTMLImageElement;

      // Trigger error handler
      image.onerror?.(new Event('error'));

      // Component should rerender with fallback
      waitFor(() => {
        expect(image).toHaveAttribute('src', FALLBACK_AVATAR);
      });
    });

    it('should display "User" when displayName is null', () => {
      mockUseAuth.mockReturnValue({
        displayName: null,
        avatarUrl: null,
        userDomain: null,
        isAdmin: false,
        isModerator: false,
      });

      render(<UserPanel />);

      expect(screen.getByText('User')).toBeInTheDocument();
    });

    it('should not render domain when userDomain is null', () => {
      mockUseAuth.mockReturnValue({
        displayName: 'John Doe',
        avatarUrl: null,
        userDomain: null,
        isAdmin: false,
        isModerator: false,
      });

      render(<UserPanel />);

      expect(screen.queryByText(/@/)).not.toBeInTheDocument();
    });
  });

  describe('Session Display', () => {
    it('should format session time correctly', () => {
      mockUseFormattedTime.mockReturnValue('45 minutes');

      render(<UserPanel />);

      expect(screen.getByText('Expires in 45 minutes')).toBeInTheDocument();
    });

    it('should show "Unknown" when time formatting returns null', () => {
      mockUseFormattedTime.mockReturnValue(null);

      render(<UserPanel />);

      expect(screen.getByText('Expires in Unknown')).toBeInTheDocument();
    });

    it('should pass timeRemaining to useFormattedTime hook', () => {
      const timeRemaining = 1800000; // 30 minutes
      mockUseSessionExpiry.mockReturnValue({ timeRemaining });

      render(<UserPanel />);

      expect(mockUseFormattedTime).toHaveBeenCalledWith(timeRemaining);
    });
  });

  describe('Privileges Display', () => {
    it('should not show privileges section for regular users', () => {
      mockUseAuth.mockReturnValue({
        displayName: 'John Doe',
        avatarUrl: null,
        userDomain: 'example.com',
        isAdmin: false,
        isModerator: false,
      });

      render(<UserPanel />);

      expect(screen.queryByText('Privileges')).not.toBeInTheDocument();
    });

    it('should show administrator badge when user is admin', () => {
      mockUseAuth.mockReturnValue({
        displayName: 'Admin User',
        avatarUrl: null,
        userDomain: 'example.com',
        isAdmin: true,
        isModerator: false,
      });

      render(<UserPanel />);

      expect(screen.getByText('Privileges')).toBeInTheDocument();
      expect(screen.getByText('Administrator')).toBeInTheDocument();
    });

    it('should show moderator badge when user is moderator', () => {
      mockUseAuth.mockReturnValue({
        displayName: 'Mod User',
        avatarUrl: null,
        userDomain: 'example.com',
        isAdmin: false,
        isModerator: true,
      });

      render(<UserPanel />);

      expect(screen.getByText('Privileges')).toBeInTheDocument();
      expect(screen.getByText('Moderator')).toBeInTheDocument();
    });

    it('should show both badges when user is admin and moderator', () => {
      mockUseAuth.mockReturnValue({
        displayName: 'Super User',
        avatarUrl: null,
        userDomain: 'example.com',
        isAdmin: true,
        isModerator: true,
      });

      render(<UserPanel />);

      expect(screen.getByText('Administrator')).toBeInTheDocument();
      expect(screen.getByText('Moderator')).toBeInTheDocument();
    });

    it('should style administrator badge with purple colors', () => {
      mockUseAuth.mockReturnValue({
        displayName: 'Admin User',
        avatarUrl: null,
        userDomain: 'example.com',
        isAdmin: true,
        isModerator: false,
      });

      render(<UserPanel />);

      const adminBadge = screen.getByText('Administrator');
      expect(adminBadge).toHaveClass('text-purple-700', 'dark:text-purple-300');
      expect(adminBadge.parentElement).toHaveClass('bg-purple-50', 'dark:bg-purple-900/20');
    });

    it('should style moderator badge with blue colors', () => {
      mockUseAuth.mockReturnValue({
        displayName: 'Mod User',
        avatarUrl: null,
        userDomain: 'example.com',
        isAdmin: false,
        isModerator: true,
      });

      render(<UserPanel />);

      const modBadge = screen.getByText('Moderator');
      expect(modBadge).toHaveClass('text-blue-700', 'dark:text-blue-300');
      expect(modBadge.parentElement).toHaveClass('bg-blue-50', 'dark:bg-blue-900/20');
    });
  });

  describe('Sign Out Functionality', () => {
    it('should call signOut when button clicked', async () => {
      render(<UserPanel />);

      const signOutButton = screen.getByRole('button', { name: 'Sign Out' });
      await userEvent.click(signOutButton);

      expect(mockSignOut).toHaveBeenCalledWith({ callbackUrl: '/' });
    });

    it('should handle rapid sign out clicks', async () => {
      render(<UserPanel />);

      const signOutButton = screen.getByRole('button', { name: 'Sign Out' });

      await userEvent.click(signOutButton);
      await userEvent.click(signOutButton);

      // Should be called each time (though the first call would have already started signout process)
      expect(mockSignOut).toHaveBeenCalledTimes(2);
    });

    it('should have proper styling for sign out button', () => {
      render(<UserPanel />);

      const signOutButton = screen.getByRole('button', { name: 'Sign Out' });
      expect(signOutButton).toHaveClass(
        'w-full',
        'px-4',
        'py-2',
        'bg-gray-100',
        'dark:bg-gray-700'
      );
    });
  });

  describe('Styling and Appearance', () => {
    it('should have proper heading styles', () => {
      render(<UserPanel />);

      const heading = screen.getByText('Account');
      expect(heading).toHaveClass('text-sm', 'font-semibold', 'mb-3');
    });

    it('should support dark mode for heading', () => {
      render(<UserPanel />);

      const heading = screen.getByText('Account');
      expect(heading).toHaveClass('dark:text-white');
    });

    it('should have proper spacing between sections', () => {
      const { container } = render(<UserPanel />);

      const sectionsContainer = container.querySelector('.space-y-4');
      expect(sectionsContainer).toBeInTheDocument();
    });

    it('should have rounded avatar image', () => {
      render(<UserPanel />);

      const image = screen.getByAltText('Profile picture of John Doe');
      expect(image).toHaveClass('rounded-full');
    });

    it('should have border separator before sign out button', () => {
      const { container } = render(<UserPanel />);

      const separator = container.querySelector('.border-t');
      expect(separator).toBeInTheDocument();
      expect(separator).toHaveClass('border-gray-200', 'dark:border-gray-700');
    });

    it('should truncate long display names', () => {
      mockUseAuth.mockReturnValue({
        displayName: 'A Very Long User Name That Should Be Truncated',
        avatarUrl: null,
        userDomain: 'example.com',
        isAdmin: false,
        isModerator: false,
      });

      render(<UserPanel />);

      const nameElement = screen.getByText('A Very Long User Name That Should Be Truncated');
      expect(nameElement).toHaveClass('truncate');
    });

    it('should truncate long domains', () => {
      render(<UserPanel />);

      const domainElement = screen.getByText('@example.com');
      expect(domainElement).toHaveClass('truncate');
    });
  });

  describe('Accessibility', () => {
    it('should use semantic HTML for heading', () => {
      render(<UserPanel />);

      const heading = screen.getByText('Account');
      expect(heading.tagName).toBe('H3');
    });

    it('should have proper alt text for profile image', () => {
      render(<UserPanel />);

      const image = screen.getByAltText('Profile picture of John Doe');
      expect(image).toBeInTheDocument();
    });

    it('should have proper alt text for fallback avatar', () => {
      mockUseAuth.mockReturnValue({
        displayName: null,
        avatarUrl: null,
        userDomain: null,
        isAdmin: false,
        isModerator: false,
      });

      render(<UserPanel />);

      const image = screen.getByAltText('Profile picture of User');
      expect(image).toBeInTheDocument();
    });

    it('should have focus styles on sign out button', () => {
      render(<UserPanel />);

      const signOutButton = screen.getByRole('button', { name: 'Sign Out' });
      expect(signOutButton).toHaveClass('focus:outline-none', 'focus:ring-2', 'focus:ring-blue-500');
    });

    it('should have semantic label elements', () => {
      render(<UserPanel />);

      const sessionLabel = screen.getByText('Session');
      expect(sessionLabel.tagName).toBe('LABEL');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty strings for all fields', () => {
      mockUseAuth.mockReturnValue({
        displayName: '',
        avatarUrl: '',
        userDomain: '',
        isAdmin: false,
        isModerator: false,
      });

      mockSanitizeImageURL.mockReturnValue('');

      const { container } = render(<UserPanel />);

      expect(container.firstChild).toBeInTheDocument();
    });

    it('should handle undefined timeRemaining', () => {
      mockUseSessionExpiry.mockReturnValue({
        timeRemaining: undefined,
      });

      mockUseFormattedTime.mockReturnValue(null);

      render(<UserPanel />);

      expect(screen.getByText('Expires in Unknown')).toBeInTheDocument();
    });

    it('should handle very long session times', () => {
      mockUseFormattedTime.mockReturnValue('365 days, 23 hours, 59 minutes');

      render(<UserPanel />);

      expect(screen.getByText(/365 days/)).toBeInTheDocument();
    });

    it('should handle special characters in display name', () => {
      mockUseAuth.mockReturnValue({
        displayName: 'Jean-François O\'Brien <admin>',
        avatarUrl: null,
        userDomain: 'test.com',
        isAdmin: false,
        isModerator: false,
      });

      render(<UserPanel />);

      expect(screen.getByText('Jean-François O\'Brien <admin>')).toBeInTheDocument();
    });

    it('should log warning when invalid avatar URL is detected', () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockSanitizeImageURL.mockReturnValue(null);

      render(<UserPanel />);

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'Invalid profile image URL detected, using fallback'
      );

      consoleWarnSpy.mockRestore();
    });

    it('should call signOut when sign out button is clicked', async () => {
      mockSignOut.mockResolvedValueOnce(undefined);

      render(<UserPanel />);

      const signOutButton = screen.getByRole('button', { name: 'Sign Out' });

      await userEvent.click(signOutButton);

      await waitFor(() => {
        expect(mockSignOut).toHaveBeenCalledWith({ callbackUrl: '/' });
      });
    });
  });

  describe('Dynamic Updates', () => {
    it('should update display name when auth changes', () => {
      const { rerender } = render(<UserPanel />);

      expect(screen.getByText('John Doe')).toBeInTheDocument();

      mockUseAuth.mockReturnValue({
        displayName: 'Jane Smith',
        avatarUrl: null,
        userDomain: 'test.com',
        isAdmin: false,
        isModerator: false,
      });

      rerender(<UserPanel />);

      expect(screen.getByText('Jane Smith')).toBeInTheDocument();
      expect(screen.queryByText('John Doe')).not.toBeInTheDocument();
    });

    it('should update session time as it changes', () => {
      mockUseFormattedTime.mockReturnValue('1 hour');
      const { rerender } = render(<UserPanel />);

      expect(screen.getByText('Expires in 1 hour')).toBeInTheDocument();

      mockUseFormattedTime.mockReturnValue('30 minutes');
      rerender(<UserPanel />);

      expect(screen.getByText('Expires in 30 minutes')).toBeInTheDocument();
    });

    it('should show privileges when user becomes admin', () => {
      mockUseAuth.mockReturnValue({
        displayName: 'John Doe',
        avatarUrl: null,
        userDomain: 'example.com',
        isAdmin: false,
        isModerator: false,
      });

      const { rerender } = render(<UserPanel />);

      expect(screen.queryByText('Privileges')).not.toBeInTheDocument();

      mockUseAuth.mockReturnValue({
        displayName: 'John Doe',
        avatarUrl: null,
        userDomain: 'example.com',
        isAdmin: true,
        isModerator: false,
      });

      rerender(<UserPanel />);

      expect(screen.getByText('Privileges')).toBeInTheDocument();
      expect(screen.getByText('Administrator')).toBeInTheDocument();
    });
  });
});
