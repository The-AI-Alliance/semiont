/**
 * Admin Users Client - Thin Next.js wrapper
 *
 * This component handles Next.js-specific concerns (translations, API calls, hooks)
 * and delegates rendering to the pure React AdminUsersPage component.
 */

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonStyles, Toolbar, useSemiont } from '@semiont/react-ui';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { useTheme, useBrowseVM, useObservable, useLineNumbers, useEventSubscriptions } from '@semiont/react-ui';
import { AdminUsersPage } from '@semiont/react-ui';
import type { AdminUser, AdminUserStats } from '@semiont/react-ui';
import { createAdminUsersVM } from '@semiont/react-ui';
import { useViewModel } from '@semiont/react-ui';

export default function AdminUsers() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`AdminUsers.${k}`, p as any) as string;

  const semiont = useObservable(useSemiont().activeSession$)?.client;
  const browseVM = useBrowseVM();
  const vm = useViewModel(() => createAdminUsersVM(semiont!, browseVM));

  const activePanel = useObservable(vm.browse.activePanel$) ?? null;
  const users = useObservable(vm.users$) ?? [];
  const userStats = useObservable(vm.stats$) ?? null;
  const usersLoading = useObservable(vm.usersLoading$) ?? true;
  const statsLoading = useObservable(vm.statsLoading$) ?? true;

  const { theme, setTheme } = useTheme();
  const { showLineNumbers, toggleLineNumbers } = useLineNumbers();

  const handleThemeChanged = useCallback(({ theme }: { theme: 'light' | 'dark' | 'system' }) => {
    setTheme(theme);
  }, [setTheme]);

  const handleLineNumbersToggled = useCallback(() => {
    toggleLineNumbers();
  }, [toggleLineNumbers]);

  useEventSubscriptions({
    'settings:theme-changed': handleThemeChanged,
    'settings:line-numbers-toggled': handleLineNumbersToggled,
  });

  const handleUpdateUser = useCallback(async (id: string, data: { isAdmin?: boolean; isActive?: boolean }) => {
    try {
      await vm.updateUser(id, data);
    } catch (error) {
      console.error('Failed to update user:', error);
    }
  }, [vm]);

  const handleDeleteUser = useCallback(async (id: string) => {
    console.warn('Delete user not implemented:', id);
    alert('Delete user functionality is not currently available');
  }, []);

  const handleAddUser = useCallback(() => {
    console.log('Add user clicked');
  }, []);

  const handleExportUsers = useCallback(() => {
    console.log('Export users clicked');
  }, []);

  return (
    <AdminUsersPage
      users={users as AdminUser[]}
      userStats={userStats as AdminUserStats | null}
      isLoadingUsers={usersLoading}
      isLoadingStats={statsLoading}
      onUpdateUser={handleUpdateUser}
      onDeleteUser={handleDeleteUser}
      onAddUser={handleAddUser}
      onExportUsers={handleExportUsers}
      theme={theme}
      showLineNumbers={showLineNumbers}
      activePanel={activePanel}
      translations={{
        title: t('title'),
        subtitle: t('subtitle'),
        addUser: t('addUser'),
        totalUsers: t('totalUsers'),
        activeUsers: t('activeUsers'),
        administrators: t('administrators'),
        recentUsers: t('recentUsers'),
        searchUsers: t('searchUsers'),
        searchPlaceholder: t('searchPlaceholder'),
        role: t('role'),
        allRoles: t('allRoles'),
        admin: t('admin'),
        user: t('user'),
        status: t('status'),
        allStatus: t('allStatus'),
        active: t('active'),
        inactive: t('inactive'),
        exportUsers: t('exportUsers'),
        loadingUsers: t('loadingUsers'),
        userColumn: t('userColumn'),
        domainColumn: t('domainColumn'),
        roleColumn: t('roleColumn'),
        statusColumn: t('statusColumn'),
        lastLoginColumn: t('lastLoginColumn'),
        joinedColumn: t('joinedColumn'),
        actionsColumn: t('actionsColumn'),
        noUsersFound: t('noUsersFound'),
        noUsersFoundDescription: t('noUsersFoundDescription'),
        noName: t('noName'),
        never: t('never'),
        removeAdmin: t('removeAdmin'),
        makeAdmin: t('makeAdmin'),
        deactivateUser: t('deactivateUser'),
        activateUser: t('activateUser'),
        deleteUser: t('deleteUser'),
      }}
      ToolbarPanels={ToolbarPanels}
      Toolbar={Toolbar}
      buttonStyles={buttonStyles}
    />
  );
}
