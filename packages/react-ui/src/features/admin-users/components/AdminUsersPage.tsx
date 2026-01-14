/**
 * AdminUsersPage Component
 *
 * Pure React component for the admin users management page.
 * All dependencies passed as props - no Next.js hooks!
 */

import React, { useState } from 'react';
import {
  PlusIcon,
  MagnifyingGlassIcon,
  UserCircleIcon,
  ShieldCheckIcon,
  ExclamationTriangleIcon,
  PencilIcon,
  TrashIcon
} from '@heroicons/react/24/outline';

// Define types locally to avoid import dependencies
export interface AdminUser {
  id: string;
  email: string;
  name?: string | null;
  domain: string;
  isAdmin: boolean;
  isActive: boolean;
  lastLogin?: string | null;
  created: string;
}

export interface AdminUserStats {
  totalUsers: number;
  activeUsers: number;
  adminUsers: number;
  recentSignups: string[];
}

function UserTableRow({
  user,
  onUpdate,
  onDelete,
  translations: t
}: {
  user: AdminUser;
  onUpdate: (id: string, data: { isAdmin?: boolean; isActive?: boolean }) => void;
  onDelete: (id: string) => void;
  translations: {
    noName: string;
    admin: string;
    user: string;
    active: string;
    inactive: string;
    never: string;
    removeAdmin: string;
    makeAdmin: string;
    deactivateUser: string;
    activateUser: string;
    deleteUser: string;
  };
}) {
  const roleClasses = {
    admin: 'semiont-badge semiont-badge--danger',
    user: 'semiont-badge semiont-badge--default'
  };

  const statusClasses = {
    active: 'semiont-badge semiont-badge--success',
    inactive: 'semiont-badge semiont-badge--default'
  };

  const role = user.isAdmin ? 'admin' : 'user';
  const status = user.isActive ? 'active' : 'inactive';

  return (
    <tr className="semiont-table__row">
      <td className="semiont-table__cell">
        <div className="semiont-user-info">
          <UserCircleIcon className="semiont-user-info__avatar" />
          <div>
            <div className="semiont-user-info__name">
              {user.name || t.noName}
            </div>
            <div className="semiont-user-info__email">
              {user.email}
            </div>
          </div>
        </div>
      </td>
      <td className="semiont-table__cell">
        <span className="semiont-table__text--secondary">
          @{user.domain}
        </span>
      </td>
      <td className="semiont-table__cell">
        <span className={roleClasses[role]}>
          {t[role]}
        </span>
      </td>
      <td className="semiont-table__cell">
        <span className={statusClasses[status]}>
          {t[status]}
        </span>
      </td>
      <td className="semiont-table__cell semiont-table__text--secondary">
        {user.lastLogin ? new Date(user.lastLogin).toLocaleDateString() : t.never}
      </td>
      <td className="semiont-table__cell semiont-table__text--secondary">
        {new Date(user.created).toLocaleDateString()}
      </td>
      <td className="semiont-table__cell semiont-table__cell--actions">
        <div className="semiont-table__actions">
          <button
            onClick={() => onUpdate(user.id, { isAdmin: !user.isAdmin })}
            className="semiont-action-button semiont-action-button--info"
            title={user.isAdmin ? t.removeAdmin : t.makeAdmin}
          >
            <ShieldCheckIcon className="semiont-action-button__icon" />
          </button>
          <button
            onClick={() => onUpdate(user.id, { isActive: !user.isActive })}
            className="semiont-action-button semiont-action-button--warning"
            title={user.isActive ? t.deactivateUser : t.activateUser}
          >
            <PencilIcon className="semiont-action-button__icon" />
          </button>
          <button
            onClick={() => onDelete(user.id)}
            className="semiont-action-button semiont-action-button--danger"
            title={t.deleteUser}
          >
            <TrashIcon className="semiont-action-button__icon" />
          </button>
        </div>
      </td>
    </tr>
  );
}

export interface AdminUsersPageProps {
  // Data props
  users: AdminUser[];
  userStats: AdminUserStats | null;
  isLoadingUsers: boolean;
  isLoadingStats: boolean;

  // Actions
  onUpdateUser: (id: string, data: { isAdmin?: boolean; isActive?: boolean }) => void;
  onDeleteUser: (id: string) => void;
  onAddUser: () => void;
  onExportUsers: () => void;

  // UI state
  theme: 'light' | 'dark' | 'system';
  onThemeChange: (theme: 'light' | 'dark' | 'system') => void;
  showLineNumbers: boolean;
  onLineNumbersToggle: () => void;
  activePanel: string | null;
  onPanelToggle: (panel: string | null) => void;

  // Translations
  translations: {
    title: string;
    subtitle: string;
    addUser: string;
    totalUsers: string;
    activeUsers: string;
    administrators: string;
    recentUsers: string;
    searchUsers: string;
    searchPlaceholder: string;
    role: string;
    allRoles: string;
    admin: string;
    user: string;
    status: string;
    allStatus: string;
    active: string;
    inactive: string;
    exportUsers: string;
    loadingUsers: string;
    userColumn: string;
    domainColumn: string;
    roleColumn: string;
    statusColumn: string;
    lastLoginColumn: string;
    joinedColumn: string;
    actionsColumn: string;
    noUsersFound: string;
    noUsersFoundDescription: string;
    noName: string;
    never: string;
    removeAdmin: string;
    makeAdmin: string;
    deactivateUser: string;
    activateUser: string;
    deleteUser: string;
  };

  // Component dependencies
  ToolbarPanels: React.ComponentType<any>;
  Toolbar: React.ComponentType<any>;
  buttonStyles: {
    primary: { base: string };
    secondary: { base: string };
  };
}

export function AdminUsersPage({
  users,
  userStats,
  isLoadingUsers,
  isLoadingStats,
  onUpdateUser,
  onDeleteUser,
  onAddUser,
  onExportUsers,
  theme,
  onThemeChange,
  showLineNumbers,
  onLineNumbersToggle,
  activePanel,
  onPanelToggle,
  translations: t,
  ToolbarPanels,
  Toolbar,
  buttonStyles,
}: AdminUsersPageProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRole, setSelectedRole] = useState<string>('all');
  const [selectedStatus, setSelectedStatus] = useState<string>('all');

  const filteredUsers = users.filter((user) => {
    const matchesSearch = (user.name || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
                         user.email.toLowerCase().includes(searchTerm.toLowerCase());
    const userRole = user.isAdmin ? 'admin' : 'user';
    const userStatus = user.isActive ? 'active' : 'inactive';
    const matchesRole = selectedRole === 'all' || userRole === selectedRole;
    const matchesStatus = selectedStatus === 'all' || userStatus === selectedStatus;

    return matchesSearch && matchesRole && matchesStatus;
  });

  return (
    <div className={`semiont-page${activePanel ? ' semiont-page--panel-open' : ''}`}>
      {/* Main Content Area */}
      <div className="semiont-page__content">
        <div className="semiont-page__sections">
          {/* Page Header */}
          <div className="semiont-page__header-with-action">
            <div>
              <h1 className="semiont-page__title">{t.title}</h1>
              <p className="semiont-page__subtitle">
                {t.subtitle}
              </p>
            </div>
            <button onClick={onAddUser} className={buttonStyles.primary.base}>
              <PlusIcon className="semiont-button__icon" />
              {t.addUser}
            </button>
          </div>

          {/* Stats Cards */}
          <div className="semiont-admin__stats-grid">
            {isLoadingStats ? (
              Array(4).fill(0).map((_, i) => (
                <div key={i} className="semiont-stat-card semiont-stat-card--loading">
                  <div className="semiont-stat-card__content">
                    <div className="semiont-skeleton semiont-skeleton--icon"></div>
                    <div className="semiont-stat-card__text">
                      <div className="semiont-skeleton semiont-skeleton--text"></div>
                      <div className="semiont-skeleton semiont-skeleton--number"></div>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <>
                <div className="semiont-stat-card">
                  <div className="semiont-stat-card__content">
                    <div className="semiont-stat-card__icon-wrapper">
                      <UserCircleIcon className="semiont-stat-card__icon semiont-stat-card__icon--primary" />
                    </div>
                    <div className="semiont-stat-card__text">
                      <p className="semiont-stat-card__label">{t.totalUsers}</p>
                      <p className="semiont-stat-card__value">{userStats?.totalUsers ?? 0}</p>
                    </div>
                  </div>
                </div>

                <div className="semiont-stat-card">
                  <div className="semiont-stat-card__content">
                    <div className="semiont-stat-card__icon-wrapper">
                      <div className="semiont-stat-card__status-indicator semiont-stat-card__status-indicator--active">
                        <div className="semiont-stat-card__status-dot"></div>
                      </div>
                    </div>
                    <div className="semiont-stat-card__text">
                      <p className="semiont-stat-card__label">{t.activeUsers}</p>
                      <p className="semiont-stat-card__value">{userStats?.activeUsers ?? 0}</p>
                    </div>
                  </div>
                </div>

                <div className="semiont-stat-card">
                  <div className="semiont-stat-card__content">
                    <div className="semiont-stat-card__icon-wrapper">
                      <ShieldCheckIcon className="semiont-stat-card__icon semiont-stat-card__icon--danger" />
                    </div>
                    <div className="semiont-stat-card__text">
                      <p className="semiont-stat-card__label">{t.administrators}</p>
                      <p className="semiont-stat-card__value">{userStats?.adminUsers ?? 0}</p>
                    </div>
                  </div>
                </div>

                <div className="semiont-stat-card">
                  <div className="semiont-stat-card__content">
                    <div className="semiont-stat-card__icon-wrapper">
                      <ExclamationTriangleIcon className="semiont-stat-card__icon semiont-stat-card__icon--warning" />
                    </div>
                    <div className="semiont-stat-card__text">
                      <p className="semiont-stat-card__label">{t.recentUsers}</p>
                      <p className="semiont-stat-card__value">{userStats?.recentSignups?.length ?? 0}</p>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Filters and Search */}
          <div className="semiont-admin__filters-card">
            <div className="semiont-admin__filters-grid">
              <div className="semiont-form__field">
                <label htmlFor="search" className="semiont-form__label">
                  {t.searchUsers}
                </label>
                <div className="semiont-search-input">
                  <div className="semiont-search-input__icon">
                    <MagnifyingGlassIcon className="semiont-icon semiont-icon--small" />
                  </div>
                  <input
                    type="text"
                    id="search"
                    className="semiont-search-input__field"
                    placeholder={t.searchPlaceholder}
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />
                </div>
              </div>

              <div className="semiont-form__field">
                <label htmlFor="role" className="semiont-form__label">
                  {t.role}
                </label>
                <select
                  id="role"
                  className="semiont-form__select"
                  value={selectedRole}
                  onChange={(e) => setSelectedRole(e.target.value)}
                >
                  <option value="all">{t.allRoles}</option>
                  <option value="admin">{t.admin}</option>
                  <option value="user">{t.user}</option>
                </select>
              </div>

              <div className="semiont-form__field">
                <label htmlFor="status" className="semiont-form__label">
                  {t.status}
                </label>
                <select
                  id="status"
                  className="semiont-form__select"
                  value={selectedStatus}
                  onChange={(e) => setSelectedStatus(e.target.value)}
                >
                  <option value="all">{t.allStatus}</option>
                  <option value="active">{t.active}</option>
                  <option value="inactive">{t.inactive}</option>
                </select>
              </div>

              <div className="semiont-form__field semiont-form__field--align-end">
                <button onClick={onExportUsers} className={`${buttonStyles.secondary.base} semiont-button--full-width`}>
                  {t.exportUsers}
                </button>
              </div>
            </div>
          </div>

          {/* Users Table */}
          <div className="semiont-admin__table-card">
            <div className="semiont-table-container">
              {isLoadingUsers ? (
                <div className="semiont-loading-state">
                  <div className="semiont-spinner"></div>
                  <p className="semiont-loading-state__text">{t.loadingUsers}</p>
                </div>
              ) : (
                <table className="semiont-table">
                  <thead className="semiont-table__head">
                    <tr>
                      <th className="semiont-table__header">
                        {t.userColumn}
                      </th>
                      <th className="semiont-table__header">
                        {t.domainColumn}
                      </th>
                      <th className="semiont-table__header">
                        {t.roleColumn}
                      </th>
                      <th className="semiont-table__header">
                        {t.statusColumn}
                      </th>
                      <th className="semiont-table__header">
                        {t.lastLoginColumn}
                      </th>
                      <th className="semiont-table__header">
                        {t.joinedColumn}
                      </th>
                      <th className="semiont-table__header semiont-table__header--actions">
                        {t.actionsColumn}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="semiont-table__body">
                    {filteredUsers.map((user) => (
                      <UserTableRow
                        key={user.id}
                        user={user}
                        onUpdate={onUpdateUser}
                        onDelete={onDeleteUser}
                        translations={t}
                      />
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {!isLoadingUsers && filteredUsers.length === 0 && (
              <div className="semiont-empty-state">
                <UserCircleIcon className="semiont-empty-state__icon" />
                <h3 className="semiont-empty-state__title">{t.noUsersFound}</h3>
                <p className="semiont-empty-state__description">
                  {t.noUsersFoundDescription}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right Sidebar - Panels and Toolbar */}
      <div className="semiont-page__sidebar">
        <ToolbarPanels
          activePanel={activePanel}
          theme={theme}
          onThemeChange={onThemeChange}
          showLineNumbers={showLineNumbers}
          onLineNumbersToggle={onLineNumbersToggle}
        />

        <Toolbar
          context="simple"
          activePanel={activePanel}
          onPanelToggle={onPanelToggle}
        />
      </div>
    </div>
  );
}
