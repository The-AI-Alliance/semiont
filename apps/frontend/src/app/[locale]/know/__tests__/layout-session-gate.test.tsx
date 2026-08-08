/**
 * `KnowledgeLayout` gates its `<Outlet />` on a live session, so every
 * `know/*` page unmounts whenever `activeSession$` goes null — which
 * `setActiveKb` and `signIn` both do, with real awaits before the
 * replacement arrives (pinned in the SDK by "emits null on activeSession$
 * BEFORE the new session is constructed").
 *
 * This matters for how the pages below may be written: it is the reason a
 * page-level state unit does NOT survive a KB switch holding a disposed
 * client. Pinning it means a future change to the gate can't silently
 * remove that protection.
 *
 * It is NOT sufficient on its own: the page remounts against the new
 * session while the URL still names the previous KB's resource, which is
 * the actual defect fixed in
 * .plans/bugs/resource-page-frozen-on-disposed-client-after-kb-switch.md
 *
 * NOTE (SESSION-TYPED-FACTORIES, landed 2026-07-29): the API now enforces what
 * this gate guards — factories take a `SemiontSession` and construction goes
 * through `useSessionStateUnit`, which builds nothing without a session. These
 * layout gates remain as defense in depth and UX (loading order), not as the
 * safety mechanism.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';

const translations: Record<string, string> = {};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => translations[key] ?? key,
    i18n: { language: 'en' },
  }),
}));

/** Counts mounts of whatever the layout renders into its Outlet. */
const outletMounts: number[] = [];

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  const { useEffect } = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    Outlet: () => {
      useEffect(() => {
        outletMounts.push(outletMounts.length + 1);
      }, []);
      return <div data-testid="outlet" />;
    },
  };
});

vi.mock('@/components/knowledge/KnowledgeSidebarWrapper', () => ({
  KnowledgeSidebarWrapper: () => null,
}));
vi.mock('@/components/toolbar/ToolbarPanels', () => ({ ToolbarPanels: () => null }));
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
    token$: new BehaviorSubject<string | null>('tok'),
    streamState$: new BehaviorSubject('connected'),
  });
  const activeSession$ = new BehaviorSubject<any>(null);
  const activeKbId$ = new BehaviorSubject<string | null>(null);
  const sessionActivating$ = new BehaviorSubject<boolean>(false);
  const kbs$ = new BehaviorSubject<unknown[]>([]);
  return {
    makeSession,
    activeSession$,
    activeKbId$,
    sessionActivating$,
    kbs$,
    browser: {
      activeSession$,
      activeKbId$,
      sessionActivating$,
      kbs$,
      getKbSessionStatus: () => 'signed-out',
      emit: () => {},
      on: () => () => {},
      stream: () => ({ subscribe: () => ({ unsubscribe: () => {} }) }),
    },
  };
});

vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual<typeof import('@semiont/react-ui')>('@semiont/react-ui');
  return {
    ...actual,
    useSemiont: () => harness.browser,
    useKBDiscovery: () => ({ state: null, kbs: [] }),
    Toolbar: () => null,
    Footer: () => null,
    GlobalEvents: () => null,
    ResourceAnnotationsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

import KnowledgeLayout from '../layout';

describe('KnowledgeLayout session gate', () => {
  beforeEach(() => {
    outletMounts.length = 0;
    harness.activeKbId$.next('kb-a');
    harness.sessionActivating$.next(false);
    harness.activeSession$.next(harness.makeSession('kb-a'));
  });

  it('unmounts the routed page while there is no session, and remounts it for the replacement', () => {
    render(<KnowledgeLayout />);
    expect(outletMounts.length).toBe(1);

    // What setActiveKb does: null first, then (after real awaits) the new
    // session. The null render is unavoidable, so the page cannot survive
    // it holding the disposed client.
    act(() => { harness.activeSession$.next(null); harness.sessionActivating$.next(true); });
    act(() => {
      harness.sessionActivating$.next(false);
      harness.activeSession$.next(harness.makeSession('kb-b'));
      harness.activeKbId$.next('kb-b');
    });

    expect(outletMounts.length).toBe(2);
  });

  it('renders no routed page at all while the session is null', () => {
    const { queryByTestId } = render(<KnowledgeLayout />);
    expect(queryByTestId('outlet')).not.toBeNull();

    act(() => { harness.activeSession$.next(null); harness.sessionActivating$.next(true); });
    expect(queryByTestId('outlet')).toBeNull();
  });
});
