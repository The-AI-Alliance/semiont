import { describe, it, expect, vi } from 'vitest';
import { firstValueFrom } from 'rxjs';
import type { SemiontClient } from '../../../client';
import { createSessionVM } from '../session-vm';

function mockClient(logout?: ReturnType<typeof vi.fn>): SemiontClient {
  return {
    auth: { logout: logout ?? vi.fn().mockResolvedValue(undefined) },
  } as unknown as SemiontClient;
}

describe('createSessionVM', () => {
  it('initializes not logging out', async () => {
    const vm = createSessionVM(mockClient());
    expect(await firstValueFrom(vm.isLoggingOut$)).toBe(false);
    vm.dispose();
  });

  it('logout calls client.logout', async () => {
    const logout = vi.fn().mockResolvedValue(undefined);
    const vm = createSessionVM(mockClient(logout));
    await vm.logout();
    expect(logout).toHaveBeenCalledOnce();
    expect(await firstValueFrom(vm.isLoggingOut$)).toBe(false);
    vm.dispose();
  });

  it('logout resets isLoggingOut on error', async () => {
    const logout = vi.fn().mockRejectedValue(new Error('network'));
    const vm = createSessionVM(mockClient(logout));
    await vm.logout();
    expect(await firstValueFrom(vm.isLoggingOut$)).toBe(false);
    vm.dispose();
  });
});
