import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Observable } from 'rxjs';
import { EventBus, resourceId as makeResourceId } from '@semiont/core';
import type { SemiontApiClient } from '../../../client';
import { createMatchVM } from '../match-vm';

const RID = makeResourceId('res-1');

function mockClient(searchFn: ReturnType<typeof vi.fn>): SemiontApiClient {
  return { match: { search: searchFn } } as unknown as SemiontApiClient;
}

describe('createMatchVM', () => {
  let eventBus: EventBus;

  beforeEach(() => { eventBus = new EventBus(); });
  afterEach(() => { eventBus.destroy(); });

  it('does not call match.search on creation', () => {
    const searchFn = vi.fn();
    const vm = createMatchVM(mockClient(searchFn), eventBus, RID);
    expect(searchFn).not.toHaveBeenCalled();
    vm.dispose();
  });

  it('bridges match:search-requested to match.search()', () => {
    const searchFn = vi.fn(() => new Observable(() => {}));
    const vm = createMatchVM(mockClient(searchFn), eventBus, RID);

    eventBus.get('match:search-requested').next({
      resourceId: RID as string,
      referenceId: 'ref-1',
      context: { annotation: {} } as any,
      correlationId: 'corr-1',
    } as any);

    expect(searchFn).toHaveBeenCalledOnce();
    expect(searchFn).toHaveBeenCalledWith(
      RID,
      'ref-1',
      expect.objectContaining({ annotation: {} }),
      expect.any(Object),
    );
    vm.dispose();
  });

  it('emits match:search-results on successful search', () => {
    const mockResult = { correlationId: 'corr-1', candidates: [{ resourceId: 'r-2', score: 0.9 }] };
    const searchFn = vi.fn(() => new Observable((sub) => {
      sub.next(mockResult);
      sub.complete();
    }));
    const vm = createMatchVM(mockClient(searchFn), eventBus, RID);

    const results: unknown[] = [];
    eventBus.get('match:search-results').subscribe(r => results.push(r));

    eventBus.get('match:search-requested').next({
      resourceId: RID as string,
      referenceId: 'ref-1',
      context: {} as any,
      correlationId: 'corr-1',
    } as any);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(mockResult);
    vm.dispose();
  });

  it('emits match:search-failed on error', () => {
    const searchFn = vi.fn(() => new Observable((sub) => {
      sub.error(new Error('search failed'));
    }));
    const vm = createMatchVM(mockClient(searchFn), eventBus, RID);

    const failures: unknown[] = [];
    eventBus.get('match:search-failed').subscribe(f => failures.push(f));

    eventBus.get('match:search-requested').next({
      resourceId: RID as string,
      referenceId: 'ref-1',
      context: {} as any,
      correlationId: 'corr-1',
    } as any);

    expect(failures).toHaveLength(1);
    expect(failures[0]).toEqual(expect.objectContaining({
      correlationId: 'corr-1',
      referenceId: 'ref-1',
      error: 'search failed',
    }));
    vm.dispose();
  });

  it('emits match:search-failed on timeout when Observable does not complete within 60s', () => {
    vi.useFakeTimers();
    const searchFn = vi.fn(() => new Observable(() => {}));
    const vm = createMatchVM(mockClient(searchFn), eventBus, RID);
    const failures: unknown[] = [];
    eventBus.get('match:search-failed').subscribe(f => failures.push(f));

    eventBus.get('match:search-requested').next({
      resourceId: RID as string,
      referenceId: 'ref-1',
      context: {} as any,
      correlationId: 'corr-1',
    } as any);

    vi.advanceTimersByTime(60_000);
    expect(failures).toHaveLength(1);

    vm.dispose();
    vi.useRealTimers();
  });

  it('stops responding after dispose', () => {
    const searchFn = vi.fn();
    const vm = createMatchVM(mockClient(searchFn), eventBus, RID);
    vm.dispose();

    eventBus.get('match:search-requested').next({
      resourceId: RID as string,
      referenceId: 'ref-1',
      context: {} as any,
      correlationId: 'corr-1',
    } as any);

    expect(searchFn).not.toHaveBeenCalled();
  });
});
