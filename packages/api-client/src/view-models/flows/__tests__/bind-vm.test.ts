import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBus, resourceId as makeResourceId } from '@semiont/core';
import type { SemiontApiClient } from '../../../client';
import { createBindVM } from '../bind-vm';

const RID = makeResourceId('res-1');

function mockClient(bodyFn: ReturnType<typeof vi.fn>): SemiontApiClient {
  return { bind: { body: bodyFn } } as unknown as SemiontApiClient;
}

describe('createBindVM', () => {
  let eventBus: EventBus;

  beforeEach(() => { eventBus = new EventBus(); });
  afterEach(() => { eventBus.destroy(); });

  it('does not call bind.body on creation', () => {
    const bodyFn = vi.fn();
    const vm = createBindVM(mockClient(bodyFn), eventBus, RID);
    expect(bodyFn).not.toHaveBeenCalled();
    vm.dispose();
  });

  it('bridges bind:update-body to client.bind.body', async () => {
    const bodyFn = vi.fn().mockResolvedValue(undefined);
    const vm = createBindVM(mockClient(bodyFn), eventBus, RID);

    eventBus.get('bind:update-body').next({
      annotationId: 'ann-1',
      operations: [{ op: 'replace', path: '/value', value: 'new' }],
    } as any);

    await vi.waitFor(() => expect(bodyFn).toHaveBeenCalledOnce());
    vm.dispose();
  });

  it('emits bind:body-update-failed on error', async () => {
    const bodyFn = vi.fn().mockRejectedValue(new Error('Network error'));
    const vm = createBindVM(mockClient(bodyFn), eventBus, RID);
    const failures: unknown[] = [];
    eventBus.get('bind:body-update-failed').subscribe(e => failures.push(e));

    eventBus.get('bind:update-body').next({
      annotationId: 'ann-1',
      operations: [{ op: 'replace', path: '/value', value: 'x' }],
    } as any);

    await vi.waitFor(() => expect(failures).toHaveLength(1));
    expect(failures[0]).toEqual(expect.objectContaining({ message: 'Network error' }));
    vm.dispose();
  });

  it('stops responding after dispose', () => {
    const bodyFn = vi.fn();
    const vm = createBindVM(mockClient(bodyFn), eventBus, RID);
    vm.dispose();

    eventBus.get('bind:update-body').next({
      annotationId: 'ann-1',
      operations: [],
    } as any);

    expect(bodyFn).not.toHaveBeenCalled();
  });
});
