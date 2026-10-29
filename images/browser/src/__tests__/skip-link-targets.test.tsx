/**
 * Every route the Browser serves carries exactly one `SkipLinks`, and every
 * link in it lands on an element of that page (WCAG 2.4.1 Bypass Blocks). A
 * skip link whose target is missing is a first tab stop that goes nowhere.
 *
 * The routes are read from `App`'s own route table, so a route added there is
 * held to this without being listed here. The locale layout, the section
 * layouts and the standalone pages are the real ones; the pages routed inside
 * a section layout are stand-ins, because the layout owns the landmarks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { render, waitFor } from '@testing-library/react';
import { createRoutesFromElements, MemoryRouter, type RouteObject } from 'react-router';
import type { SemiontBrowser } from '@semiont/sdk';

const harness = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BehaviorSubject, Subject } = require('rxjs') as typeof import('rxjs');
  const channels = new Map<string, import('rxjs').Subject<unknown>>();
  const channel = (name: string) => {
    let subject = channels.get(name);
    if (!subject) {
      subject = new Subject<unknown>();
      channels.set(name, subject);
    }
    return subject;
  };
  const session = {
    id: 'session-1',
    kb: { id: 'kb-a', label: 'KB A' },
    token$: new BehaviorSubject<string | null>('token'),
    user$: new BehaviorSubject<unknown>({ name: 'Ada' }),
  };
  return {
    session,
    replace: vi.fn(),
    browser: {
      activeKbId$: new BehaviorSubject<string | null>('kb-a'),
      activeSession$: new BehaviorSubject<unknown>(session),
      sessionActivating$: new BehaviorSubject(false),
      kbs$: new BehaviorSubject<unknown[]>([session.kb]),
      getKbSessionStatus: () => 'signed-out',
      emit: (name: string, payload?: unknown) => channel(name).next(payload ?? {}),
      stream: (name: string) => channel(name).asObservable(),
      on: () => () => {},
      completeSignIn: () => new Promise<never>(() => {}),
    },
  };
});

vi.mock('@/app/providers', async () => {
  const { SemiontProvider, ThemeProvider, ToastProvider, TranslationProvider } =
    await vi.importActual<typeof import('@semiont/react-ui')>('@semiont/react-ui');
  const { useMergedTranslationManager } = await import('@/hooks/useMergedTranslationManager');
  return {
    Providers: ({ children }: { children: ReactNode }) => (
      <TranslationProvider translationManager={useMergedTranslationManager()}>
        <SemiontProvider browser={harness.browser as unknown as SemiontBrowser}>
          <ToastProvider>
            <ThemeProvider>{children}</ThemeProvider>
          </ToastProvider>
        </SemiontProvider>
      </TranslationProvider>
    ),
  };
});

vi.mock('@/contexts/AuthShell', () => ({
  AuthShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('@/i18n/routing', () => ({
  Link: ({ to, children, ...props }: ComponentProps<'a'> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useRouter: () => ({ push: vi.fn(), replace: harness.replace }),
  useLocale: () => 'en',
}));

vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual<typeof import('@semiont/react-ui')>('@semiont/react-ui');
  return {
    ...actual,
    Toolbar: () => null,
    ResourceAnnotationsProvider: ({ children }: { children: ReactNode }) => children,
    useKBDiscovery: () => ({ state: null, kbs: [] }),
  };
});

vi.mock('@/components/knowledge/KnowledgeSidebarWrapper', () => ({ KnowledgeSidebarWrapper: () => null }));
vi.mock('@/components/toolbar/ToolbarPanels', () => ({ ToolbarPanels: () => null }));
vi.mock('@/components/moderation/ModerationNavigation', () => ({ ModerationNavigation: () => null }));

vi.mock('@/app/[locale]/know/page', () => ({ default: () => null }));
vi.mock('@/app/[locale]/know/discover/page', () => ({ default: () => null }));
vi.mock('@/app/[locale]/know/compose/page', () => ({ default: () => null }));
vi.mock('@/app/[locale]/know/resource/[id]/page', () => ({ default: () => null }));
vi.mock('@/app/[locale]/moderate/page', () => ({ default: () => null }));
vi.mock('@/app/[locale]/moderate/recent/page', () => ({ default: () => null }));
vi.mock('@/app/[locale]/moderate/entity-tags/page', () => ({ default: () => null }));
vi.mock('@/app/[locale]/moderate/tag-schemas/page', () => ({ default: () => null }));

import App from '../App';

/**
 * Routes that render nothing and leave at once, keyed to where they send the
 * reader. There is no page to skip into, so there is no target to demand.
 */
const REDIRECTS: Record<string, string> = {
  '/en/auth/connect': '/know/discover',
};

function leaves(routes: RouteObject[], base: string): string[] {
  return routes.flatMap((route) => {
    const path = route.path ? `${base}/${route.path}` : base;
    return route.children ? leaves(route.children, path) : [path];
  });
}

/** `App` is a hook-free function of its route table, so calling it yields that table. */
function servedPaths(): string[] {
  const suspense = App() as ReactElement<{ children: ReactElement<{ children: ReactNode }> }>;
  const table = createRoutesFromElements(suspense.props.children.props.children);
  const underLocale = table.find((route) => route.path === '/:locale')?.children;
  if (!underLocale) throw new Error('App has no /:locale route with children');
  return leaves(underLocale, '/en').map((path) => path.replace(':id', 'resource-1').replace('*', 'no-such-page'));
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

function skipLinks(): HTMLAnchorElement[] {
  return [...document.querySelectorAll<HTMLAnchorElement>('.semiont-skip-links a')];
}

async function expectEverySkipLinkToLand() {
  await waitFor(() => {
    expect(skipLinks().length).toBeGreaterThan(0);
    expect(
      skipLinks()
        .map((link) => link.hash)
        .filter((hash) => document.getElementById(hash.slice(1)) === null),
    ).toEqual([]);
  });
  expect(document.querySelectorAll('.semiont-skip-links')).toHaveLength(1);
}

describe('skip links', () => {
  beforeEach(() => {
    harness.replace.mockClear();
    harness.browser.activeKbId$.next('kb-a');
    harness.browser.sessionActivating$.next(false);
    harness.browser.activeSession$.next(harness.session);
  });

  const paths = servedPaths();

  it('reads the route table', () => {
    expect(paths).toContain('/en/know/resource/resource-1');
    expect(paths).toContain('/en/moderate/recent');
  });

  it.each(paths.filter((path) => !(path in REDIRECTS)))('%s: every skip link lands on the page', async (path) => {
    renderAt(path);

    await expectEverySkipLinkToLand();
  });

  it("reads in the locale's own words, from the messages the Browser serves", async () => {
    const messages = JSON.parse(readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')) as {
      SkipLinks: { mainContent: string };
    };

    renderAt('/en');
    await expectEverySkipLinkToLand();

    expect(skipLinks().map((link) => link.textContent)).toEqual([messages.SkipLinks.mainContent]);
  });

  it.each(Object.entries(REDIRECTS))('%s renders nothing and leaves for %s', async (path, destination) => {
    const { container } = renderAt(path);

    await waitFor(() => expect(harness.replace).toHaveBeenCalledWith(destination));
    expect(container.querySelector('main')).toBeNull();
  });

  describe('the knowledge layout, in each session state', () => {
    it('signed out', async () => {
      harness.browser.activeSession$.next(null);

      renderAt('/en/know/discover');

      await expectEverySkipLinkToLand();
    });

    it('while a session is activating', async () => {
      harness.browser.activeSession$.next(null);
      harness.browser.sessionActivating$.next(true);

      renderAt('/en/know/discover');

      await expectEverySkipLinkToLand();
    });
  });
});
