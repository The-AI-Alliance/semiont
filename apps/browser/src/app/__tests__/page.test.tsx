import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import Home from '@/app/[locale]/page';

const { routerPush, routerReplace, session$ } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BehaviorSubject } = require('rxjs') as typeof import('rxjs');
  return {
    routerPush: vi.fn(),
    routerReplace: vi.fn(),
    session$: new BehaviorSubject<unknown>(null),
  };
});

vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual('@semiont/react-ui');
  return {
    ...actual,
    useSemiont: () => ({ activeSession$: session$ }),
    SemiontBranding: ({ className }: any) => (
      <div data-testid="semiont-branding" className={className}>
        <h2>Semiont</h2>
      </div>
    ),
    buttonStyles: { primary: { base: 'semiont-button semiont-button--primary' } },
  };
});

vi.mock('@/i18n/routing', () => ({
  useRouter: () => ({ push: routerPush, replace: routerReplace }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key === 'Home.begin' ? 'Begin' : key }),
}));

describe('Home Page (Splash)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    session$.next(null);
  });

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

  /**
   * The splash is the FIRST-CONTACT screen, not a toll booth: a live session
   * skips it straight to /know, whose landing redirect owns "where was I"
   * (last-viewed resource, else discover). Begin and the auto-transition go
   * to /know for the same reason — pushing /know/discover bypassed the
   * resume, so a returning reader always lost their place.
   */
  describe('session-aware routing', () => {
    it('a live session skips the splash: replace(/know), no ceremony', () => {
      session$.next({ id: 's1' });

      render(<Home />);

      expect(routerReplace).toHaveBeenCalledWith('/know');
    });

    it('Begin goes to /know so the landing redirect can resume', () => {
      render(<Home />);

      fireEvent.click(screen.getByText('Begin'));

      expect(routerPush).toHaveBeenCalledWith('/know');
      expect(routerReplace).not.toHaveBeenCalled();
    });

    it('the auto-transition also goes to /know', () => {
      vi.useFakeTimers();
      render(<Home />);
      expect(routerPush).not.toHaveBeenCalled();

      act(() => { vi.advanceTimersByTime(5_000); });

      expect(routerPush).toHaveBeenCalledWith('/know');
      vi.useRealTimers();
    });

    it('a session arriving while the splash is up redirects without waiting out the timer', () => {
      vi.useFakeTimers();
      render(<Home />);
      expect(routerReplace).not.toHaveBeenCalled();

      act(() => { session$.next({ id: 's1' }); });

      expect(routerReplace).toHaveBeenCalledWith('/know');
      // The ceremony timer must not ALSO fire a navigation afterwards.
      act(() => { vi.advanceTimersByTime(10_000); });
      expect(routerPush).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });
});
