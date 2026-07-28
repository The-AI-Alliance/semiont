/**
 * `/auth/welcome` must not build its state unit before a session exists.
 *
 * `createWelcomeStateUnit` calls `client.auth!.me()` *at construction*
 * (welcome-state-unit.ts:20), and this page reaches it through
 * `session?.client` — so mounting during the activation gap dereferences
 * `undefined` and throws. The page even computes `isLoading` for exactly that
 * state, but only after the construction has already happened.
 *
 * This is the route you land on straight after connecting, which is precisely
 * when the session is still being constructed.
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

/** Clients the welcome state unit was constructed against, in order. */
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
    createWelcomeStateUnit: (client: any) => {
      welcomeFactoryClients.push(client?.tag);
      // Mirrors the real unit: it touches the client immediately.
      void client.auth;
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
