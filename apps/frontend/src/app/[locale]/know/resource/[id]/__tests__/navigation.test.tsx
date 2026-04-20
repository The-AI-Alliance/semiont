/**
 * Regression test for resource-to-resource navigation.
 *
 * Previously, clicking between open-resource tabs in the left nav
 * changed the URL but didn't update the page content. Root cause:
 * `useViewModel` runs its factory exactly once at mount and React
 * Router keeps `KnowledgeResourcePage` mounted across `:id` param
 * changes, so the `ResourceLoaderVM` stayed bound to the first rId
 * forever.
 *
 * Fix: split into a thin outer wrapper that reads the `:id` param and
 * an inner component keyed on `rId` so a different id forces a remount.
 *
 * This test locks the fix in: when the URL param the page reads
 * changes, the VM factory must be re-invoked with the new value.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, act } from '@testing-library/react';

let mockedParamsId: string = 'A';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return {
    ...actual,
    useParams: () => ({ id: mockedParamsId }),
  };
});

vi.mock('@/i18n/routing', () => ({
  useLocale: () => 'en',
}));
vi.mock('@/lib/routing', () => ({
  Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
  routes: {},
}));
vi.mock('@/components/toolbar/ToolbarPanels', () => ({
  ToolbarPanels: () => null,
}));

const vmFactoryCalls: string[] = [];

vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual<typeof import('@semiont/react-ui')>(
    '@semiont/react-ui',
  );
  const { BehaviorSubject } = await vi.importActual<typeof import('rxjs')>('rxjs');
  const stableMockClient = {} as any;
  const TEST_KB = { id: 'test', label: 'localhost', host: 'localhost', port: 4000, protocol: 'http', email: 'admin@example.com' };
  const stableActiveSession$ = new BehaviorSubject<any>({
    client: stableMockClient,
    kb: TEST_KB,
    streamState$: new BehaviorSubject('initial'),
  });
  const stableMockBrowser = { activeSession$: stableActiveSession$ };
  return {
    ...actual,
    useSemiont: () => stableMockBrowser,
    createResourceLoaderVM: (_client: any, rId: string) => {
      vmFactoryCalls.push(rId);
      return {
        resource$: {
          subscribe: (observer: any) => {
            const next = typeof observer === 'function' ? observer : observer.next?.bind(observer);
            if (next) next({ '@id': rId, name: `Resource ${rId}` });
            return { unsubscribe: () => {} };
          },
        } as any,
        isLoading$: {
          subscribe: (observer: any) => {
            const next = typeof observer === 'function' ? observer : observer.next?.bind(observer);
            if (next) next(false);
            return { unsubscribe: () => {} };
          },
        } as any,
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
  });

  it('creates a fresh ResourceLoaderVM when the :id param changes', () => {
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

  it('rebuilds the VM on each distinct :id transition, not just the first', () => {
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

  it('re-render with the same :id does NOT rebuild the VM (React Router same-param re-renders are common)', () => {
    mockedParamsId = 'A';
    const { rerender } = render(<KnowledgeResourcePage />);

    act(() => { rerender(<KnowledgeResourcePage />); });
    act(() => { rerender(<KnowledgeResourcePage />); });

    expect(vmFactoryCalls).toEqual(['A']);
  });
});
