import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MockedFunction } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAuth } from '../useAuth';
import { useAuthContext } from '@/contexts/AuthContext';
import type { AuthSession } from '@/contexts/AuthContext';

vi.mock('@/contexts/AuthContext', () => ({
  useAuthContext: vi.fn(),
}));

const mockUseAuthContext = useAuthContext as MockedFunction<typeof useAuthContext>;

const makeSession = (overrides: Partial<AuthSession['user']> = {}): AuthSession => ({
  token: 'test.jwt.token',
  user: {
    id: '123',
    email: 'john@company.com',
    name: 'John Doe',
    image: 'https://example.com/avatar.jpg',
    domain: 'company.com',
    provider: 'google',
    isAdmin: false,
    isActive: true,
    termsAcceptedAt: '2024-01-01',
    lastLogin: null,
    created: '2024-01-01',
    ...overrides,
  } as AuthSession['user'],
});

describe('useAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns loading state when auth is loading', () => {
    mockUseAuthContext.mockReturnValue({
      session: null, isLoading: true,
      setSession: vi.fn(), clearSession: vi.fn(),
    });

    const { result } = renderHook(() => useAuth());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.session).toBeNull();
  });

  it('returns unauthenticated state when no session', () => {
    mockUseAuthContext.mockReturnValue({
      session: null, isLoading: false,
      setSession: vi.fn(), clearSession: vi.fn(),
    });

    const { result } = renderHook(() => useAuth());

    expect(result.current.isLoading).toBe(false);
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.token).toBeNull();
    expect(result.current.user).toBeNull();
  });

  it('returns authenticated state with session data', () => {
    const session = makeSession();
    mockUseAuthContext.mockReturnValue({
      session, isLoading: false,
      setSession: vi.fn(), clearSession: vi.fn(),
    });

    const { result } = renderHook(() => useAuth());

    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.isFullyAuthenticated).toBe(true);
    expect(result.current.token).toBe('test.jwt.token');
    expect(result.current.user?.email).toBe('john@company.com');
    expect(result.current.displayName).toBe('John Doe');
    expect(result.current.userDomain).toBe('company.com');
    expect(result.current.avatarUrl).toBe('https://example.com/avatar.jpg');
    expect(result.current.isAdmin).toBe(false);
  });

  it('extracts domain from email when domain field missing', () => {
    const session = makeSession({ domain: '' });
    mockUseAuthContext.mockReturnValue({
      session, isLoading: false,
      setSession: vi.fn(), clearSession: vi.fn(),
    });

    const { result } = renderHook(() => useAuth());
    expect(result.current.userDomain).toBe('company.com');
  });

  it('returns isAdmin from user', () => {
    const session = makeSession({ isAdmin: true });
    mockUseAuthContext.mockReturnValue({
      session, isLoading: false,
      setSession: vi.fn(), clearSession: vi.fn(),
    });

    const { result } = renderHook(() => useAuth());
    expect(result.current.isAdmin).toBe(true);
  });

  it('memoizes results on re-render with same session', () => {
    const session = makeSession();
    mockUseAuthContext.mockReturnValue({
      session, isLoading: false,
      setSession: vi.fn(), clearSession: vi.fn(),
    });

    const { result, rerender } = renderHook(() => useAuth());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
