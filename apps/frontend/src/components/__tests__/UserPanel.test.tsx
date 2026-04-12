import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { UserPanel } from '../UserPanel';

// Mock react-i18next (overrides global setup to allow per-test translation control)
const mockUseTranslations = vi.fn();
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockUseTranslations, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

// Mock router
const mockRouterPush = vi.fn();
vi.mock('@/i18n/routing', () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

// Mock react-ui (covers useKnowledgeBaseSession + the UI helpers UserPanel uses)
const mockSignOut = vi.fn();
const mockUseKbSession = vi.fn();
const mockUseSessionExpiry = vi.fn();
const mockFormatTime = vi.fn();
const mockSanitizeImageURL = vi.fn();
const mockLogout = vi.fn().mockResolvedValue(undefined);

// Stable client reference: useApiClient is called per render. The real provider
// holds one instance; the mock must do the same to keep useMemo deps stable.
const stableMockClient = { logout: mockLogout };

vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual<typeof import('@semiont/react-ui')>('@semiont/react-ui');
  return {
    ...actual,
    useKnowledgeBaseSession: () => mockUseKbSession(),
    useSessionExpiry: () => mockUseSessionExpiry(),
    formatTime: (time: number) => mockFormatTime(time),
    sanitizeImageURL: (url: string) => mockSanitizeImageURL(url),
    useApiClient: () => stableMockClient,
  };
});

const ACTIVE_KB = {
  id: 'test',
  label: 'Test KB',
  host: 'localhost',
  port: 4000,
  protocol: 'http' as const,
  email: 'admin@example.com',
};

function withDefaults(overrides: Record<string, any> = {}) {
  return {
    activeKnowledgeBase: ACTIVE_KB,
    signOut: mockSignOut,
    displayName: 'John Doe',
    avatarUrl: 'https://example.com/avatar.jpg',
    userDomain: 'example.com',
    isAdmin: false,
    isModerator: false,
    ...overrides,
  };
}

describe('UserPanel Component', () => {
  const FALLBACK_AVATAR = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iMTYiIGZpbGw9IiM2QjcyODAiLz4KPHBhdGggZD0iTTE2IDE2QzE4LjIwOTEgMTYgMjAgMTQuMjA5MSAyMCAxMkMyMCA5Ljc5MDg2IDE4LjIwOTEgOCAxNiA4QzEzLjc5MDkgOCAxMiA5Ljc5MDg2IDEyIDEyQzEyIDE0LjIwOTEgMTMuNzkwOSAxNiAxNiAxNloiIGZpbGw9IiNFNUU3RUIiLz4KPHBhdGggZD0iTTI0IDI1QzI0IDIxLjY4NjMgMjAuNDE4MyAxOSAxNiAxOUMxMS41ODE3IDE5IDggMjEuNjg2MyA4IDI1IiBzdHJva2U9IiNFNUU3RUIiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+Cjwvc3ZnPg==';

  beforeEach(() => {
    vi.clearAllMocks();

    mockUseTranslations.mockImplementation((key: string, params?: any) => {
      const translations: Record<string, string> = {
        'UserPanel.account': 'Account',
        'UserPanel.user': 'User',
        'UserPanel.profileAlt': 'Profile picture of {name}',
        'UserPanel.session': 'Session',
        'UserPanel.expiresIn': 'Expires in {time}',
        'UserPanel.privileges': 'Privileges',
        'UserPanel.administrator': 'Administrator',
        'UserPanel.moderator': 'Moderator',
        'UserPanel.signOut': 'Sign Out',
      };
      if (key === 'UserPanel.profileAlt' && params?.name) return `Profile picture of ${params.name}`;
      if (key === 'UserPanel.expiresIn' && params?.time) return `Expires in ${params.time}`;
      return translations[key] || key;
    });

    mockUseKbSession.mockReturnValue(withDefaults());
    mockUseSessionExpiry.mockReturnValue({ timeRemaining: 3600000 });
    mockFormatTime.mockReturnValue('1 hour');
    mockSanitizeImageURL.mockImplementation((url: string) => url);
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
      mockUseKbSession.mockReturnValue(withDefaults({
        displayName: 'Jane Smith', avatarUrl, userDomain: 'test.com',
      }));

      render(<UserPanel />);
      expect(mockSanitizeImageURL).toHaveBeenCalledWith(avatarUrl);
    });

    it('should use fallback avatar when avatarUrl is null', () => {
      mockUseKbSession.mockReturnValue(withDefaults({
        displayName: 'Jane Smith', avatarUrl: null, userDomain: 'test.com',
      }));

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
      image.onerror?.(new Event('error'));
      waitFor(() => {
        expect(image).toHaveAttribute('src', FALLBACK_AVATAR);
      });
    });

    it('should display "User" when displayName is null', () => {
      mockUseKbSession.mockReturnValue(withDefaults({
        displayName: null, avatarUrl: null, userDomain: null,
      }));
      render(<UserPanel />);
      expect(screen.getByText('User')).toBeInTheDocument();
    });

    it('should not render domain when userDomain is null', () => {
      mockUseKbSession.mockReturnValue(withDefaults({
        avatarUrl: null, userDomain: null,
      }));
      render(<UserPanel />);
      expect(screen.queryByText(/@/)).not.toBeInTheDocument();
    });
  });

  describe('Session Display', () => {
    it('should format session time correctly', () => {
      mockFormatTime.mockReturnValue('45 minutes');
      render(<UserPanel />);
      expect(screen.getByText('Expires in 45 minutes')).toBeInTheDocument();
    });

    it('should show "Unknown" when time formatting returns null', () => {
      mockFormatTime.mockReturnValue(null);
      render(<UserPanel />);
      expect(screen.getByText('Expires in Unknown')).toBeInTheDocument();
    });

    it('should pass timeRemaining to formatTime', () => {
      const timeRemaining = 1800000;
      mockUseSessionExpiry.mockReturnValue({ timeRemaining });
      render(<UserPanel />);
      expect(mockFormatTime).toHaveBeenCalledWith(timeRemaining);
    });
  });

  describe('Privileges Display', () => {
    it('should not show privileges section for regular users', () => {
      render(<UserPanel />);
      expect(screen.queryByText('Privileges')).not.toBeInTheDocument();
    });

    it('should show administrator badge when user is admin', () => {
      mockUseKbSession.mockReturnValue(withDefaults({
        displayName: 'Admin User', avatarUrl: null, isAdmin: true,
      }));
      render(<UserPanel />);
      expect(screen.getByText('Privileges')).toBeInTheDocument();
      expect(screen.getByText('Administrator')).toBeInTheDocument();
    });

    it('should show moderator badge when user is moderator', () => {
      mockUseKbSession.mockReturnValue(withDefaults({
        displayName: 'Mod User', avatarUrl: null, isModerator: true,
      }));
      render(<UserPanel />);
      expect(screen.getByText('Privileges')).toBeInTheDocument();
      expect(screen.getByText('Moderator')).toBeInTheDocument();
    });

    it('should show both badges when user is admin and moderator', () => {
      mockUseKbSession.mockReturnValue(withDefaults({
        displayName: 'Super User', avatarUrl: null, isAdmin: true, isModerator: true,
      }));
      render(<UserPanel />);
      expect(screen.getByText('Administrator')).toBeInTheDocument();
      expect(screen.getByText('Moderator')).toBeInTheDocument();
    });

    it('should style administrator badge', () => {
      mockUseKbSession.mockReturnValue(withDefaults({
        displayName: 'Admin User', avatarUrl: null, isAdmin: true,
      }));
      render(<UserPanel />);
      const adminBadge = screen.getByText('Administrator');
      expect(adminBadge).toHaveClass('semiont-privilege-text');
      expect(adminBadge.parentElement).toHaveClass('semiont-privilege-badge', 'semiont-privilege-badge--admin');
    });

    it('should style moderator badge', () => {
      mockUseKbSession.mockReturnValue(withDefaults({
        displayName: 'Mod User', avatarUrl: null, isModerator: true,
      }));
      render(<UserPanel />);
      const modBadge = screen.getByText('Moderator');
      expect(modBadge).toHaveClass('semiont-privilege-text');
      expect(modBadge.parentElement).toHaveClass('semiont-privilege-badge', 'semiont-privilege-badge--moderator');
    });
  });

  describe('Sign Out Functionality', () => {
    it('should call signOut(activeKnowledgeBase.id) and navigate to / on click', async () => {
      render(<UserPanel />);
      const signOutButton = screen.getByRole('button', { name: 'Sign Out' });
      await userEvent.click(signOutButton);
      expect(mockLogout).toHaveBeenCalled();
      expect(mockSignOut).toHaveBeenCalledWith(ACTIVE_KB.id);
      expect(mockRouterPush).toHaveBeenCalledWith('/');
    });

    it('should still call apiClient.logout and navigate when no KB is active', async () => {
      // Defensive branch: if Sign Out is somehow clicked while activeKnowledgeBase
      // is null, the handler must NOT call signOut(...) (no id to pass) but
      // must still log out the API client and navigate home.
      mockUseKbSession.mockReturnValue(withDefaults({ activeKnowledgeBase: null }));

      render(<UserPanel />);
      const signOutButton = screen.getByRole('button', { name: 'Sign Out' });
      await userEvent.click(signOutButton);

      expect(mockLogout).toHaveBeenCalled();
      expect(mockSignOut).not.toHaveBeenCalled();
      expect(mockRouterPush).toHaveBeenCalledWith('/');
    });

    it('should still navigate even if signOut is rapidly clicked', async () => {
      render(<UserPanel />);
      const signOutButton = screen.getByRole('button', { name: 'Sign Out' });
      await userEvent.click(signOutButton);
      await userEvent.click(signOutButton);
      expect(mockSignOut).toHaveBeenCalledTimes(2);
    });

    it('should have proper styling for sign out button', () => {
      render(<UserPanel />);
      const signOutButton = screen.getByRole('button', { name: 'Sign Out' });
      expect(signOutButton).toHaveClass('semiont-signout-button');
    });
  });

  describe('Accessibility', () => {
    it('should use semantic HTML for heading', () => {
      render(<UserPanel />);
      const heading = screen.getByText('Account');
      expect(heading.tagName).toBe('H3');
    });

    it('should have proper alt text for fallback avatar', () => {
      mockUseKbSession.mockReturnValue(withDefaults({
        displayName: null, avatarUrl: null, userDomain: null,
      }));
      render(<UserPanel />);
      expect(screen.getByAltText('Profile picture of User')).toBeInTheDocument();
    });

    it('should have semantic label elements', () => {
      render(<UserPanel />);
      const sessionLabel = screen.getByText('Session');
      expect(sessionLabel.tagName).toBe('LABEL');
    });
  });

  describe('Edge Cases', () => {
    it('should handle undefined timeRemaining', () => {
      mockUseSessionExpiry.mockReturnValue({ timeRemaining: undefined });
      mockFormatTime.mockReturnValue(null);
      render(<UserPanel />);
      expect(screen.getByText('Expires in Unknown')).toBeInTheDocument();
    });

    it('should log warning when invalid avatar URL is detected', () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockSanitizeImageURL.mockReturnValue(null);
      render(<UserPanel />);
      expect(consoleWarnSpy).toHaveBeenCalledWith('Invalid profile image URL detected, using fallback');
      consoleWarnSpy.mockRestore();
    });
  });
});
