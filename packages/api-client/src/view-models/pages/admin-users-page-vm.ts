import { BehaviorSubject, type Observable } from 'rxjs';
import { userDID } from '@semiont/core';
import { createDisposer } from '../lib/view-model';
import type { ViewModel } from '../lib/view-model';
import type { BrowseVM } from '../flows/browse-vm';
import type { SemiontApiClient } from '../../client';

export interface AdminUsersPageVM extends ViewModel {
  browse: BrowseVM;
  users$: Observable<unknown[]>;
  stats$: Observable<unknown | null>;
  usersLoading$: Observable<boolean>;
  statsLoading$: Observable<boolean>;
  updateUser(id: string, data: { isAdmin?: boolean; isActive?: boolean }): Promise<void>;
}

export function createAdminUsersPageVM(
  client: SemiontApiClient,
  browse: BrowseVM,
): AdminUsersPageVM {
  const disposer = createDisposer();
  disposer.add(browse);

  const users$ = new BehaviorSubject<unknown[]>([]);
  const stats$ = new BehaviorSubject<unknown | null>(null);
  const usersLoading$ = new BehaviorSubject<boolean>(true);
  const statsLoading$ = new BehaviorSubject<boolean>(true);

  const fetchUsers = () => {
    usersLoading$.next(true);
    client.listUsers()
      .then((data) => {
        users$.next((data as { users?: unknown[] }).users ?? []);
        usersLoading$.next(false);
      })
      .catch(() => usersLoading$.next(false));
  };

  const fetchStats = () => {
    statsLoading$.next(true);
    client.getUserStats()
      .then((data) => {
        stats$.next((data as { stats?: unknown }).stats ?? null);
        statsLoading$.next(false);
      })
      .catch(() => statsLoading$.next(false));
  };

  fetchUsers();
  fetchStats();

  const updateUser = async (id: string, data: { isAdmin?: boolean; isActive?: boolean }): Promise<void> => {
    await client.updateUser(userDID(id), data);
    fetchUsers();
    fetchStats();
  };

  return {
    browse,
    users$: users$.asObservable(),
    stats$: stats$.asObservable(),
    usersLoading$: usersLoading$.asObservable(),
    statsLoading$: statsLoading$.asObservable(),
    updateUser,
    dispose: () => {
      users$.complete();
      stats$.complete();
      usersLoading$.complete();
      statsLoading$.complete();
      disposer.dispose();
    },
  };
}
