import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventBus } from '@semiont/core';
import { useOutcomeToasts } from '../useOutcomeToasts';
import { createTestSemiontWrapper } from '../../test-utils';
import type { ReactNode } from 'react';

// The hook's only dependencies are the toast surface and the bus — spy on the
// former, drive the latter through the real subscription path (the wiring:
// channel registration, resourceId filter, severity choice).
const { showError, showSuccess, showInfo } = vi.hoisted(() => ({
  showError: vi.fn(),
  showSuccess: vi.fn(),
  showInfo: vi.fn(),
}));
vi.mock('../../components/Toast', () => ({
  useToast: () => ({ showError, showSuccess, showInfo }),
}));

const RID = 'res-1';

function setup(): { eventBus: EventBus } {
  const { SemiontWrapper, eventBus } = createTestSemiontWrapper();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SemiontWrapper>{children}</SemiontWrapper>
  );
  renderHook(() => useOutcomeToasts(RID), { wrapper });
  return { eventBus };
}

const jobComplete = (over: { resourceId?: string; jobType?: string; result?: unknown } = {}) => ({
  resourceId: over.resourceId ?? RID,
  jobId: 'job-1',
  jobType: (over.jobType ?? 'highlight-annotation') as never,
  result: over.result as never,
});

describe('useOutcomeToasts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a clean decline (scanned-PDF no-text-layer) surfaces as info, not success', () => {
    const { eventBus } = setup();
    act(() => {
      eventBus.get('job:complete').next(jobComplete({
        result: { declined: true, reason: 'no-text-layer', message: 'This PDF has no extractable text layer (scanned or image-only); detection is not supported.' },
      }) as never);
    });
    expect(showInfo).toHaveBeenCalledWith(expect.stringContaining('no extractable text layer'));
    expect(showSuccess).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });

  it('a normal annotation completion surfaces as success', () => {
    const { eventBus } = setup();
    act(() => {
      eventBus.get('job:complete').next(jobComplete({
        result: { highlightsFound: 3, highlightsCreated: 3 },
      }) as never);
    });
    expect(showSuccess).toHaveBeenCalledWith('Annotation complete');
    expect(showInfo).not.toHaveBeenCalled();
  });

  it('a generation completion surfaces the created resource name', () => {
    const { eventBus } = setup();
    act(() => {
      eventBus.get('job:complete').next(jobComplete({
        jobType: 'generation',
        result: { resourceName: 'Cell Biology Notes' },
      }) as never);
    });
    expect(showSuccess).toHaveBeenCalledWith(expect.stringContaining('Cell Biology Notes'));
  });

  it('completions for a different resource are ignored (resourceId filter)', () => {
    const { eventBus } = setup();
    act(() => {
      eventBus.get('job:complete').next(jobComplete({ resourceId: 'other-res' }) as never);
      eventBus.get('job:fail').next({ resourceId: 'other-res', jobId: 'job-1', jobType: 'highlight-annotation', error: 'boom' } as never);
    });
    expect(showSuccess).not.toHaveBeenCalled();
    expect(showInfo).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });

  it('a job failure surfaces as error with the worker message', () => {
    const { eventBus } = setup();
    act(() => {
      eventBus.get('job:fail').next({ resourceId: RID, jobId: 'job-1', jobType: 'highlight-annotation', error: 'inference timed out' } as never);
    });
    expect(showError).toHaveBeenCalledWith('inference timed out');
  });

  it('a local create error toasts once, filtered to this resource', () => {
    const { eventBus } = setup();
    act(() => {
      eventBus.get('mark:create-error').next({ resourceId: RID, message: 'nope' });
    });
    expect(showError).toHaveBeenCalledWith('Failed to create annotation: nope');
    expect(showError).toHaveBeenCalledTimes(1);
  });

  it('a local delete error toasts, filtered to this resource', () => {
    const { eventBus } = setup();
    act(() => {
      eventBus.get('mark:delete-error').next({ resourceId: RID, message: 'gone wrong' });
      eventBus.get('mark:delete-error').next({ resourceId: 'other-res', message: 'not mine' });
    });
    expect(showError).toHaveBeenCalledWith('Failed to delete annotation: gone wrong');
    expect(showError).toHaveBeenCalledTimes(1);
  });

  it('raw wire replies (CommandError) do NOT toast — they are busRequest plumbing', () => {
    // The *-failed reply channels are bridged to every client and matched by
    // correlationId in busRequest. Toasting them raw double-toasts the
    // requester and leaks other users' failures.
    const { eventBus } = setup();
    act(() => {
      eventBus.get('mark:create-failed').next({ correlationId: 'c-1', message: 'nope' } as never);
      eventBus.get('mark:delete-failed').next({ correlationId: 'c-2', message: 'nope' } as never);
    });
    expect(showError).not.toHaveBeenCalled();
  });

  it('bind:body-update-failed (raw wire reply) does NOT toast', () => {
    const { eventBus } = setup();
    act(() => {
      eventBus.get('bind:body-update-failed').next({ correlationId: 'c-3', message: 'nope' } as never);
    });
    expect(showError).not.toHaveBeenCalled();
  });

  it('a local bind error toasts, filtered to this resource (unlink path)', () => {
    // ReferenceEntry's unlink catch cannot toast directly — it emits the
    // client-local sibling instead.
    const { eventBus } = setup();
    act(() => {
      eventBus.get('bind:body-error').next({ resourceId: RID, message: 'nope' });
      eventBus.get('bind:body-error').next({ resourceId: 'other-res', message: 'not mine' });
    });
    expect(showError).toHaveBeenCalledWith('Failed to update reference: nope');
    expect(showError).toHaveBeenCalledTimes(1);
  });

  it('assist cancellation surfaces as info', () => {
    const { eventBus } = setup();
    act(() => {
      eventBus.get('mark:assist-cancelled').next(undefined as never);
    });
    expect(showInfo).toHaveBeenCalledWith('Annotation cancelled');
  });

  it('an assist timeout surfaces as error (a client-side timeout has no job:fail)', () => {
    const { eventBus } = setup();
    act(() => {
      eventBus.get('mark:assist-timeout').next({ resourceId: RID, motivation: 'highlighting' });
    });
    expect(showError).toHaveBeenCalledWith(expect.stringMatching(/timed out/i));
  });

  it('assist timeouts for a different resource are ignored (resourceId filter)', () => {
    const { eventBus } = setup();
    act(() => {
      eventBus.get('mark:assist-timeout').next({ resourceId: 'other-res', motivation: 'highlighting' });
    });
    expect(showError).not.toHaveBeenCalled();
  });
});
