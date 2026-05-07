import { describe, it, expect, vi } from 'vitest';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';
import { resourceId as makeResourceId } from '@semiont/core';
import type { SemiontClient } from '@semiont/sdk';
import { createResourceLoaderStateUnit } from '../resource-loader-state-unit';

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

describe('createResourceLoaderStateUnit', () => {
  it('exposes resource from browse namespace', async () => {
    const stateUnit = createResourceLoaderStateUnit(mockClient(), RID);
    const resource = await firstValueFrom(stateUnit.resource$.pipe(filter((r) => r !== undefined)));
    expect((resource as { name: string }).name).toBe('Test');
    stateUnit.dispose();
  });

  it('reports loading when resource is undefined', async () => {
    const subject = new BehaviorSubject<unknown>(undefined);
    const stateUnit = createResourceLoaderStateUnit(mockClient(subject), RID);
    expect(await firstValueFrom(stateUnit.isLoading$)).toBe(true);

    subject.next({ '@id': 'res-1' });
    expect(await firstValueFrom(stateUnit.isLoading$.pipe(filter((l) => !l)))).toBe(false);
    stateUnit.dispose();
  });

  it('invalidate calls browse.invalidateResourceDetail', () => {
    const client = mockClient();
    const stateUnit = createResourceLoaderStateUnit(client, RID);
    stateUnit.invalidate();
    expect(client.browse.invalidateResourceDetail).toHaveBeenCalledWith(RID);
    stateUnit.dispose();
  });
});
