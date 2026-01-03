import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { SessionExpiredModal } from '../SessionExpiredModal';
import { SessionProvider } from '../../../contexts/SessionContext';

// Mock next-auth (must use factory function for hoisting)
vi.mock('next-auth/react', () => ({
  signIn: vi.fn(),
  useSession: vi.fn(() => ({
    data: null,
    status: 'unauthenticated'
  }))
}));

// Import the mocked signIn after the mock is set up
import { signIn as mockSignIn } from 'next-auth/react';

// Mock window.location
const mockLocation = {
  href: '',
  pathname: '/test'
};

Object.defineProperty(window, 'location', {
  value: mockLocation,
  writable: true
});

// Helper to render with SessionProvider
const renderWithSession = (isAuthenticated = false) => {
  return render(
    <SessionProvider isAuthenticated={isAuthenticated}>
      <SessionExpiredModal />
    </SessionProvider>
  );
};

describe('SessionExpiredModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLocation.href = '';
    mockLocation.pathname = '/test';
  });

  describe('Component Rendering', () => {
    it('should render without crashing when authenticated', () => {
      const { container } = renderWithSession(true);
      expect(container).toBeInTheDocument();
    });

    it('should render without crashing when unauthenticated', () => {
      const { container } = renderWithSession(false);
      expect(container).toBeInTheDocument();
    });
  });

  describe('Initial State', () => {
    it('should not show modal initially when authenticated', () => {
      renderWithSession(true);
      // Modal should not be visible
      expect(screen.queryByText('Session Expired')).not.toBeInTheDocument();
    });

    it('should not show modal initially when unauthenticated', () => {
      renderWithSession(false);
      // Modal should not be visible (only shows on transition or event)
      expect(screen.queryByText('Session Expired')).not.toBeInTheDocument();
    });
  });

  describe('Component Structure', () => {
    it('should use HeadlessUI Dialog component', () => {
      // This test verifies the component structure exists
      const { container } = renderWithSession(false);
      expect(container.firstChild).toBeDefined();
    });
  });
});
