import { describe, it, expect, vi, beforeEach } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';
import type { SemiontApiClient } from '../../../client';
import type { BrowseVM } from '../../flows/browse-vm';
import { createAdminUsersVM } from '../admin-users-vm';

function mockBrowse(): BrowseVM {
  return { dispose: vi.fn() } as unknown as BrowseVM;
}

function mockClient(overrides: {
  listUsers?: ReturnType<typeof vi.fn>;
  getUserStats?: ReturnType<typeof vi.fn>;
  updateUser?: ReturnType<typeof vi.fn>;
} = {}): SemiontApiClient {
  return {
    listUsers: overrides.listUsers ?? vi.fn().mockResolvedValue({ users: [] }),
    getUserStats: overrides.getUserStats ?? vi.fn().mockResolvedValue({ stats: null }),
    updateUser: overrides.updateUser ?? vi.fn().mockResolvedValue(undefined),
  } as unknown as SemiontApiClient;
}

describe('createAdminUsersVM', () => {
  it('fetches users and stats on creation', async () => {
    const listUsers = vi.fn().mockResolvedValue({ users: [{ id: 'u1' }] });
    const getUserStats = vi.fn().mockResolvedValue({ stats: { total: 1 } });
    const vm = createAdminUsersVM(mockClient({ listUsers, getUserStats }), mockBrowse());

    const users = await firstValueFrom(vm.users$.pipe(filter((u) => u.length > 0)));
    expect(users).toEqual([{ id: 'u1' }]);

    const stats = await firstValueFrom(vm.stats$.pipe(filter((s) => s !== null)));
    expect(stats).toEqual({ total: 1 });

    vm.dispose();
  });

  it('starts with loading true, resolves to false', async () => {
    const vm = createAdminUsersVM(mockClient(), mockBrowse());

    await firstValueFrom(vm.usersLoading$.pipe(filter((l) => !l)));
    await firstValueFrom(vm.statsLoading$.pipe(filter((l) => !l)));

    vm.dispose();
  });

  it('sets loading false on fetch error', async () => {
    const listUsers = vi.fn().mockRejectedValue(new Error('fail'));
    const getUserStats = vi.fn().mockRejectedValue(new Error('fail'));
    const vm = createAdminUsersVM(mockClient({ listUsers, getUserStats }), mockBrowse());

    await firstValueFrom(vm.usersLoading$.pipe(filter((l) => !l)));
    await firstValueFrom(vm.statsLoading$.pipe(filter((l) => !l)));

    vm.dispose();
  });

  it('updateUser calls client and refetches', async () => {
    const listUsers = vi.fn().mockResolvedValue({ users: [] });
    const getUserStats = vi.fn().mockResolvedValue({ stats: null });
    const updateUser = vi.fn().mockResolvedValue(undefined);
    const vm = createAdminUsersVM(mockClient({ listUsers, getUserStats, updateUser }), mockBrowse());

    await firstValueFrom(vm.usersLoading$.pipe(filter((l) => !l)));
    listUsers.mockClear();
    getUserStats.mockClear();

    await vm.updateUser('u1', { isAdmin: true });

    expect(updateUser).toHaveBeenCalledOnce();
    expect(listUsers).toHaveBeenCalledOnce();
    expect(getUserStats).toHaveBeenCalledOnce();

    vm.dispose();
  });

  it('disposes browse on dispose', () => {
    const browse = mockBrowse();
    const vm = createAdminUsersVM(mockClient(), browse);
    vm.dispose();
    expect(browse.dispose).toHaveBeenCalled();
  });
});
