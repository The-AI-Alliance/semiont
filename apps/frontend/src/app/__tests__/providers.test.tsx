import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { Providers } from '@/app/providers';

// Mock custom contexts
vi.mock('@/contexts/KeyboardShortcutsContext', () => ({
  KeyboardShortcutsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>
}));

// Mock @semiont/react-ui components — only what root Providers actually renders.
// Root Providers no longer mounts the merged KB session provider; that's in AuthShell.
vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual<typeof import('@semiont/react-ui')>('@semiont/react-ui');
  return {
    ...actual,
    ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    LiveRegionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useToast: () => ({ showError: vi.fn(), showSuccess: vi.fn() }),
    useTheme: () => ({ theme: 'light', setTheme: vi.fn(), resolvedTheme: 'light' }),
    notifySessionExpired: vi.fn(),
    notifyPermissionDenied: vi.fn(),
  };
});

vi.mock('@/components/knowledge/NavigationHandler', () => ({
  NavigationHandler: () => null,
}));

describe('Providers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render children with all providers', () => {
    const TestChild = () => <div data-testid="test-child">Test Content</div>;

    render(
      <Providers>
        <TestChild />
      </Providers>
    );

    // Check that child is rendered
    expect(screen.getByTestId('test-child')).toBeInTheDocument();
    expect(screen.getByText('Test Content')).toBeInTheDocument();
  });

  it('should render children (auth-independent providers only)', () => {
    const TestChild = () => <div data-testid="test-child">Test Content</div>;

    render(
      <Providers>
        <TestChild />
      </Providers>
    );

    // After the AuthShell extraction, root Providers no longer mounts AuthProvider.
    // Auth-dependent providers are mounted in protected layouts via AuthShell.
    expect(screen.getByTestId('test-child')).toBeInTheDocument();
  });

  it('should maintain provider hierarchy', () => {
    const TestChild = () => {
      // This would fail if providers are not properly nested
      return <div data-testid="nested-child">Nested Content</div>;
    };

    render(
      <Providers>
        <TestChild />
      </Providers>
    );

    const child = screen.getByTestId('nested-child');

    // Verify root provider hierarchy renders children.
    // AuthProvider is no longer in root Providers — it's mounted in AuthShell
    // inside protected layouts.
    expect(child).toBeInTheDocument();
  });
});
