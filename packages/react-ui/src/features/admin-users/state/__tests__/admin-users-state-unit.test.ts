import { describe, it, expect, vi } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';
import type { SemiontClient } from '@semiont/sdk';
import type { ShellStateUnit } from '../../../../state/shell-state-unit';
import { createAdminUsersStateUnit } from '../admin-users-state-unit';

function mockBrowse(): ShellStateUnit {
  return { dispose: vi.fn() } as unknown as ShellStateUnit;
}

function mockClient(overrides: {
  listUsers?: ReturnType<typeof vi.fn>;
  getUserStats?: ReturnType<typeof vi.fn>;
  updateUser?: ReturnType<typeof vi.fn>;
} = {}): SemiontClient {
  return {
    admin: {
      users: overrides.listUsers ?? vi.fn().mockResolvedValue({ users: [] }),
      userStats: overrides.getUserStats ?? vi.fn().mockResolvedValue({ stats: null }),
      updateUser: overrides.updateUser ?? vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as SemiontClient;
}

describe('createAdminUsersStateUnit', () => {
  it('fetches users and stats on creation', async () => {
    const listUsers = vi.fn().mockResolvedValue({ users: [{ id: 'u1' }] });
    const getUserStats = vi.fn().mockResolvedValue({ stats: { total: 1 } });
    const stateUnit = createAdminUsersStateUnit(mockClient({ listUsers, getUserStats }), mockBrowse());

    const users = await firstValueFrom(stateUnit.users$.pipe(filter((u) => u.length > 0)));
    expect(users).toEqual([{ id: 'u1' }]);

    const stats = await firstValueFrom(stateUnit.stats$.pipe(filter((s) => s !== null)));
    expect(stats).toEqual({ total: 1 });

    stateUnit.dispose();
  });

  it('starts with loading true, resolves to false', async () => {
    const stateUnit = createAdminUsersStateUnit(mockClient(), mockBrowse());

    await firstValueFrom(stateUnit.usersLoading$.pipe(filter((l) => !l)));
    await firstValueFrom(stateUnit.statsLoading$.pipe(filter((l) => !l)));

    stateUnit.dispose();
  });

  it('sets loading false on fetch error', async () => {
    const listUsers = vi.fn().mockRejectedValue(new Error('fail'));
    const getUserStats = vi.fn().mockRejectedValue(new Error('fail'));
    const stateUnit = createAdminUsersStateUnit(mockClient({ listUsers, getUserStats }), mockBrowse());

    await firstValueFrom(stateUnit.usersLoading$.pipe(filter((l) => !l)));
    await firstValueFrom(stateUnit.statsLoading$.pipe(filter((l) => !l)));

    stateUnit.dispose();
  });

  it('updateUser calls client and refetches', async () => {
    const listUsers = vi.fn().mockResolvedValue({ users: [] });
    const getUserStats = vi.fn().mockResolvedValue({ stats: null });
    const updateUser = vi.fn().mockResolvedValue(undefined);
    const stateUnit = createAdminUsersStateUnit(mockClient({ listUsers, getUserStats, updateUser }), mockBrowse());

    await firstValueFrom(stateUnit.usersLoading$.pipe(filter((l) => !l)));
    listUsers.mockClear();
    getUserStats.mockClear();

    await stateUnit.updateUser('u1', { isAdmin: true });

    expect(updateUser).toHaveBeenCalledOnce();
    expect(listUsers).toHaveBeenCalledOnce();
    expect(getUserStats).toHaveBeenCalledOnce();

    stateUnit.dispose();
  });

  it('disposes browse on dispose', () => {
    const browse = mockBrowse();
    const stateUnit = createAdminUsersStateUnit(mockClient(), browse);
    stateUnit.dispose();
    expect(browse.dispose).toHaveBeenCalled();
  });
});
