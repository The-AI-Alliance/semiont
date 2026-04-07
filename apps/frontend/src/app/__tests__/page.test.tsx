import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import Home from '@/app/[locale]/page';

vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual('@semiont/react-ui');
  return {
    ...actual,
    SemiontBranding: ({ size, animated, className }: any) => (
      <div data-testid="semiont-branding" className={className}>
        <h2>Semiont</h2>
      </div>
    ),
    buttonStyles: { primary: { base: 'semiont-button semiont-button--primary' } },
  };
});

vi.mock('@/i18n/routing', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key === 'Home.begin' ? 'Begin' : key }),
}));

describe('Home Page (Splash)', () => {
  it('should render the branding', () => {
    render(<Home />);
    expect(screen.getByTestId('semiont-branding')).toBeInTheDocument();
  });

  it('should render a begin button', () => {
    render(<Home />);
    expect(screen.getByText('Begin')).toBeInTheDocument();
  });

  it('should have a main element with role', () => {
    render(<Home />);
    const main = screen.getByRole('main');
    expect(main).toBeInTheDocument();
  });

  it('should center content vertically', () => {
    render(<Home />);
    const main = screen.getByRole('main');
    expect(main.style.display).toBe('flex');
    expect(main.style.justifyContent).toBe('center');
    expect(main.style.alignItems).toBe('center');
    expect(main.style.minHeight).toBe('100vh');
  });
});
