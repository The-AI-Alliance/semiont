'use client';

/**
 * Admin Users Client - Thin Next.js wrapper
 *
 * This component handles Next.js-specific concerns (translations, API calls, hooks)
 * and delegates rendering to the pure React AdminUsersPage component.
 */

import React from 'react';
import { useTranslations } from 'next-intl';
import { useAdmin, buttonStyles, Toolbar } from '@semiont/react-ui';
import type { paths } from '@semiont/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { useTheme, useToolbar, useLineNumbers } from '@semiont/react-ui';
import { AdminUsersPage } from '@/features/admin-users/components/AdminUsersPage';
import type { AdminUser, AdminUserStats } from '@/features/admin-users/components/AdminUsersPage';

type ResponseContent<T> = T extends { responses: { 200: { content: { 'application/json': infer R } } } } ? R : never;
type AdminUsersResponse = ResponseContent<paths['/api/admin/users']['get']>;
type AdminUserStatsResponse = ResponseContent<paths['/api/admin/users/stats']['get']>;

export default function AdminUsers() {
  const t = useTranslations('AdminUsers');
  const queryClient = useQueryClient();

  // Toolbar and settings state
  const { activePanel, togglePanel } = useToolbar();
  const { theme, setTheme } = useTheme();
  const { showLineNumbers, toggleLineNumbers } = useLineNumbers();

  // API hooks
  const adminAPI = useAdmin();
  const { data: usersResponse, isLoading: usersLoading } = adminAPI.users.list.useQuery();
  const { data: statsResponse, isLoading: statsLoading } = adminAPI.users.stats.useQuery();
  const updateUserMutation = adminAPI.users.update.useMutation();

  const users = (usersResponse as AdminUsersResponse | undefined)?.users ?? [];
  const userStats = (statsResponse as AdminUserStatsResponse | undefined)?.stats ?? null;

  const handleUpdateUser = async (id: string, data: { isAdmin?: boolean; isActive?: boolean }) => {
    try {
      await updateUserMutation.mutateAsync({ id, data });
      queryClient.invalidateQueries({ queryKey: ['admin.users.list'] });
      queryClient.invalidateQueries({ queryKey: ['admin.users.stats'] });
    } catch (error) {
      console.error('Failed to update user:', error);
    }
  };

  const handleDeleteUser = async (id: string) => {
    console.warn('Delete user not implemented:', id);
    alert('Delete user functionality is not currently available');
  };

  const handleAddUser = () => {
    console.log('Add user clicked');
  };

  const handleExportUsers = () => {
    console.log('Export users clicked');
  };

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
      onThemeChange={setTheme}
      showLineNumbers={showLineNumbers}
      onLineNumbersToggle={toggleLineNumbers}
      activePanel={activePanel}
      onPanelToggle={togglePanel}
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
