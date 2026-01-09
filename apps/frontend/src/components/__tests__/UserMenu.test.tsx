import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock, MockedFunction } from 'vitest'
import type { Session } from 'next-auth';
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

// Mock react-ui hooks
vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual('@semiont/react-ui');
  return {
    ...actual,
    useAuth: vi.fn(),
    useDropdown: vi.fn(),
    sanitizeImageURL: vi.fn(),
    UserMenuSkeleton: () => (
      <div data-testid="user-menu-skeleton" role="status" aria-label="Loading user menu" className="animate-pulse">
        Loading...
      </div>
    )
  };
});

// Import mocked functions
import { signIn, signOut } from 'next-auth/react';
import { useDropdown, sanitizeImageURL } from '@semiont/react-ui';
import { useAuth } from '@/hooks/useAuth';

// Type the mocked functions
const mockSignIn = signIn as MockedFunction<typeof signIn>;
const mockSignOut = signOut as MockedFunction<typeof signOut>;
const mockUseAuth = useAuth as MockedFunction<typeof useAuth>;
const mockUseDropdown = useDropdown as MockedFunction<typeof useDropdown>;
const mockSanitizeImageURL = sanitizeImageURL as MockedFunction<typeof sanitizeImageURL>;

// Test data fixtures
const mockAuthStates = {
  loading: {
    session: null,
    user: undefined,
    backendUser: undefined,
    isLoading: true,
    isAuthenticated: false,
    hasValidBackendToken: false,
    userDomain: undefined,
    displayName: '',
    avatarUrl: undefined,
    isAdmin: false,
    isModerator: false,
    isFullyAuthenticated: false
  },
  unauthenticated: {
    session: null,
    user: undefined,
    backendUser: undefined,
    isLoading: false,
    isAuthenticated: false,
    hasValidBackendToken: false,
    userDomain: undefined,
    displayName: '',
    avatarUrl: undefined,
    isAdmin: false,
    isModerator: false,
    isFullyAuthenticated: false
  },
  authenticatedUser: {
    session: {
      user: {
        name: 'John Doe',
        email: 'john@company.com',
        image: 'https://example.com/avatar.jpg'
      },
      backendUser: {
        id: '1',
        email: 'john@company.com',
        name: 'John Doe',
        domain: 'company.com',
        isAdmin: false,
        isModerator: false,
        termsAcceptedAt: null
      },
      backendToken: 'valid-token',
      expires: '2024-01-01'
    },
    user: {
      name: 'John Doe',
      email: 'john@company.com',
      image: 'https://example.com/avatar.jpg'
    },
    backendUser: {
      id: '1',
      email: 'john@company.com',
      name: 'John Doe',
      domain: 'company.com',
      isAdmin: false,
      isModerator: false,
      termsAcceptedAt: null
    },
    isLoading: false,
    isAuthenticated: true,
    hasValidBackendToken: true,
    userDomain: 'company.com',
    displayName: 'John Doe',
    avatarUrl: 'https://example.com/avatar.jpg',
    isAdmin: false,
    isModerator: false,
    isFullyAuthenticated: true
  },
  authenticatedAdmin: {
    session: {
      user: {
        name: 'Admin User',
        email: 'admin@company.com',
        image: 'https://example.com/admin.jpg'
      },
      backendUser: {
        id: '2',
        email: 'admin@company.com',
        name: 'Admin User',
        domain: 'company.com',
        isAdmin: true,
        isModerator: false,
        termsAcceptedAt: null
      },
      backendToken: 'valid-token',
      expires: '2024-01-01'
    },
    user: {
      name: 'Admin User',
      email: 'admin@company.com',
      image: 'https://example.com/admin.jpg'
    },
    backendUser: {
      id: '2',
      email: 'admin@company.com',
      name: 'Admin User',
      domain: 'company.com',
      isAdmin: true,
      isModerator: false,
      termsAcceptedAt: null
    },
    isLoading: false,
    isAuthenticated: true,
    hasValidBackendToken: true,
    userDomain: 'company.com',
    displayName: 'Admin User',
    avatarUrl: 'https://example.com/admin.jpg',
    isAdmin: true,
    isModerator: false,
    isFullyAuthenticated: true
  },
  userWithoutAvatar: {
    session: {
      user: {
        name: 'Jane Smith',
        email: 'jane@example.org',
        image: null
      },
      backendUser: {
        id: '3',
        email: 'jane@example.org',
        name: 'Jane Smith',
        domain: 'example.org',
        isAdmin: false,
        isModerator: false,
        termsAcceptedAt: null
      },
      backendToken: 'valid-token',
      expires: '2024-01-01'
    },
    user: {
      name: 'Jane Smith',
      email: 'jane@example.org',
      image: null
    },
    backendUser: {
      id: '3',
      email: 'jane@example.org',
      name: 'Jane Smith',
      domain: 'example.org',
      isAdmin: false,
      isModerator: false,
      termsAcceptedAt: null
    },
    isLoading: false,
    isAuthenticated: true,
    hasValidBackendToken: true,
    userDomain: 'example.org',
    displayName: 'Jane Smith',
    avatarUrl: null,
    isAdmin: false,
    isModerator: false,
    isFullyAuthenticated: true
  },
  userWithoutDomain: {
    session: {
      user: {
        name: 'Bob Wilson',
        email: 'bob@email.com',
        image: 'https://example.com/bob.jpg'
      },
      expires: '2024-01-01'
    } as any as Session,
    user: {
      name: 'Bob Wilson',
      email: 'bob@email.com',
      image: 'https://example.com/bob.jpg'
    },
    backendUser: undefined,
    isLoading: false,
    isAuthenticated: true,
    hasValidBackendToken: false,
    userDomain: undefined,
    displayName: 'Bob Wilson',
    avatarUrl: 'https://example.com/bob.jpg',
    isAdmin: false,
    isModerator: false,
    isFullyAuthenticated: false
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
  let consoleWarnSpy: any;

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

      // Check for loading skeleton instead of text
      const loadingSkeleton = screen.getByRole('status', { name: 'Loading user menu' });
      expect(loadingSkeleton).toBeInTheDocument();
      expect(loadingSkeleton).toHaveClass('animate-pulse');
    });

    it('should not show anything when unauthenticated', () => {
      mockUseAuth.mockReturnValue(mockAuthStates.unauthenticated);
      mockUseDropdown.mockReturnValue(mockDropdownStates.closed);

      const { container } = render(<UserMenu />);

      // UserMenu returns null when not authenticated
      expect(container.firstChild).toBeNull();
    });

    it('should not render sign in button when unauthenticated', () => {
      mockUseAuth.mockReturnValue(mockAuthStates.unauthenticated);
      mockUseDropdown.mockReturnValue(mockDropdownStates.closed);

      const { container } = render(<UserMenu />);
      
      // UserMenu returns null when not authenticated
      expect(container.firstChild).toBeNull();
      expect(screen.queryByText('Sign In')).not.toBeInTheDocument();
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

    it('should show admin dashboard link for admin users', () => {
      mockUseAuth.mockReturnValue(mockAuthStates.authenticatedAdmin);
      mockUseDropdown.mockReturnValue(mockDropdownStates.open);

      render(<UserMenu />);

      const adminLink = screen.getByText('Administer');
      expect(adminLink).toBeInTheDocument();
      expect(adminLink).toHaveAttribute('href', '/admin');
      expect(adminLink).toHaveAttribute('role', 'menuitem');
      expect(adminLink).toHaveAttribute('aria-label', 'Access admin dashboard');
    });

    it('should hide admin dashboard link for non-admin users', () => {
      mockUseAuth.mockReturnValue(mockAuthStates.authenticatedUser);
      mockUseDropdown.mockReturnValue(mockDropdownStates.open);

      render(<UserMenu />);

      expect(screen.queryByText('Administer')).not.toBeInTheDocument();
    });

    it('should close dropdown when admin link is clicked', async () => {
      mockUseAuth.mockReturnValue(mockAuthStates.authenticatedAdmin);
      mockUseDropdown.mockReturnValue(mockDropdownStates.open);

      render(<UserMenu />);

      const adminLink = screen.getByText('Administer');
      await userEvent.click(adminLink);

      expect(mockDropdownStates.open.close).toHaveBeenCalledOnce();
    });
  });

  describe('Keyboard Navigation', () => {
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
  });

  describe('User Actions', () => {
    it('should have proper button styling and classes when authenticated', () => {
      mockUseAuth.mockReturnValue(mockAuthStates.authenticatedUser);
      mockUseDropdown.mockReturnValue(mockDropdownStates.closed);

      render(<UserMenu />);

      const profileButton = screen.getByRole('button', { name: /user menu/i });
      expect(profileButton).toHaveClass(
        'w-8',
        'h-8',
        'rounded-full'
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
      expect(screen.getByRole('status', { name: 'Loading user menu' })).toBeInTheDocument();

      // Unauthenticated state - component returns null
      mockUseAuth.mockReturnValue(mockAuthStates.unauthenticated);
      rerender(<UserMenu />);
      expect(screen.queryByText('Sign In')).not.toBeInTheDocument();

      // Authenticated state
      mockUseAuth.mockReturnValue(mockAuthStates.authenticatedUser);
      mockSanitizeImageURL.mockReturnValue('https://example.com/avatar.jpg');
      rerender(<UserMenu />);
      expect(screen.getByRole('button', { name: /user menu/i })).toBeInTheDocument();
    });

    it('should handle missing displayName with fallback', () => {
      mockUseAuth.mockReturnValue({
        ...mockAuthStates.authenticatedUser,
        displayName: ''
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