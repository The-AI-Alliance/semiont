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

// Mock react-ui. The UserPanel now reads user info, kb, and client off
// `useSemiont().activeSession$`, and signs out via `semiont.signOut(kb.id)`.
// The mock browser exposes controllable subjects so tests can flip the shape
// the panel sees.
const { mockSignOut, mockUseSessionExpiry, mockFormatTime, mockSanitizeImageURL, mockLogout, mockBrowser, user$, activeSession$ } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BehaviorSubject } = require('rxjs');
  const mockLogout = vi.fn().mockResolvedValue(undefined);
  // sessionVM.logout() calls client.auth.logout() — namespace shape, not flat.
  const mockClient = { auth: { logout: mockLogout } };
  const user$ = new BehaviorSubject(null);
  const token$ = new BehaviorSubject(null);
  const ACTIVE_KB = {
    id: 'test',
    label: 'Test KB',
    host: 'localhost',
    port: 4000,
    protocol: 'http',
    email: 'admin@example.com',
  };
  const activeSession$ = new BehaviorSubject({
    client: mockClient,
    kb: ACTIVE_KB,
    user$,
    token$,
    refresh: async () => null,
  });
  const mockSignOut = vi.fn().mockResolvedValue(undefined);
  const mockBrowser = {
    activeSession$,
    kbs$: new BehaviorSubject([ACTIVE_KB]),
    activeKbId$: new BehaviorSubject(ACTIVE_KB.id),
    signOut: mockSignOut,
  };
  return {
    mockSignOut,
    mockUseSessionExpiry: vi.fn(),
    mockFormatTime: vi.fn(),
    mockSanitizeImageURL: vi.fn(),
    mockLogout,
    mockBrowser,
    user$,
    activeSession$,
  };
});

vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual<typeof import('@semiont/react-ui')>('@semiont/react-ui');
  return {
    ...actual,
    useSessionExpiry: () => mockUseSessionExpiry(),
    formatTime: (time: number) => mockFormatTime(time),
    sanitizeImageURL: (url: string) => mockSanitizeImageURL(url),
    useSemiont: () => mockBrowser,
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

function setUser(overrides: Record<string, any> = {}) {
  const base = {
    name: 'John Doe',
    image: 'https://example.com/avatar.jpg',
    domain: 'example.com',
    email: 'john@example.com',
    isAdmin: false,
    isModerator: false,
  };
  // Support legacy test shape (displayName/avatarUrl/userDomain)
  const translated: Record<string, any> = { ...base };
  if ('displayName' in overrides) {
    translated.name = overrides.displayName;
    delete overrides.displayName;
  }
  if ('avatarUrl' in overrides) {
    translated.image = overrides.avatarUrl;
    delete overrides.avatarUrl;
  }
  if ('userDomain' in overrides) {
    translated.domain = overrides.userDomain;
    delete overrides.userDomain;
  }
  user$.next({ ...translated, ...overrides });
}

function setActiveKnowledgeBase(kb: typeof ACTIVE_KB | null) {
  const current = activeSession$.getValue();
  if (kb === null) {
    activeSession$.next({ ...current, kb: null });
  } else {
    activeSession$.next({ ...current, kb });
  }
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

    setUser();
    setActiveKnowledgeBase(ACTIVE_KB);
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
      setUser({ name: 'Jane Smith', image: avatarUrl, domain: 'test.com' });

      render(<UserPanel />);
      expect(mockSanitizeImageURL).toHaveBeenCalledWith(avatarUrl);
    });

    it('should use fallback avatar when avatarUrl is null', () => {
      setUser({ name: 'Jane Smith', image: null, domain: 'test.com' });

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
      // user$ null => displayName falls through to 'User'
      user$.next(null);
      render(<UserPanel />);
      expect(screen.getByText('User')).toBeInTheDocument();
    });

    it('should not render domain when userDomain is null', () => {
      setUser({ image: null, domain: undefined, email: 'someone' });
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
      setUser({ name: 'Admin User', image: null, isAdmin: true });
      render(<UserPanel />);
      expect(screen.getByText('Privileges')).toBeInTheDocument();
      expect(screen.getByText('Administrator')).toBeInTheDocument();
    });

    it('should show moderator badge when user is moderator', () => {
      setUser({ name: 'Mod User', image: null, isModerator: true });
      render(<UserPanel />);
      expect(screen.getByText('Privileges')).toBeInTheDocument();
      expect(screen.getByText('Moderator')).toBeInTheDocument();
    });

    it('should show both badges when user is admin and moderator', () => {
      setUser({ name: 'Super User', image: null, isAdmin: true, isModerator: true });
      render(<UserPanel />);
      expect(screen.getByText('Administrator')).toBeInTheDocument();
      expect(screen.getByText('Moderator')).toBeInTheDocument();
    });

    it('should style administrator badge', () => {
      setUser({ name: 'Admin User', image: null, isAdmin: true });
      render(<UserPanel />);
      const adminBadge = screen.getByText('Administrator');
      expect(adminBadge).toHaveClass('semiont-privilege-text');
      expect(adminBadge.parentElement).toHaveClass('semiont-privilege-badge', 'semiont-privilege-badge--admin');
    });

    it('should style moderator badge', () => {
      setUser({ name: 'Mod User', image: null, isModerator: true });
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
      setActiveKnowledgeBase(null);

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
      user$.next(null);
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
