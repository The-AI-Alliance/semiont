import { describe, it, expect, vi } from 'vitest';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';
import { resourceId as makeResourceId } from '@semiont/core';
import type { SemiontClient } from '../../../client';
import { createResourceLoaderVM } from '../resource-loader-vm';

const RID = makeResourceId('res-1');

function mockClient(resource$?: BehaviorSubject<unknown>): SemiontClient {
  const subject = resource$ ?? new BehaviorSubject<unknown>({ '@id': 'res-1', name: 'Test' });
  const invalidate = vi.fn();
  return {
    browse: {
      resource: () => subject.asObservable(),
      invalidateResourceDetail: invalidate,
    },
  } as unknown as SemiontClient;
}

describe('createResourceLoaderVM', () => {
  it('exposes resource from browse namespace', async () => {
    const vm = createResourceLoaderVM(mockClient(), RID);
    const resource = await firstValueFrom(vm.resource$.pipe(filter((r) => r !== undefined)));
    expect((resource as { name: string }).name).toBe('Test');
    vm.dispose();
  });

  it('reports loading when resource is undefined', async () => {
    const subject = new BehaviorSubject<unknown>(undefined);
    const vm = createResourceLoaderVM(mockClient(subject), RID);
    expect(await firstValueFrom(vm.isLoading$)).toBe(true);

    subject.next({ '@id': 'res-1' });
    expect(await firstValueFrom(vm.isLoading$.pipe(filter((l) => !l)))).toBe(false);
    vm.dispose();
  });

  it('invalidate calls browse.invalidateResourceDetail', () => {
    const client = mockClient();
    const vm = createResourceLoaderVM(client, RID);
    vm.invalidate();
    expect(client.browse.invalidateResourceDetail).toHaveBeenCalledWith(RID);
    vm.dispose();
  });
});
