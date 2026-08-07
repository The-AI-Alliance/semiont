/**
 * Regression tests for the two axes a `ResourceLoaderStateUnit` is bound to:
 * the `:id` param and the live session.
 *
 * `useStateUnit` runs its factory exactly once at mount, and React Router
 * keeps `KnowledgeResourcePage` mounted across both a `:id` param change and
 * an `activeSession$` swap. So the loader has to be forced to rebuild by a
 * key that covers BOTH, or it stays bound to whatever it captured first.
 *
 * - `:id` axis — clicking between open-resource tabs changed the URL but not
 *   the content, because the factory never re-ran.
 * - session axis — switching KB (or re-authenticating, which reconstructs the
 *   session under an unchanged `kb.id`) left the loader holding a DISPOSED
 *   client, whose cache is inert by B16: no fetch, no emission, and the page
 *   sits on "Loading resource..." forever.
 *   See .plans/bugs/resource-page-frozen-on-disposed-client-after-kb-switch.md
 *
 * Fix: a thin outer wrapper reads the `:id` param and the session, gates
 * render on the session, and keys the inner component on `${session.id}:${rId}`
 * so a change to either forces a remount.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

let mockedParamsId: string | undefined = 'A';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return {
    ...actual,
    useParams: () => ({ id: mockedParamsId }),
  };
});

const routerReplaceCalls: string[] = [];

vi.mock('@/i18n/routing', () => ({
  useLocale: () => 'en',
  useRouter: () => ({
    replace: (path: string) => { routerReplaceCalls.push(path); },
    push: (path: string) => { routerReplaceCalls.push(path); },
  }),
}));
vi.mock('@/lib/routing', () => ({
  Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
  routes: {},
}));
vi.mock('@/components/toolbar/ToolbarPanels', () => ({
  ToolbarPanels: () => null,
}));
vi.mock('../../../not-found', () => ({
  default: () => <div data-testid="not-found" />,
}));

/** Resource ids the loader factory was invoked with, in order. */
const vmFactoryCalls: string[] = [];
/** Client tags the loader factory was invoked with, in order — the session axis. */
const vmFactoryClients: string[] = [];

/**
 * Test handle onto the mocked `activeSession$`, so a test can swap the live
 * session the way `setActiveKb`/`signIn` do in production. Built through
 * `vi.hoisted` because the `vi.mock` factory below runs before module-scope
 * consts initialize.
 */
const harness = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BehaviorSubject } = require('rxjs') as typeof import('rxjs');
  let sessionSeq = 0;
  const makeSession = (clientTag: string, kbId = 'kb-a') => ({
    // Per-instance identity: distinct even for successive sessions of the
    // same KB, which is exactly the re-authentication case.
    id: `session-${++sessionSeq}`,
    client: { tag: clientTag },
    kb: { id: kbId, label: 'localhost', host: 'localhost', port: 4000, protocol: 'http', email: 'admin@example.com' },
    streamState$: new BehaviorSubject('initial'),
  });
  const session$ = new BehaviorSubject<any>(makeSession('c1'));
  return { session$, makeSession, browser: { activeSession$: session$ } };
});

vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual<typeof import('@semiont/react-ui')>(
    '@semiont/react-ui',
  );
  const { of } = await vi.importActual<typeof import('rxjs')>('rxjs');
  return {
    ...actual,
    useSemiont: () => harness.browser,
    createResourceLoaderStateUnit: (session: any, rId: string) => {
      vmFactoryCalls.push(rId);
      vmFactoryClients.push(session?.client?.tag ?? 'none');
      // Real rxjs rather than hand-rolled subscribe stubs: correctly typed,
      // and it exercises the same delivery path the component sees.
      return {
        resource$: of({ '@id': rId, name: `Resource ${rId}` }),
        isLoading$: of(false),
        error$: of(null),
        invalidate: () => {},
        dispose: () => {},
      };
    },
    ResourceViewerPage: ({ rUri }: { rUri: string }) => <div data-testid="resource-rid">{rUri}</div>,
    ResourceLoadingState: () => <div data-testid="loading" />,
    ResourceErrorState: () => <div data-testid="error" />,
  };
});

import KnowledgeResourcePage from '../page';

describe('KnowledgeResourcePage navigation', () => {
  beforeEach(() => {
    vmFactoryCalls.length = 0;
    vmFactoryClients.length = 0;
    routerReplaceCalls.length = 0;
    mockedParamsId = 'A';
    // Reset to a single live session on KB "kb-a" between tests.
    harness.session$.next(harness.makeSession('c1'));
  });

  it('creates a fresh ResourceLoaderStateUnit when the :id param changes', () => {
    mockedParamsId = 'A';
    const { rerender } = render(<KnowledgeResourcePage />);

    expect(screen.getByTestId('resource-rid').textContent).toBe('A');
    expect(vmFactoryCalls).toEqual(['A']);

    // Simulate route-param change: params.id is now B, but React Router
    // keeps the component mounted (no unmount). Without the key-based
    // remount fix, the factory would not re-run and the content would
    // stay on A.
    mockedParamsId = 'B';
    act(() => { rerender(<KnowledgeResourcePage />); });

    expect(screen.getByTestId('resource-rid').textContent).toBe('B');
    expect(vmFactoryCalls).toEqual(['A', 'B']);
  });

  it('rebuilds the state unit on each distinct :id transition, not just the first', () => {
    mockedParamsId = 'X';
    const { rerender } = render(<KnowledgeResourcePage />);

    mockedParamsId = 'Y';
    act(() => { rerender(<KnowledgeResourcePage />); });

    mockedParamsId = 'Z';
    act(() => { rerender(<KnowledgeResourcePage />); });

    mockedParamsId = 'X';
    act(() => { rerender(<KnowledgeResourcePage />); });

    expect(vmFactoryCalls).toEqual(['X', 'Y', 'Z', 'X']);
    expect(screen.getByTestId('resource-rid').textContent).toBe('X');
  });

  it('re-render with the same :id does NOT rebuild the state unit (React Router same-param re-renders are common)', () => {
    mockedParamsId = 'A';
    const { rerender } = render(<KnowledgeResourcePage />);

    act(() => { rerender(<KnowledgeResourcePage />); });
    act(() => { rerender(<KnowledgeResourcePage />); });

    expect(vmFactoryCalls).toEqual(['A']);
  });

  it('rebuilds the state unit against the NEW client when the session is replaced for the SAME kb (re-auth)', () => {
    mockedParamsId = 'A';
    render(<KnowledgeResourcePage />);
    expect(vmFactoryClients).toEqual(['c1']);

    // `signIn` on an already-active KB disposes the session and constructs a
    // fresh one under an unchanged `kb.id`. Keyed on `kb.id` this transition
    // is invisible and the loader keeps the disposed client.
    act(() => { harness.session$.next(harness.makeSession('c2', 'kb-a')); });

    expect(vmFactoryClients).toEqual(['c1', 'c2']);
    expect(vmFactoryCalls).toEqual(['A', 'A']);
    expect(routerReplaceCalls).toEqual([]);
  });

  it('shows the loading state and builds no state unit while there is no active session', () => {
    mockedParamsId = 'A';
    render(<KnowledgeResourcePage />);
    expect(vmFactoryClients).toEqual(['c1']);

    // The activation gap: setActiveKb nulls activeSession$ before the
    // replacement arrives. Nothing may be constructed against a null client.
    act(() => { harness.session$.next(null); });

    expect(screen.getByTestId('loading')).toBeTruthy();
    expect(vmFactoryClients).toEqual(['c1']);
  });

  it('renders not-found — and builds no state unit — when the :id param is absent', () => {
    // `App.tsx` declares `resource/:id`, so React Router cannot match this
    // route without the param, and the page read it as `params?.id as string`
    // on the strength of that. But the cast made the assumption unchecked:
    // `resourceId()` takes a `string` and calls `.includes('/')` on it
    // immediately, so if the route pattern were ever renamed the page would
    // throw a TypeError and white-screen rather than degrade. This pins the
    // branch that lets the compiler prove the id is a string.
    mockedParamsId = undefined;

    render(<KnowledgeResourcePage />);

    expect(screen.getByTestId('not-found')).toBeTruthy();
    expect(vmFactoryCalls).toEqual([]);
    expect(screen.queryByTestId('resource-rid')).toBeNull();
  });

  it('leaves the KB-switch redirect to the switch INITIATOR, not to itself', () => {
    // This page cannot detect a KB switch: `KnowledgeLayout` gates <Outlet />
    // on a live session, so it is unmounted the instant `activeSession$` goes
    // null and remounts fresh against the replacement. A latch here observed
    // nothing and was dead in production while THIS test — which renders the
    // page with no layout above it — passed. The behaviour now lives in
    // `KnowledgeBasePanel`, where the switch is initiated and the page is
    // still mounted; see its "switching KB away from a resource route" specs.
    //
    // What this page still owes: rebuild against whatever session it is given,
    // which the `${session.id}:${rId}` key provides and the pins above cover.
    mockedParamsId = 'A';
    render(<KnowledgeResourcePage />);

    act(() => { harness.session$.next(null); });
    act(() => { harness.session$.next(harness.makeSession('c2', 'kb-b')); });

    expect(routerReplaceCalls).toEqual([]);
    // It does rebuild for the new session rather than holding the old client.
    expect(vmFactoryClients).toEqual(['c1', 'c2']);
  });
});
