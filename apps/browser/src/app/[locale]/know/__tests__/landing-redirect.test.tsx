/**
 * The /know landing route resolves "where was I?" and redirects there.
 *
 * That memory is per-KB. Held globally it sends the user straight into the
 * PREVIOUS KB's resource after a switch — an id the newly active gateway has
 * never heard of, so a guaranteed 404 and a console full of B14/B15 retry
 * noise. The page must read the ACTIVE KB's last-viewed resource from the
 * browser session layer, never a global localStorage key.
 *
 * See .plans/bugs/resource-page-frozen-on-disposed-client-after-kb-switch.md (D3)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

const routerReplaceCalls: string[] = [];

vi.mock('@/i18n/routing', () => ({
  useLocale: () => 'en',
  useRouter: () => ({
    replace: (path: string) => { routerReplaceCalls.push(path); },
    push: (path: string) => { routerReplaceCalls.push(path); },
  }),
}));

const { lastViewedResource$, activeSession$, sessionActivating$, mockBrowser } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BehaviorSubject } = require('rxjs') as typeof import('rxjs');
  const lastViewed = new BehaviorSubject<string | null>(null);
  const session = new BehaviorSubject<unknown>({ id: 'session-1', kb: { id: 'kb-a' } });
  const activating = new BehaviorSubject<boolean>(false);
  return {
    lastViewedResource$: lastViewed,
    activeSession$: session,
    sessionActivating$: activating,
    mockBrowser: {
      lastViewedResource$: lastViewed,
      activeSession$: session,
      sessionActivating$: activating,
    },
  };
});

vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual<typeof import('@semiont/react-ui')>('@semiont/react-ui');
  return { ...actual, useSemiont: () => mockBrowser };
});

import KnowledgePage from '../page';

describe('KnowledgePage landing redirect', () => {
  beforeEach(() => {
    routerReplaceCalls.length = 0;
    lastViewedResource$.next(null);
    activeSession$.next({ id: 'session-1', kb: { id: 'kb-a' } });
    sessionActivating$.next(false);
    localStorage.clear();
  });

  it('redirects to the ACTIVE KB\'s last viewed resource', () => {
    lastViewedResource$.next('res-in-active-kb');
    render(<KnowledgePage />);
    expect(routerReplaceCalls).toEqual(['/know/resource/res-in-active-kb']);
  });

  it('redirects to discover when the active KB has no last viewed resource', () => {
    lastViewedResource$.next(null);
    render(<KnowledgePage />);
    expect(routerReplaceCalls).toEqual(['/know/discover']);
  });

  it('ignores the legacy global lastViewedDocumentId key entirely', () => {
    // A value left behind by an older build — or by a DIFFERENT KB — must not
    // steer the redirect. Storage from previous versions is not honoured.
    localStorage.setItem('lastViewedDocumentId', 'res-from-another-kb');
    lastViewedResource$.next(null);

    render(<KnowledgePage />);

    expect(routerReplaceCalls).toEqual(['/know/discover']);
  });

  it('percent-encodes the resource id it redirects to', () => {
    lastViewedResource$.next('res/with slash');
    render(<KnowledgePage />);
    expect(routerReplaceCalls).toEqual([`/know/resource/${encodeURIComponent('res/with slash')}`]);
  });

  it('waits for the session while it is still activating, then resumes', () => {
    // lastViewedResource$ is a projection of the active, CONNECTED KB, so it
    // reads null during activation. Deciding then would send every cold load
    // to discover regardless of where the user actually was.
    activeSession$.next(null);
    sessionActivating$.next(true);

    render(<KnowledgePage />);
    expect(routerReplaceCalls).toEqual([]);

    act(() => {
      lastViewedResource$.next('res-in-active-kb');
      activeSession$.next({ id: 'session-2', kb: { id: 'kb-a' } });
      sessionActivating$.next(false);
    });

    expect(routerReplaceCalls).toEqual(['/know/resource/res-in-active-kb']);
  });

  it('goes to discover when activation concludes with no session', () => {
    activeSession$.next(null);
    sessionActivating$.next(true);

    render(<KnowledgePage />);
    expect(routerReplaceCalls).toEqual([]);

    act(() => { sessionActivating$.next(false); });

    expect(routerReplaceCalls).toEqual(['/know/discover']);
  });
});
