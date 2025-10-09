'use client';

import React from 'react';
import {
  PlusIcon,
  MagnifyingGlassIcon,
  UserCircleIcon,
  ShieldCheckIcon,
  ExclamationTriangleIcon,
  PencilIcon,
  TrashIcon
} from '@heroicons/react/24/outline';
import { useState, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import { api, type AdminUser, type AdminUsersResponse, type AdminUserStatsResponse } from '@/lib/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { buttonStyles } from '@/lib/button-styles';
import { Toolbar } from '@/components/Toolbar';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { useTheme } from '@/hooks/useTheme';
import { useToolbar } from '@/hooks/useToolbar';
import { useLineNumbers } from '@/hooks/useLineNumbers';
function UserTableRow({ 
  user, 
  onUpdate, 
  onDelete 
}: { 
  user: AdminUser; 
  onUpdate: (id: string, data: { isAdmin?: boolean; isActive?: boolean }) => void;
  onDelete: (id: string) => void;
}) {
  const roleColors = {
    admin: 'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-300',
    user: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300'
  };

  const statusColors = {
    active: 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-300',
    inactive: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300'
  };

  const role = user.isAdmin ? 'admin' : 'user';
  const status = user.isActive ? 'active' : 'inactive';

  return (
    <tr className="hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
      <td className="px-6 py-4 whitespace-nowrap">
        <div className="flex items-center">
          <UserCircleIcon className="h-8 w-8 text-gray-600 dark:text-gray-400 mr-3" />
          <div>
            <div className="text-sm font-medium text-gray-900 dark:text-white">
              {user.name || 'No name'}
            </div>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {user.email}
            </div>
          </div>
        </div>
      </td>
      <td className="px-6 py-4 whitespace-nowrap">
        <span className="text-sm text-gray-600 dark:text-gray-400">
          @{user.domain}
        </span>
      </td>
      <td className="px-6 py-4 whitespace-nowrap">
        <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${roleColors[role]}`}>
          {role}
        </span>
      </td>
      <td className="px-6 py-4 whitespace-nowrap">
        <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${statusColors[status]}`}>
          {status}
        </span>
      </td>
      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
        {user.lastLogin ? new Date(user.lastLogin).toLocaleDateString() : 'Never'}
      </td>
      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
        {new Date(user.created).toLocaleDateString()}
      </td>
      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
        <div className="flex items-center justify-end space-x-2">
          <button 
            onClick={() => onUpdate(user.id, { isAdmin: !user.isAdmin })}
            className="text-blue-600 hover:text-blue-900 dark:text-blue-400 dark:hover:text-blue-300"
            title={user.isAdmin ? 'Remove admin' : 'Make admin'}
          >
            <ShieldCheckIcon className="h-4 w-4" />
          </button>
          <button 
            onClick={() => onUpdate(user.id, { isActive: !user.isActive })}
            className="text-yellow-600 hover:text-yellow-900 dark:text-yellow-400 dark:hover:text-yellow-300"
            title={user.isActive ? 'Deactivate user' : 'Activate user'}
          >
            <PencilIcon className="h-4 w-4" />
          </button>
          <button 
            onClick={() => onDelete(user.id)}
            className="text-red-600 hover:text-red-900 dark:text-red-400 dark:hover:text-red-300"
            title="Delete user"
          >
            <TrashIcon className="h-4 w-4" />
          </button>
        </div>
      </td>
    </tr>
  );
}

export default function AdminUsers() {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRole, setSelectedRole] = useState<string>('all');
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const { data: session } = useSession();
  const isAuthenticated = !!session?.backendToken;

  // Toolbar and settings state
  const { activePanel, togglePanel } = useToolbar();
  const { theme, setTheme } = useTheme();
  const { showLineNumbers, toggleLineNumbers } = useLineNumbers();

  // Debug logging
  React.useEffect(() => {
    console.log('Admin Users Component - Auth Status:', { isAuthenticated });
  }, [isAuthenticated]);

  const queryClient = useQueryClient();
  // Only run queries when authenticated
  const { data: usersResponse, isLoading: usersLoading, error: usersError } = api.admin.users.all.useQuery();
  const { data: statsResponse, isLoading: statsLoading, error: statsError } = api.admin.users.stats.useQuery();
  
  // Debug logging for API responses
  React.useEffect(() => {
    if (usersError) console.error('Users API Error:', usersError);
    if (statsError) console.error('Stats API Error:', statsError);
    if (usersResponse) console.log('Users Response:', usersResponse);
    if (statsResponse) console.log('Stats Response:', statsResponse);
  }, [usersError, statsError, usersResponse, statsResponse]);
  const updateUserMutation = api.admin.users.update.useMutation();
  const deleteUserMutation = api.admin.users.delete.useMutation();

  const users = (usersResponse as AdminUsersResponse | undefined)?.users ?? [];
  const userStats = (statsResponse as AdminUserStatsResponse | undefined)?.stats;

  const handleUpdateUser = async (id: string, data: { isAdmin?: boolean; isActive?: boolean }) => {
    try {
      await updateUserMutation.mutateAsync({ id, data });
      // Refresh the data
      queryClient.invalidateQueries({ queryKey: ['admin.users.list'] });
      queryClient.invalidateQueries({ queryKey: ['admin.users.stats'] });
    } catch (error) {
      console.error('Failed to update user:', error);
      // TODO: Show error toast
    }
  };

  const handleDeleteUser = async (id: string) => {
    if (!confirm('Are you sure you want to delete this user? This action cannot be undone.')) {
      return;
    }

    try {
      await deleteUserMutation.mutateAsync(id);
      // Refresh the data
      queryClient.invalidateQueries({ queryKey: ['admin.users.list'] });
      queryClient.invalidateQueries({ queryKey: ['admin.users.stats'] });
    } catch (error) {
      console.error('Failed to delete user:', error);
      // TODO: Show error toast
    }
  };

  const filteredUsers = users.filter((user: AdminUser) => {
    const matchesSearch = (user.name || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
                         user.email.toLowerCase().includes(searchTerm.toLowerCase());
    const userRole = user.isAdmin ? 'admin' : 'user';
    const userStatus = user.isActive ? 'active' : 'inactive';
    const matchesRole = selectedRole === 'all' || userRole === selectedRole;
    const matchesStatus = selectedStatus === 'all' || userStatus === selectedStatus;
    
    return matchesSearch && matchesRole && matchesStatus;
  });

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto px-4 py-8">
        <div className="space-y-6">
          {/* Page Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">User Management</h1>
          <p className="text-gray-600 dark:text-gray-400 mt-1">
            Manage users, permissions, and domain access
          </p>
        </div>
        <button className={`${buttonStyles.primary.base} inline-flex items-center`}>
          <PlusIcon className="-ml-1 mr-2 h-4 w-4" />
          Add User
        </button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        {statsLoading ? (
          Array(4).fill(0).map((_, i) => (
            <div key={i} className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 border border-gray-200 dark:border-gray-700 animate-pulse">
              <div className="flex items-center">
                <div className="h-8 w-8 bg-gray-300 dark:bg-gray-600 rounded"></div>
                <div className="ml-4 flex-1">
                  <div className="h-4 bg-gray-300 dark:bg-gray-600 rounded w-20 mb-2"></div>
                  <div className="h-8 bg-gray-300 dark:bg-gray-600 rounded w-12"></div>
                </div>
              </div>
            </div>
          ))
        ) : (
          <>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 border border-gray-200 dark:border-gray-700">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <UserCircleIcon className="h-8 w-8 text-blue-600 dark:text-blue-400" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-600 dark:text-gray-400">Total Users</p>
              <p className="text-2xl font-semibold text-gray-900 dark:text-white">{userStats?.totalUsers ?? 0}</p>
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 border border-gray-200 dark:border-gray-700">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <div className="w-8 h-8 bg-green-100 dark:bg-green-900/20 rounded-lg flex items-center justify-center">
                <div className="w-3 h-3 bg-green-500 rounded-full"></div>
              </div>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-600 dark:text-gray-400">Active Users</p>
              <p className="text-2xl font-semibold text-gray-900 dark:text-white">{userStats?.activeUsers ?? 0}</p>
            </div>
          </div>
        </div>
        
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 border border-gray-200 dark:border-gray-700">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <ShieldCheckIcon className="h-8 w-8 text-red-600 dark:text-red-400" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-600 dark:text-gray-400">Administrators</p>
              <p className="text-2xl font-semibold text-gray-900 dark:text-white">{userStats?.adminUsers ?? 0}</p>
            </div>
          </div>
        </div>
        
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 border border-gray-200 dark:border-gray-700">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <ExclamationTriangleIcon className="h-8 w-8 text-yellow-600 dark:text-yellow-400" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-600 dark:text-gray-400">Recent Users</p>
              <p className="text-2xl font-semibold text-gray-900 dark:text-white">{userStats?.recentSignups?.length ?? 0}</p>
            </div>
          </div>
        </div>
        </>
        )}
      </div>

      {/* Filters and Search */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 border border-gray-200 dark:border-gray-700">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div>
            <label htmlFor="search" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Search Users
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <MagnifyingGlassIcon className="h-5 w-5 text-gray-600 dark:text-gray-400" />
              </div>
              <input
                type="text"
                id="search"
                className="block w-full pl-10 pr-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md leading-5 bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:placeholder-gray-400 focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                placeholder="Search by name or email..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
          </div>
          
          <div>
            <label htmlFor="role" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Role
            </label>
            <select
              id="role"
              className="block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
              value={selectedRole}
              onChange={(e) => setSelectedRole(e.target.value)}
            >
              <option value="all">All Roles</option>
              <option value="admin">Admin</option>
              <option value="user">User</option>
            </select>
          </div>
          
          <div>
            <label htmlFor="status" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Status
            </label>
            <select
              id="status"
              className="block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
            >
              <option value="all">All Status</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>
          
          <div className="flex items-end">
            <button className={`${buttonStyles.secondary.base} w-full`}>
              Export Users
            </button>
          </div>
        </div>
      </div>

      {/* Users Table */}
      <div className="bg-white dark:bg-gray-800 shadow rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="overflow-x-auto">
          {usersLoading ? (
            <div className="p-6 text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
              <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">Loading users...</p>
            </div>
          ) : (
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-900">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  User
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Domain
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Role
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Last Login
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Joined
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
              {filteredUsers.map((user: AdminUser) => (
                <UserTableRow 
                  key={user.id} 
                  user={user} 
                  onUpdate={handleUpdateUser}
                  onDelete={handleDeleteUser}
                />
              ))}
            </tbody>
          </table>
          )}
        </div>
        
        {!usersLoading && filteredUsers.length === 0 && (
          <div className="p-6 text-center">
            <UserCircleIcon className="mx-auto h-12 w-12 text-gray-600 dark:text-gray-400" />
            <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-white">No users found</h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Try adjusting your search criteria or filters.
            </p>
          </div>
        )}
        </div>
      </div>
      </div>

      {/* Right Sidebar - Panels and Toolbar */}
      <div className="flex">
        <ToolbarPanels
          activePanel={activePanel}
          theme={theme}
          onThemeChange={setTheme}
          showLineNumbers={showLineNumbers}
          onLineNumbersToggle={toggleLineNumbers}
        />

        <Toolbar
          context="simple"
          activePanel={activePanel}
          onPanelToggle={togglePanel}
        />
      </div>
    </div>
  );
}