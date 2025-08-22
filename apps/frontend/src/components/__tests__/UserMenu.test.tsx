import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { UserMenu } from '../UserMenu';

// Mock next-auth/react
vi.mock('next-auth/react', () => ({
  signIn: vi.fn(),
  signOut: vi.fn()
}));

// Mock Next.js components
vi.mock('next/image', () => ({
  default: ({ onError, alt, src, width, height, className, style, ...props }: any) => {
    // Filter out Next.js specific props that shouldn't go to DOM
    const { priority, unoptimized, blurDataURL, placeholder, loader, quality, fill, sizes, ...domProps } = props;
    return (
      <img 
        src={src}
        alt={alt}
        width={width}
        height={height}
        className={className}
        style={style}
        onError={onError}
        {...domProps}
      data-testid="profile-image"
    />
    );
  }
}));

vi.mock('next/link', () => ({
  default: ({ children, href, onClick, ...props }: any) => (
    <a href={href} onClick={onClick} {...props}>
      {children}
    </a>
  )
}));

// Mock custom hooks
vi.mock('@/hooks/useAuth');
vi.mock('@/hooks/useUI');

// Mock validation utilities
vi.mock('@/lib/validation', () => ({
  sanitizeImageURL: vi.fn()
}));

// Import mocked functions
import { signIn, signOut } from 'next-auth/react';
import { useAuth } from '@/hooks/useAuth';
import { useDropdown } from '@/hooks/useUI';
import { sanitizeImageURL } from '@/lib/validation';

// Type the mocked functions
const mockSignIn = signIn as vi.MockedFunction<typeof signIn>;
const mockSignOut = signOut as vi.MockedFunction<typeof signOut>;
const mockUseAuth = useAuth as vi.MockedFunction<typeof useAuth>;
const mockUseDropdown = useDropdown as vi.MockedFunction<typeof useDropdown>;
const mockSanitizeImageURL = sanitizeImageURL as vi.MockedFunction<typeof sanitizeImageURL>;

// Test data fixtures
const mockAuthStates = {
  loading: {
    isLoading: true,
    isAuthenticated: false,
    displayName: '',
    avatarUrl: null,
    userDomain: '',
    isAdmin: false
  },
  unauthenticated: {
    isLoading: false,
    isAuthenticated: false,
    displayName: '',
    avatarUrl: null,
    userDomain: '',
    isAdmin: false
  },
  authenticatedUser: {
    isLoading: false,
    isAuthenticated: true,
    displayName: 'John Doe',
    avatarUrl: 'https://example.com/avatar.jpg',
    userDomain: 'company.com',
    isAdmin: false
  },
  authenticatedAdmin: {
    isLoading: false,
    isAuthenticated: true,
    displayName: 'Admin User',
    avatarUrl: 'https://example.com/admin.jpg',
    userDomain: 'company.com',
    isAdmin: true
  },
  userWithoutAvatar: {
    isLoading: false,
    isAuthenticated: true,
    displayName: 'Jane Smith',
    avatarUrl: null,
    userDomain: 'example.org',
    isAdmin: false
  },
  userWithoutDomain: {
    isLoading: false,
    isAuthenticated: true,
    displayName: 'Bob Wilson',
    avatarUrl: 'https://example.com/bob.jpg',
    userDomain: '',
    isAdmin: false
  }
};

const mockDropdownStates = {
  closed: {
    isOpen: false,
    toggle: vi.fn(),
    close: vi.fn(),
    open: vi.fn(),
    dropdownRef: { current: null }
  },
  open: {
    isOpen: true,
    toggle: vi.fn(),
    close: vi.fn(),
    open: vi.fn(),
    dropdownRef: { current: document.createElement('div') }
  }
};

describe('UserMenu Component', () => {
  let consoleWarnSpy: vi.SpyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  describe('Authentication States', () => {
    it('should show loading state when authentication is loading', () => {
      mockUseAuth.mockReturnValue(mockAuthStates.loading);
      mockUseDropdown.mockReturnValue(mockDropdownStates.closed);

      render(<UserMenu />);

      expect(screen.getByText('Loading...')).toBeInTheDocument();
      expect(screen.getByText('Loading...')).toHaveClass('text-gray-500', 'animate-pulse');
    });

    it('should show sign in and sign up buttons when unauthenticated', () => {
      mockUseAuth.mockReturnValue(mockAuthStates.unauthenticated);
      mockUseDropdown.mockReturnValue(mockDropdownStates.closed);

      render(<UserMenu />);

      const signUpLink = screen.getByText('Sign Up');
      const signInButton = screen.getByText('Sign In');

      expect(signUpLink).toBeInTheDocument();
      expect(signUpLink).toHaveAttribute('href', '/auth/signup');
      expect(signInButton).toBeInTheDocument();
      expect(signInButton).toHaveAttribute('aria-label', 'Sign in to your account');
    });

    it('should call signIn when sign in button is clicked', async () => {
      mockUseAuth.mockReturnValue(mockAuthStates.unauthenticated);
      mockUseDropdown.mockReturnValue(mockDropdownStates.closed);

      render(<UserMenu />);
      
      const signInButton = screen.getByText('Sign In');
      await userEvent.click(signInButton);

      expect(mockSignIn).toHaveBeenCalledOnce();
    });

    it('should show profile button when authenticated', () => {
      mockUseAuth.mockReturnValue(mockAuthStates.authenticatedUser);
      mockUseDropdown.mockReturnValue(mockDropdownStates.closed);
      mockSanitizeImageURL.mockReturnValue('https://example.com/avatar.jpg');

      render(<UserMenu />);

      const profileButton = screen.getByRole('button', { name: /user menu for john doe/i });
      expect(profileButton).toBeInTheDocument();
      expect(profileButton).toHaveAttribute('aria-expanded', 'false');
      expect(profileButton).toHaveAttribute('aria-haspopup', 'true');
    });

    it('should have proper accessibility attributes for profile button', () => {
      mockUseAuth.mockReturnValue(mockAuthStates.authenticatedUser);
      mockUseDropdown.mockReturnValue(mockDropdownStates.closed);
      mockSanitizeImageURL.mockReturnValue('https://example.com/avatar.jpg');

      render(<UserMenu />);

      const profileButton = screen.getByRole('button');
      expect(profileButton).toHaveAttribute('id', 'user-menu-button');
      expect(profileButton).toHaveAttribute('aria-label', 'User menu for John Doe');
      expect(profileButton).toHaveAttribute('aria-expanded', 'false');
      expect(profileButton).toHaveAttribute('aria-haspopup', 'true');
    });

    it('should handle user without display name gracefully', () => {
      mockUseAuth.mockReturnValue({
        ...mockAuthStates.authenticatedUser,
        displayName: ''
      });
      mockUseDropdown.mockReturnValue(mockDropdownStates.closed);
      mockSanitizeImageURL.mockReturnValue('https://example.com/avatar.jpg');

      render(<UserMenu />);

      const profileButton = screen.getByRole('button');
      expect(profileButton).toHaveAttribute('aria-label', 'User menu for user');
    });
  });

  describe('Profile Image Handling', () => {
    it('should use sanitized image URL when valid', () => {
      mockUseAuth.mockReturnValue(mockAuthStates.authenticatedUser);
      mockUseDropdown.mockReturnValue(mockDropdownStates.closed);
      mockSanitizeImageURL.mockReturnValue('https://sanitized.example.com/avatar.jpg');

      render(<UserMenu />);

      const profileImage = screen.getByTestId('profile-image');
      expect(mockSanitizeImageURL).toHaveBeenCalledWith('https://example.com/avatar.jpg');
      expect(profileImage).toHaveAttribute('src', 'https://sanitized.example.com/avatar.jpg');
      expect(profileImage).toHaveAttribute('alt', 'John Doe profile');
    });

    it('should use fallback avatar when no avatar URL provided', () => {
      mockUseAuth.mockReturnValue(mockAuthStates.userWithoutAvatar);
      mockUseDropdown.mockReturnValue(mockDropdownStates.closed);

      render(<UserMenu />);

      const profileImage = screen.getByTestId('profile-image');
      expect(profileImage.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);
      expect(mockSanitizeImageURL).not.toHaveBeenCalled();
    });

    it('should use fallback avatar when sanitization fails', () => {
      mockUseAuth.mockReturnValue(mockAuthStates.authenticatedUser);
      mockUseDropdown.mockReturnValue(mockDropdownStates.closed);
      mockSanitizeImageURL.mockReturnValue(null);

      render(<UserMenu />);

      const profileImage = screen.getByTestId('profile-image');
      expect(profileImage.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);
      expect(consoleWarnSpy).toHaveBeenCalledWith('Invalid profile image URL detected, using fallback');
    });

    it('should handle image load error and switch to fallback', async () => {
      mockUseAuth.mockReturnValue(mockAuthStates.authenticatedUser);
      mockUseDropdown.mockReturnValue(mockDropdownStates.closed);
      mockSanitizeImageURL.mockReturnValue('https://example.com/avatar.jpg');

      render(<UserMenu />);

      const profileImage = screen.getByTestId('profile-image');
      
      // Initially shows the sanitized URL
      expect(profileImage).toHaveAttribute('src', 'https://example.com/avatar.jpg');

      // Simulate image load error
      fireEvent.error(profileImage);

      // Should switch to fallback avatar
      await waitFor(() => {
        expect(profileImage.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);
      });
    });

    it('should reset image error state when avatar URL changes', () => {
      const { rerender } = render(<UserMenu />);
      
      // Initial state with error
      mockUseAuth.mockReturnValue(mockAuthStates.authenticatedUser);
      mockUseDropdown.mockReturnValue(mockDropdownStates.closed);
      mockSanitizeImageURL.mockReturnValue('https://example.com/avatar.jpg');
      
      rerender(<UserMenu />);
      
      const profileImage = screen.getByTestId('profile-image');
      fireEvent.error(profileImage);

      // Change avatar URL
      mockUseAuth.mockReturnValue({
        ...mockAuthStates.authenticatedUser,
        avatarUrl: 'https://example.com/new-avatar.jpg'
      });
      mockSanitizeImageURL.mockReturnValue('https://example.com/new-avatar.jpg');
      
      rerender(<UserMenu />);

      // Should use new avatar URL (error state reset)
      expect(profileImage).toHaveAttribute('src', 'https://example.com/new-avatar.jpg');
    });

    it('should have proper image optimization attributes', () => {
      mockUseAuth.mockReturnValue(mockAuthStates.authenticatedUser);
      mockUseDropdown.mockReturnValue(mockDropdownStates.closed);
      mockSanitizeImageURL.mockReturnValue('https://example.com/avatar.jpg');

      render(<UserMenu />);

      const profileImage = screen.getByTestId('profile-image');
      // Only check for standard HTML attributes that pass through the mock
      expect(profileImage).toHaveAttribute('width', '32');
      expect(profileImage).toHaveAttribute('height', '32');
      // Next.js specific props like sizes and quality are filtered by our mock
    });
  });

  describe('Dropdown Functionality', () => {
    it('should toggle dropdown when profile button is clicked', async () => {
      mockUseAuth.mockReturnValue(mockAuthStates.authenticatedUser);
      mockUseDropdown.mockReturnValue(mockDropdownStates.closed);
      mockSanitizeImageURL.mockReturnValue('https://example.com/avatar.jpg');

      render(<UserMenu />);

      const profileButton = screen.getByRole('button');
      await userEvent.click(profileButton);

      expect(mockDropdownStates.closed.toggle).toHaveBeenCalledOnce();
    });

    it('should show dropdown menu when open', () => {
      mockUseAuth.mockReturnValue(mockAuthStates.authenticatedUser);
      mockUseDropdown.mockReturnValue(mockDropdownStates.open);
      mockSanitizeImageURL.mockReturnValue('https://example.com/avatar.jpg');

      render(<UserMenu />);

      const dropdown = screen.getByRole('menu');
      expect(dropdown).toBeInTheDocument();
      expect(dropdown).toHaveAttribute('aria-orientation', 'vertical');
      expect(dropdown).toHaveAttribute('aria-labelledby', 'user-menu-button');
    });

    it('should display user information in dropdown', () => {
      mockUseAuth.mockReturnValue(mockAuthStates.authenticatedUser);
      mockUseDropdown.mockReturnValue(mockDropdownStates.open);

      render(<UserMenu />);

      expect(screen.getByText('John Doe')).toBeInTheDocument();
      expect(screen.getByText('@company.com')).toBeInTheDocument();
    });

    it('should handle missing user domain gracefully', () => {
      mockUseAuth.mockReturnValue(mockAuthStates.userWithoutDomain);
      mockUseDropdown.mockReturnValue(mockDropdownStates.open);

      render(<UserMenu />);

      expect(screen.getByText('Bob Wilson')).toBeInTheDocument();
      expect(screen.queryByText(/@/)).not.toBeInTheDocument();
    });

    it('should show admin dashboard link for admin users', () => {
      mockUseAuth.mockReturnValue(mockAuthStates.authenticatedAdmin);
      mockUseDropdown.mockReturnValue(mockDropdownStates.open);

      render(<UserMenu />);

      const adminLink = screen.getByText('Admin Dashboard');
      expect(adminLink).toBeInTheDocument();
      expect(adminLink).toHaveAttribute('href', '/admin');
      expect(adminLink).toHaveAttribute('role', 'menuitem');
      expect(adminLink).toHaveAttribute('aria-label', 'Access admin dashboard');
    });

    it('should hide admin dashboard link for non-admin users', () => {
      mockUseAuth.mockReturnValue(mockAuthStates.authenticatedUser);
      mockUseDropdown.mockReturnValue(mockDropdownStates.open);

      render(<UserMenu />);

      expect(screen.queryByText('Admin Dashboard')).not.toBeInTheDocument();
    });

    it('should close dropdown when admin link is clicked', async () => {
      mockUseAuth.mockReturnValue(mockAuthStates.authenticatedAdmin);
      mockUseDropdown.mockReturnValue(mockDropdownStates.open);

      render(<UserMenu />);

      const adminLink = screen.getByText('Admin Dashboard');
      await userEvent.click(adminLink);

      expect(mockDropdownStates.open.close).toHaveBeenCalledOnce();
    });

    it('should show sign out button with proper attributes', () => {
      mockUseAuth.mockReturnValue(mockAuthStates.authenticatedUser);
      mockUseDropdown.mockReturnValue(mockDropdownStates.open);

      render(<UserMenu />);

      const signOutButton = screen.getByText('Sign Out');
      expect(signOutButton).toBeInTheDocument();
      expect(signOutButton).toHaveAttribute('role', 'menuitem');
      expect(signOutButton).toHaveAttribute('aria-label', 'Sign out of your account');
      expect(signOutButton).toHaveAttribute('tabIndex', '0');
    });
  });

  describe('Keyboard Navigation', () => {
    it('should handle Enter key to activate sign out', async () => {
      mockUseAuth.mockReturnValue(mockAuthStates.authenticatedUser);
      mockUseDropdown.mockReturnValue(mockDropdownStates.open);

      render(<UserMenu />);

      const profileButton = screen.getByRole('button', { name: /user menu/i });
      await userEvent.type(profileButton, '{Enter}');

      expect(mockSignOut).toHaveBeenCalledOnce();
      expect(mockDropdownStates.open.close).toHaveBeenCalledOnce();
    });

    it('should handle Space key to activate sign out', async () => {
      mockUseAuth.mockReturnValue(mockAuthStates.authenticatedUser);
      mockUseDropdown.mockReturnValue(mockDropdownStates.open);

      render(<UserMenu />);

      const profileButton = screen.getByRole('button', { name: /user menu/i });
      fireEvent.keyDown(profileButton, { key: ' ' });

      expect(mockSignOut).toHaveBeenCalledOnce();
      expect(mockDropdownStates.open.close).toHaveBeenCalledOnce();
    });

    it('should handle Escape key to close dropdown', async () => {
      mockUseAuth.mockReturnValue(mockAuthStates.authenticatedUser);
      mockUseDropdown.mockReturnValue(mockDropdownStates.open);

      render(<UserMenu />);

      const profileButton = screen.getByRole('button', { name: /user menu/i });
      fireEvent.keyDown(profileButton, { key: 'Escape' });

      expect(mockDropdownStates.open.close).toHaveBeenCalledOnce();
    });

    it('should handle Shift+Tab to close dropdown', async () => {
      mockUseAuth.mockReturnValue(mockAuthStates.authenticatedUser);
      mockUseDropdown.mockReturnValue(mockDropdownStates.open);

      render(<UserMenu />);

      const profileButton = screen.getByRole('button', { name: /user menu/i });
      fireEvent.keyDown(profileButton, { key: 'Tab', shiftKey: true });

      expect(mockDropdownStates.open.close).toHaveBeenCalledOnce();
    });

    it('should not handle keyboard events when dropdown is closed', async () => {
      mockUseAuth.mockReturnValue(mockAuthStates.authenticatedUser);
      mockUseDropdown.mockReturnValue(mockDropdownStates.closed);

      render(<UserMenu />);

      const profileButton = screen.getByRole('button', { name: /user menu/i });
      fireEvent.keyDown(profileButton, { key: 'Enter' });

      expect(mockSignOut).not.toHaveBeenCalled();
      expect(mockDropdownStates.closed.close).not.toHaveBeenCalled();
    });

    it('should handle sign out button keyboard events', async () => {
      mockUseAuth.mockReturnValue(mockAuthStates.authenticatedUser);
      mockUseDropdown.mockReturnValue(mockDropdownStates.open);

      render(<UserMenu />);

      const signOutButton = screen.getByText('Sign Out');
      fireEvent.keyDown(signOutButton, { key: 'Enter' });

      expect(mockSignOut).toHaveBeenCalledOnce();
      expect(mockDropdownStates.open.close).toHaveBeenCalledOnce();
    });
  });

  describe('User Actions', () => {
    it('should call signOut and close dropdown when sign out button is clicked', async () => {
      mockUseAuth.mockReturnValue(mockAuthStates.authenticatedUser);
      mockUseDropdown.mockReturnValue(mockDropdownStates.open);

      render(<UserMenu />);

      const signOutButton = screen.getByText('Sign Out');
      await userEvent.click(signOutButton);

      expect(mockDropdownStates.open.close).toHaveBeenCalledOnce();
      expect(mockSignOut).toHaveBeenCalledOnce();
    });

    it('should have proper button styling and classes', () => {
      mockUseAuth.mockReturnValue(mockAuthStates.unauthenticated);
      mockUseDropdown.mockReturnValue(mockDropdownStates.closed);

      render(<UserMenu />);

      const signInButton = screen.getByText('Sign In');
      expect(signInButton).toHaveClass(
        'text-sm',
        'text-blue-600',
        'hover:text-blue-800',
        'dark:text-blue-400',
        'dark:hover:text-blue-300',
        'transition-colors'
      );

      const signUpLink = screen.getByText('Sign Up');
      expect(signUpLink).toHaveClass(
        'text-sm',
        'text-green-600',
        'hover:text-green-800',
        'dark:text-green-400',
        'dark:hover:text-green-300',
        'transition-colors'
      );
    });
  });

  describe('Accessibility & User Experience', () => {
    it('should have proper ARIA roles and attributes', () => {
      mockUseAuth.mockReturnValue(mockAuthStates.authenticatedUser);
      mockUseDropdown.mockReturnValue(mockDropdownStates.open);

      render(<UserMenu />);

      const dropdown = screen.getByRole('menu');
      expect(dropdown).toHaveAttribute('role', 'menu');
      expect(dropdown).toHaveAttribute('aria-orientation', 'vertical');
      expect(dropdown).toHaveAttribute('aria-labelledby', 'user-menu-button');

      const signOutButton = screen.getByText('Sign Out');
      expect(signOutButton).toHaveAttribute('role', 'menuitem');
      expect(signOutButton).toHaveAttribute('tabIndex', '0');
    });

    it('should have proper focus management classes', () => {
      mockUseAuth.mockReturnValue(mockAuthStates.authenticatedUser);
      mockUseDropdown.mockReturnValue(mockDropdownStates.closed);
      mockSanitizeImageURL.mockReturnValue('https://example.com/avatar.jpg');

      render(<UserMenu />);

      const profileButton = screen.getByRole('button');
      expect(profileButton).toHaveClass(
        'focus:outline-none',
        'focus:ring-2',
        'focus:ring-blue-500',
        'focus:ring-offset-2'
      );
    });

    it('should have proper responsive styling', () => {
      mockUseAuth.mockReturnValue(mockAuthStates.authenticatedUser);
      mockUseDropdown.mockReturnValue(mockDropdownStates.open);

      render(<UserMenu />);

      const dropdown = screen.getByRole('menu');
      expect(dropdown).toHaveClass(
        'absolute',
        'right-0',
        'mt-2',
        'w-64',
        'bg-white',
        'dark:bg-gray-800',
        'rounded-lg',
        'shadow-lg',
        'border',
        'border-gray-200',
        'dark:border-gray-700',
        'z-50'
      );
    });

    it('should handle text truncation for long names', () => {
      mockUseAuth.mockReturnValue({
        ...mockAuthStates.authenticatedUser,
        displayName: 'Very Long User Name That Should Be Truncated',
        userDomain: 'very-long-domain-name-that-should-also-be-truncated.com'
      });
      mockUseDropdown.mockReturnValue(mockDropdownStates.open);

      render(<UserMenu />);

      const nameElement = screen.getByText('Very Long User Name That Should Be Truncated');
      const domainElement = screen.getByText('@very-long-domain-name-that-should-also-be-truncated.com');
      
      expect(nameElement).toHaveClass('truncate');
      expect(domainElement).toHaveClass('truncate');
    });

    it('should maintain dropdown position and z-index', () => {
      mockUseAuth.mockReturnValue(mockAuthStates.authenticatedUser);
      mockUseDropdown.mockReturnValue(mockDropdownStates.open);

      render(<UserMenu />);

      const dropdown = screen.getByRole('menu');
      expect(dropdown).toHaveClass('absolute', 'right-0', 'z-50');
    });
  });

  describe('Edge Cases', () => {
    it('should handle all auth states transitions', () => {
      const { rerender } = render(<UserMenu />);

      // Loading state
      mockUseAuth.mockReturnValue(mockAuthStates.loading);
      mockUseDropdown.mockReturnValue(mockDropdownStates.closed);
      rerender(<UserMenu />);
      expect(screen.getByText('Loading...')).toBeInTheDocument();

      // Unauthenticated state
      mockUseAuth.mockReturnValue(mockAuthStates.unauthenticated);
      rerender(<UserMenu />);
      expect(screen.getByText('Sign In')).toBeInTheDocument();

      // Authenticated state
      mockUseAuth.mockReturnValue(mockAuthStates.authenticatedUser);
      mockSanitizeImageURL.mockReturnValue('https://example.com/avatar.jpg');
      rerender(<UserMenu />);
      expect(screen.getByRole('button', { name: /user menu/i })).toBeInTheDocument();
    });

    it('should handle missing displayName with fallback', () => {
      mockUseAuth.mockReturnValue({
        ...mockAuthStates.authenticatedUser,
        displayName: null
      });
      mockUseDropdown.mockReturnValue(mockDropdownStates.open);

      render(<UserMenu />);

      // Should still render the user info section even with null displayName
      const userInfoSection = screen.getByRole('menu');
      expect(userInfoSection).toBeInTheDocument();
    });

    it('should prevent default behavior on keyboard events', () => {
      mockUseAuth.mockReturnValue(mockAuthStates.authenticatedUser);
      mockUseDropdown.mockReturnValue(mockDropdownStates.open);

      render(<UserMenu />);

      const profileButton = screen.getByRole('button', { name: /user menu/i });
      
      const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
      const preventDefaultSpy = vi.spyOn(enterEvent, 'preventDefault');
      
      fireEvent(profileButton, enterEvent);
      
      expect(preventDefaultSpy).toHaveBeenCalled();
      preventDefaultSpy.mockRestore();
    });
  });
});