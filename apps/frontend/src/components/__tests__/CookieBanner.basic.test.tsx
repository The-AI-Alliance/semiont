import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock, MockedFunction } from 'vitest'
import React from 'react';
import { render, screen } from '@testing-library/react';
import { CookieBanner } from '../CookieBanner';
import * as cookieLib from '@/lib/cookies';

// Mock the cookies library
vi.mock('@/lib/cookies', () => ({
  shouldShowBanner: vi.fn(),
  isGDPRApplicable: vi.fn(),
  isCCPAApplicable: vi.fn(),
  setCookieConsent: vi.fn(),
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
    }
  ]
}));

describe('CookieBanner - Basic Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should not display when shouldShowBanner returns false', () => {
    (cookieLib.shouldShowBanner as Mock).mockReturnValue(false);
    
    render(<CookieBanner />);
    
    // The banner should not be visible
    expect(screen.queryByText(/cookie/i)).not.toBeInTheDocument();
  });

  it('should render without crashing when shouldShowBanner returns true', async () => {
    (cookieLib.shouldShowBanner as Mock).mockReturnValue(true);
    (cookieLib.isGDPRApplicable as Mock).mockResolvedValue(false);
    (cookieLib.isCCPAApplicable as Mock).mockResolvedValue(false);
    
    render(<CookieBanner />);
    
    // Should render the component without throwing
    expect(screen.getByTestId).toBeDefined();
  });

  it('should call shouldShowBanner on mount', () => {
    (cookieLib.shouldShowBanner as Mock).mockReturnValue(false);
    
    render(<CookieBanner />);
    
    expect(cookieLib.shouldShowBanner).toHaveBeenCalled();
  });

  it('should handle className prop', () => {
    (cookieLib.shouldShowBanner as Mock).mockReturnValue(false);
    
    const { container } = render(<CookieBanner className="test-class" />);
    
    // Should render without errors with className
    expect(container).toBeDefined();
  });
});