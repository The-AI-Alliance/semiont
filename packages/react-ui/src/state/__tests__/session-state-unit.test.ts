import { describe, it, expect, vi } from 'vitest';
import { firstValueFrom } from 'rxjs';
import type { SemiontClient } from '@semiont/sdk';
import { createSessionStateUnit } from '../session-state-unit';

function mockClient(logout?: ReturnType<typeof vi.fn>): SemiontClient {
  return {
    auth: { logout: logout ?? vi.fn().mockResolvedValue(undefined) },
  } as unknown as SemiontClient;
}

describe('createSessionStateUnit', () => {
  it('initializes not logging out', async () => {
    const stateUnit = createSessionStateUnit(mockClient());
    expect(await firstValueFrom(stateUnit.isLoggingOut$)).toBe(false);
    stateUnit.dispose();
  });

  it('logout calls client.logout', async () => {
    const logout = vi.fn().mockResolvedValue(undefined);
    const stateUnit = createSessionStateUnit(mockClient(logout));
    await stateUnit.logout();
    expect(logout).toHaveBeenCalledOnce();
    expect(await firstValueFrom(stateUnit.isLoggingOut$)).toBe(false);
    stateUnit.dispose();
  });

  it('logout resets isLoggingOut on error', async () => {
    const logout = vi.fn().mockRejectedValue(new Error('network'));
    const stateUnit = createSessionStateUnit(mockClient(logout));
    await stateUnit.logout();
    expect(await firstValueFrom(stateUnit.isLoggingOut$)).toBe(false);
    stateUnit.dispose();
  });
});
