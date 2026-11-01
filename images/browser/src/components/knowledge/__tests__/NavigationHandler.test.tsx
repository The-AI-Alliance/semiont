/**
 * A focus on a resource alone brings that resource forward wherever the
 * person is. NavigationHandler is mounted at the app's root, on every page,
 * so a page that shows no resource opens it as well as one that shows another.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { annotationId, resourceId } from '@semiont/core';
import type { useEventSubscriptions } from '@semiont/react-ui';

type Subscriptions = Parameters<typeof useEventSubscriptions>[0];

const captured = vi.hoisted(() => ({ subs: null as Subscriptions | null }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const at = vi.hoisted(() => ({ pathname: '/know/discover' }));

vi.mock('@/i18n/routing', async () => {
  const actual = await vi.importActual<typeof import('@/i18n/routing')>('@/i18n/routing');
  return {
    ...actual,
    usePathname: () => at.pathname,
    useRouter: () => router,
  };
});

vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual<typeof import('@semiont/react-ui')>('@semiont/react-ui');
  return {
    ...actual,
    useEventSubscriptions: (subs: Subscriptions) => {
      captured.subs = subs;
    },
  };
});

import { NavigationHandler } from '../NavigationHandler';

/** The handler NavigationHandler gives beckon:focus, mounted at `pathname`. */
function focusHandlerAt(pathname: string) {
  at.pathname = pathname;
  render(<NavigationHandler />);
  const handler = captured.subs?.['beckon:focus'];
  if (!handler) throw new Error('NavigationHandler does not subscribe to beckon:focus');
  return handler;
}

describe('NavigationHandler — a focus on a resource alone brings it forward from any page', () => {
  beforeEach(() => {
    captured.subs = null;
    router.push.mockClear();
  });

  it('opens the resource from a page that shows no resource', () => {
    focusHandlerAt('/know/discover')({ resourceId: resourceId('res-9') });

    expect(router.push).toHaveBeenCalledExactlyOnceWith('/know/resource/res-9');
  });

  it('opens the resource from a page that shows another', () => {
    focusHandlerAt('/know/resource/res-1')({ resourceId: resourceId('res-9') });

    expect(router.push).toHaveBeenCalledExactlyOnceWith('/know/resource/res-9');
  });

  it('leaves a focus on the resource already shown to its view, which scrolls to the top', () => {
    focusHandlerAt('/know/resource/res-9')({ resourceId: resourceId('res-9') });

    expect(router.push).not.toHaveBeenCalled();
  });

  it('leaves a focus on an annotation to the views', () => {
    focusHandlerAt('/know/discover')({ resourceId: resourceId('res-9'), annotationId: annotationId('ann-1') });

    expect(router.push).not.toHaveBeenCalled();
  });
});
