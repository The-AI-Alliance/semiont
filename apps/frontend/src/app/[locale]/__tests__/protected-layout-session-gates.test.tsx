/**
 * The admin and moderate layouts gate their `<Outlet />` on a live session,
 * the same way the knowledge layout does.
 *
 * Nothing recorded that, yet it is load-bearing: the pages below them build
 * state units from `session!.client` in a mount-once factory
 * (`admin/{exchange,security,users}`, `moderate/{entity-tags,linked-data}`),
 * so they are only safe because they never render without a session and are
 * remounted when one is replaced. A refactor that kept showing the chrome
 * while the session was null would hand every one of them a disposed client
 * — silently, since nothing would fail to compile.
 *
 * See .plans/bugs/resource-page-frozen-on-disposed-client-after-kb-switch.md
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

const routerPushes: string[] = [];

vi.mock('@/i18n/routing', () => ({
  useRouter: () => ({
    push: (path: string) => { routerPushes.push(path); },
    replace: (path: string) => { routerPushes.push(path); },
  }),
  useLocale: () => 'en',
}));

const outletMounts: string[] = [];

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  const { useEffect } = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    Outlet: () => {
      useEffect(() => { outletMounts.push('mount'); }, []);
      return <div data-testid="outlet" />;
    },
  };
});

vi.mock('@/components/admin/AdminNavigation', () => ({ AdminNavigation: () => null }));
vi.mock('@/components/moderation/ModerationNavigation', () => ({ ModerationNavigation: () => null }));
vi.mock('@/components/CookiePreferences', () => ({ CookiePreferences: () => null }));
vi.mock('@/lib/routing', () => ({
  Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
  routes: {},
}));

const harness = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BehaviorSubject } = require('rxjs') as typeof import('rxjs');
  let seq = 0;
  const makeSession = (kbId = 'kb-a') => ({
    id: `session-${++seq}`,
    kb: { id: kbId, label: kbId },
    user$: new BehaviorSubject<unknown>({ name: 'Ada', isAdmin: true, isModerator: true }),
  });
  const activeSession$ = new BehaviorSubject<any>(null);
  return { makeSession, activeSession$, browser: { activeSession$ } };
});

vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual<typeof import('@semiont/react-ui')>('@semiont/react-ui');
  return {
    ...actual,
    useSemiont: () => harness.browser,
    LeftSidebar: ({ children }: { children: any }) =>
      typeof children === 'function' ? children(false, () => {}, null) : children,
    Footer: () => null,
  };
});

import AdminLayout from '../admin/layout';
import ModerateLayout from '../moderate/layout';

describe.each([
  ['AdminLayout', AdminLayout],
  ['ModerateLayout', ModerateLayout],
])('%s session gate', (_name, Layout) => {
  beforeEach(() => {
    outletMounts.length = 0;
    routerPushes.length = 0;
    harness.activeSession$.next(harness.makeSession('kb-a'));
  });

  it('renders no routed page while the session is null', () => {
    const { queryByTestId } = render(<Layout />);
    expect(queryByTestId('outlet')).not.toBeNull();

    act(() => { harness.activeSession$.next(null); });

    expect(queryByTestId('outlet')).toBeNull();
  });

  it('remounts the routed page against the replacement session', () => {
    render(<Layout />);
    expect(outletMounts.length).toBe(1);

    act(() => { harness.activeSession$.next(null); });
    act(() => { harness.activeSession$.next(harness.makeSession('kb-b')); });

    expect(outletMounts.length).toBe(2);
  });
});
