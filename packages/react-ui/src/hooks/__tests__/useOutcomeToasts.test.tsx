import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventBus } from '@semiont/core';
import { useOutcomeToasts } from '../useOutcomeToasts';
import { createTestSemiontWrapper } from '../../test-utils';
import type { ReactNode } from 'react';
import { resourceId } from '@semiont/core';

// The hook's only dependencies are the toast surface and the bus — spy on the
// former, drive the latter through the real subscription path (the wiring:
// channel registration, resourceId filter, severity choice).
// Every string is localized. Echo keys + params so an assertion names
// the KEY that fired, not the sentence — the sentence is copy, and copy moves.
vi.mock('../../contexts/TranslationContext', () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params && Object.keys(params).length
      ? `${key}(${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(',')})`
      : key,
  TranslationProvider: ({ children }: { children: ReactNode }) => children,
}));

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
  jobType: (over.jobType ?? 'mark') as never,
  result: over.result as never,
});

describe('useOutcomeToasts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a clean decline (scanned-PDF no-text-layer) surfaces as info, not success', () => {
    const { eventBus } = setup();
    act(() => {
      eventBus.emit('job:complete', jobComplete({
        result: { declined: true, reason: 'no-text-layer', message: 'This PDF has no extractable text layer (scanned or image-only); detection is not supported.' },
      }) as never);
    });
    expect(showInfo).toHaveBeenCalledWith('decline_no-text-layer');
    expect(showSuccess).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });

  it('a normal annotation completion surfaces as success', () => {
    const { eventBus } = setup();
    act(() => {
      eventBus.emit('job:complete', jobComplete({
        result: { found: 3, persisted: 3 },
      }) as never);
    });
    expect(showSuccess).toHaveBeenCalledWith('annotationComplete');
    expect(showInfo).not.toHaveBeenCalled();
  });

  it('a generation completion surfaces the created resource name', () => {
    const { eventBus } = setup();
    act(() => {
      eventBus.emit('job:complete', jobComplete({
        jobType: 'yield',
        result: { resourceId: 'res-gen', resourceName: 'Cell Biology Notes' },
      }) as never);
    });
    expect(showSuccess).toHaveBeenCalledWith('resourceCreatedNamed(name=Cell Biology Notes)');
  });

  it('completions for a different resource are ignored (resourceId filter)', () => {
    const { eventBus } = setup();
    act(() => {
      eventBus.emit('job:complete', jobComplete({ resourceId: 'other-res' }) as never);
      eventBus.emit('job:fail', { resourceId: 'other-res', jobId: 'job-1', jobType: 'mark', error: 'boom' } as never);
    });
    expect(showSuccess).not.toHaveBeenCalled();
    expect(showInfo).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });

  it('a job failure surfaces as error with the worker message', () => {
    const { eventBus } = setup();
    act(() => {
      eventBus.emit('job:fail', { resourceId: RID, jobId: 'job-1', jobType: 'mark', error: 'inference timed out' } as never);
    });
    expect(showError).toHaveBeenCalledWith('inference timed out');
  });

  it('a local create error toasts once, filtered to this resource', () => {
    const { eventBus } = setup();
    act(() => {
      eventBus.emit('mark:create-error', { resourceId: resourceId(RID), message: 'nope' });
    });
    expect(showError).toHaveBeenCalledWith('createFailed(detail=nope)');
    expect(showError).toHaveBeenCalledTimes(1);
  });

  it('a local delete error toasts, filtered to this resource', () => {
    const { eventBus } = setup();
    act(() => {
      eventBus.emit('mark:delete-error', { resourceId: resourceId(RID), message: 'gone wrong' });
      eventBus.emit('mark:delete-error', { resourceId: resourceId('other-res'), message: 'not mine' });
    });
    expect(showError).toHaveBeenCalledWith('deleteFailed(detail=gone wrong)');
    expect(showError).toHaveBeenCalledTimes(1);
  });

  it('raw wire replies (CommandError) do NOT toast — they are busRequest plumbing', () => {
    // A *-failed reply reaches only the client that made the request and is
    // matched by correlationId in busRequest. Toasting it raw as well would
    // toast the requester twice.
    const { eventBus } = setup();
    act(() => {
      eventBus.emit('mark:create-failed', { message: 'nope' } as never, { correlationId: 'c-1' });
      eventBus.emit('mark:delete-failed', { message: 'nope' } as never, { correlationId: 'c-2' });
    });
    expect(showError).not.toHaveBeenCalled();
  });

  it('bind:body-update-failed (raw wire reply) does NOT toast', () => {
    const { eventBus } = setup();
    act(() => {
      eventBus.emit('bind:body-update-failed', { message: 'nope' } as never, { correlationId: 'c-3' });
    });
    expect(showError).not.toHaveBeenCalled();
  });

  it('a local bind error toasts, filtered to this resource (unlink path)', () => {
    // ReferenceEntry's unlink catch cannot toast directly — it emits the
    // client-local sibling instead.
    const { eventBus } = setup();
    act(() => {
      eventBus.emit('bind:body-error', { resourceId: resourceId(RID), message: 'nope' });
      eventBus.emit('bind:body-error', { resourceId: resourceId('other-res'), message: 'not mine' });
    });
    expect(showError).toHaveBeenCalledWith('referenceUpdateFailed(detail=nope)');
    expect(showError).toHaveBeenCalledTimes(1);
  });

  it('assist silence surfaces as INFO, not error — the job is still running', () => {
    // The client stopping hearing is not the assist failing: silence from a
    // running job is an advisory. A run the UI gives up on can go on to
    // persist its annotations, so an error toast would tell the user
    // something untrue.
    const { eventBus } = setup();
    act(() => {
      eventBus.emit('mark:assist-timeout', { resourceId: resourceId(RID), motivation: 'highlighting' });
    });
    expect(showInfo).toHaveBeenCalledWith('assistQuiet');
    expect(showError).not.toHaveBeenCalled();
  });

  it('assist silence for a different resource is ignored (resourceId filter)', () => {
    const { eventBus } = setup();
    act(() => {
      eventBus.emit('mark:assist-timeout', { resourceId: resourceId('other-res'), motivation: 'highlighting' });
    });
    expect(showInfo).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });
});

/**
 * Partiality reporting (a detection's partial results stand, and its terminal
 * event says how complete it was) lives HERE, on the ephemeral surface — a
 * toast makes no claim of durable resource state, which is all the system can
 * back until the verdict has a schema-named, projected home on the resource
 * (a persistent badge would claim exactly that durable state).
 *
 * The rows mirror the wire's absence discipline: absent underReportedPieces
 * IS the claim of cleanliness (mutation-proven on the emitter) — success copy,
 * never a re-derived count. And a retryable failure toasts NOTHING: the wire
 * calls it "a setback, not an ending", and an error toast on a run that then
 * recovers reports a recovering run as a failed one.
 */
describe('useOutcomeToasts — partiality on the ephemeral surface', () => {
  beforeEach(() => vi.clearAllMocks());

  it('complete with under-reported pieces → info naming the shortfall, not success', () => {
    const { eventBus } = setup();
    act(() => {
      eventBus.emit('job:complete', jobComplete({
        result: { found: 9, persisted: 6, underReportedPieces: 3 },
      }) as never);
    });
    expect(showInfo).toHaveBeenCalledWith('annotationCompletePartial(pieces=3)');
    expect(showSuccess).not.toHaveBeenCalled();
  });

  it('complete with the field ABSENT → plain success; cleanliness is never re-derived', () => {
    const { eventBus } = setup();
    act(() => {
      eventBus.emit('job:complete', jobComplete({
        result: { found: 6, persisted: 6 },
      }) as never);
    });
    expect(showSuccess).toHaveBeenCalledWith('annotationComplete');
    expect(showInfo).not.toHaveBeenCalled();
  });

  it('a RETRYABLE failure toasts nothing — a setback is not an ending', () => {
    const { eventBus } = setup();
    act(() => {
      eventBus.emit('job:fail', {
        resourceId: RID, jobId: 'job-1', jobType: 'mark',
        error: 'transient', willRetry: true,
      } as never);
    });
    expect(showError).not.toHaveBeenCalled();
    expect(showInfo).not.toHaveBeenCalled();
  });

  it('a terminal failure with completed units → error that says the finds were kept', () => {
    const { eventBus } = setup();
    act(() => {
      eventBus.emit('job:fail', {
        resourceId: RID, jobId: 'job-1', jobType: 'mark',
        error: 'boom', willRetry: false, completedUnits: ['Person', 'Place'],
      } as never);
    });
    expect(showError).toHaveBeenCalledWith('annotationFailedPartial(kept=2)');
  });

  it('a terminal failure with nothing completed → the plain failure path, unchanged', () => {
    const { eventBus } = setup();
    act(() => {
      eventBus.emit('job:fail', {
        resourceId: RID, jobId: 'job-1', jobType: 'mark',
        error: 'boom', willRetry: false,
      } as never);
    });
    expect(showError).toHaveBeenCalledWith('boom');
  });
});
