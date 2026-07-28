/**
 * End-to-end pin for the reported symptom: an endless "Loading resource...".
 *
 * When the resource cache exhausts its B14 retry with nothing cached, B15
 * errors that key's observable. Nothing downstream used to be able to receive
 * that — `useObservable` subscribes next-only, and the loader modelled only
 * (value | no value), so "no value" and "dead request" were the same state.
 * The page therefore sat on the spinner forever while RxJS rethrew the error
 * into the console as an uncaught `BusRequestError`.
 *
 * This test uses the REAL loader state unit and the REAL `useObservable` —
 * only the client and the viewer are stubbed — so it fails if either layer
 * goes back to swallowing.
 *
 * See .plans/bugs/resource-page-frozen-on-disposed-client-after-kb-switch.md (D4)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { Subject } from 'rxjs';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useParams: () => ({ id: 'res-A' }) };
});

vi.mock('@/i18n/routing', () => ({
  useLocale: () => 'en',
  useRouter: () => ({ replace: () => {}, push: () => {} }),
}));
vi.mock('@/lib/routing', () => ({
  Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
  routes: {},
}));
vi.mock('@/components/toolbar/ToolbarPanels', () => ({ ToolbarPanels: () => null }));

const harness = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BehaviorSubject, Subject } = require('rxjs') as typeof import('rxjs');
  const attempts: Array<InstanceType<typeof Subject<unknown>>> = [];
  const invalidateResourceDetail = () => {};
  const client = {
    browse: {
      resource: () => {
        const s = new Subject<unknown>();
        attempts.push(s);
        return s.asObservable();
      },
      invalidateResourceDetail,
    },
  };
  const session = {
    id: 'session-1',
    client,
    kb: { id: 'kb-a', label: 'KB A' },
    streamState$: new BehaviorSubject('connected'),
  };
  return {
    attempts,
    browser: { activeSession$: new BehaviorSubject<unknown>(session) },
  };
});

vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual<typeof import('@semiont/react-ui')>('@semiont/react-ui');
  return {
    ...actual,
    useSemiont: () => harness.browser,
    ResourceViewerPage: () => <div data-testid="viewer" />,
  };
});

import KnowledgeResourcePage from '../page';

describe('KnowledgeResourcePage — terminal load failure', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    harness.attempts.length = 0;
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  const failLatest = (message: string) =>
    act(() => {
      (harness.attempts[harness.attempts.length - 1] as Subject<unknown>).error(new Error(message));
    });

  it('shows the error state with the reason, not an endless spinner', () => {
    render(<KnowledgeResourcePage />);
    // Nothing has arrived yet — the spinner is correct here.
    expect(screen.getByText('Loading resource...')).toBeInTheDocument();

    failLatest('Resource not found');

    expect(screen.queryByText('Loading resource...')).not.toBeInTheDocument();
    expect(screen.getByText('Resource not found')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try Again' })).toBeInTheDocument();
  });

  it('offers a retry that starts a fresh attempt and can recover', () => {
    render(<KnowledgeResourcePage />);
    failLatest('Resource not found');

    const before = harness.attempts.length;
    act(() => { screen.getByRole('button', { name: 'Try Again' }).click(); });
    expect(harness.attempts.length).toBeGreaterThan(before);

    act(() => {
      (harness.attempts[harness.attempts.length - 1] as Subject<unknown>).next({
        '@id': 'res-A',
        name: 'Recovered',
      });
    });
    expect(screen.getByTestId('viewer')).toBeInTheDocument();
  });
});
