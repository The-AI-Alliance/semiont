/**
 * `/auth/welcome` must not build its state unit before a session exists.
 *
 * Since SESSION-TYPED-FACTORIES landed, this is enforced by API shape:
 * `createWelcomeStateUnit` takes the SESSION and the page constructs it
 * through `useSessionStateUnit`, which builds nothing until a session exists
 * and rebuilds (dispose-first) on swap. These pins now guard that hook-level
 * gate at the page altitude — the route you land on straight after
 * connecting, precisely when the session is still being constructed (the
 * original production crash).
 *
 * See .plans/bugs/resource-page-frozen-on-disposed-client-after-kb-switch.md
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

vi.mock('@/i18n/routing', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
}));

/** Clients (via their session) the unit was constructed against, in order. */
const welcomeFactoryClients: Array<string | undefined> = [];

const harness = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BehaviorSubject } = require('rxjs') as typeof import('rxjs');
  let seq = 0;
  const makeSession = (tag: string) => ({
    id: `session-${++seq}`,
    client: { tag },
    kb: { id: 'kb-a', label: 'KB A' },
    user$: new BehaviorSubject<unknown>({ name: 'Ada Lovelace' }),
  });
  const activeSession$ = new BehaviorSubject<any>(null);
  const activeKbId$ = new BehaviorSubject<string | null>('kb-a');
  return {
    makeSession,
    activeSession$,
    activeKbId$,
    browser: { activeSession$, activeKbId$, signOut: () => {} },
  };
});

vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual<typeof import('@semiont/react-ui')>('@semiont/react-ui');
  const { BehaviorSubject } = await vi.importActual<typeof import('rxjs')>('rxjs');
  return {
    ...actual,
    useSemiont: () => harness.browser,
    useToast: () => ({ showError: () => {}, showSuccess: () => {} }),
    createWelcomeStateUnit: (session: any) => {
      welcomeFactoryClients.push(session?.client?.tag);
      // Mirrors the real unit: it dereferences the session immediately.
      void session.client.auth;
      return {
        userData$: new BehaviorSubject<unknown>(null),
        isProcessing$: new BehaviorSubject(false),
        acceptTerms: async () => {},
        dispose: () => {},
      };
    },
    WelcomePage: ({ status }: { status: string }) => <div data-testid="welcome" data-status={status} />,
  };
});

import Welcome from '../page';

describe('Welcome page — session gate', () => {
  beforeEach(() => {
    welcomeFactoryClients.length = 0;
    harness.activeKbId$.next('kb-a');
    harness.activeSession$.next(null);
  });

  it('renders the loading state without constructing a state unit while the session is activating', () => {
    expect(() => render(<Welcome />)).not.toThrow();

    expect(welcomeFactoryClients).toEqual([]);
    expect(document.querySelector('[data-testid="welcome"]')?.getAttribute('data-status')).toBe('loading');
  });

  it('constructs against the real client once the session arrives', () => {
    render(<Welcome />);
    expect(welcomeFactoryClients).toEqual([]);

    act(() => { harness.activeSession$.next(harness.makeSession('c1')); });

    expect(welcomeFactoryClients).toEqual(['c1']);
  });

  it('rebuilds against the replacement when the session is swapped', () => {
    render(<Welcome />);
    act(() => { harness.activeSession$.next(harness.makeSession('c1')); });
    act(() => { harness.activeSession$.next(null); });
    act(() => { harness.activeSession$.next(harness.makeSession('c2')); });

    expect(welcomeFactoryClients).toEqual(['c1', 'c2']);
  });
});
