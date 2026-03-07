/**
 * Tests for AdminUsersPage component
 *
 * Tests the admin users management page.
 * No Next.js mocking required - all dependencies passed as props!
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AdminUsersPage } from '../components/AdminUsersPage';
import type { AdminUsersPageProps, AdminUser, AdminUserStats } from '../components/AdminUsersPage';

const createMockUser = (overrides?: Partial<AdminUser>): AdminUser => ({
  id: '1',
  email: 'test@example.com',
  name: 'Test User',
  domain: 'example.com',
  isAdmin: false,
  isActive: true,
  lastLogin: '2024-01-01T00:00:00Z',
  created: '2023-01-01T00:00:00Z',
  ...overrides,
});

const createMockStats = (overrides?: Partial<AdminUserStats>): AdminUserStats => ({
  totalUsers: 100,
  activeUsers: 85,
  adminUsers: 5,
  recentSignups: ['user1', 'user2', 'user3'],
  ...overrides,
});

const createMockTranslations = () => ({
  title: 'User Management',
  subtitle: 'Manage user accounts',
  addUser: 'Add User',
  totalUsers: 'Total Users',
  activeUsers: 'Active Users',
  administrators: 'Administrators',
  recentUsers: 'Recent Signups',
  searchUsers: 'Search',
  searchPlaceholder: 'Search by name or email',
  role: 'Role',
  allRoles: 'All Roles',
  admin: 'Admin',
  user: 'User',
  status: 'Status',
  allStatus: 'All Status',
  active: 'Active',
  inactive: 'Inactive',
  exportUsers: 'Export',
  loadingUsers: 'Loading users...',
  userColumn: 'User',
  domainColumn: 'Domain',
  roleColumn: 'Role',
  statusColumn: 'Status',
  lastLoginColumn: 'Last Login',
  joinedColumn: 'Joined',
  actionsColumn: 'Actions',
  noUsersFound: 'No users found',
  noUsersFoundDescription: 'Try adjusting your filters',
  noName: 'No name',
  never: 'Never',
  removeAdmin: 'Remove admin',
  makeAdmin: 'Make admin',
  deactivateUser: 'Deactivate',
  activateUser: 'Activate',
  deleteUser: 'Delete',
});

const createMockProps = (overrides?: Partial<AdminUsersPageProps>): AdminUsersPageProps => ({
  users: [createMockUser()],
  userStats: createMockStats(),
  isLoadingUsers: false,
  isLoadingStats: false,
  onUpdateUser: vi.fn(),
  onDeleteUser: vi.fn(),
  onAddUser: vi.fn(),
  onExportUsers: vi.fn(),
  theme: 'light',
  showLineNumbers: false,
  activePanel: null,
  translations: createMockTranslations(),
  ToolbarPanels: ({ children }: any) => <div data-testid="toolbar-panels">{children}</div>,
  Toolbar: () => <div data-testid="toolbar">Toolbar</div>,
  buttonStyles: {
    primary: { base: 'btn-primary' },
    secondary: { base: 'btn-secondary' },
  },
  ...overrides,
});

describe('AdminUsersPage', () => {
  describe('Basic Rendering', () => {
    it('renders page title and subtitle', () => {
      const props = createMockProps();
      render(<AdminUsersPage {...props} />);

      expect(screen.getByText('User Management')).toBeInTheDocument();
      expect(screen.getByText('Manage user accounts')).toBeInTheDocument();
    });

    it('renders add user button', () => {
      const props = createMockProps();
      render(<AdminUsersPage {...props} />);

      expect(screen.getByRole('button', { name: 'Add User' })).toBeInTheDocument();
    });

    it('calls onAddUser when add button clicked', () => {
      const onAddUser = vi.fn();
      const props = createMockProps({ onAddUser });
      render(<AdminUsersPage {...props} />);

      fireEvent.click(screen.getByRole('button', { name: 'Add User' }));
      expect(onAddUser).toHaveBeenCalledTimes(1);
    });
  });

  describe('Stats Cards', () => {
    it('renders all stats cards', () => {
      const props = createMockProps();
      render(<AdminUsersPage {...props} />);

      expect(screen.getByText('Total Users')).toBeInTheDocument();
      expect(screen.getByText('100')).toBeInTheDocument();
      expect(screen.getByText('Active Users')).toBeInTheDocument();
      expect(screen.getByText('85')).toBeInTheDocument();
      expect(screen.getByText('Administrators')).toBeInTheDocument();
      expect(screen.getByText('5')).toBeInTheDocument();
      expect(screen.getByText('Recent Signups')).toBeInTheDocument();
      expect(screen.getByText('3')).toBeInTheDocument();
    });

    it('shows loading skeleton when stats loading', () => {
      const props = createMockProps({ isLoadingStats: true });
      const { container } = render(<AdminUsersPage {...props} />);

      const skeletons = container.querySelectorAll('.semiont-skeleton');
      expect(skeletons.length).toBeGreaterThan(0);
    });
  });

  describe('Search and Filters', () => {
    it('renders search input', () => {
      const props = createMockProps();
      render(<AdminUsersPage {...props} />);

      expect(screen.getByLabelText('Search')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Search by name or email')).toBeInTheDocument();
    });

    it('renders role filter', () => {
      const props = createMockProps();
      render(<AdminUsersPage {...props} />);

      expect(screen.getByLabelText('Role')).toBeInTheDocument();
    });

    it('renders status filter', () => {
      const props = createMockProps();
      render(<AdminUsersPage {...props} />);

      expect(screen.getByLabelText('Status')).toBeInTheDocument();
    });

    it('filters users by search term', () => {
      const props = createMockProps({
        users: [
          createMockUser({ id: '1', name: 'Alice', email: 'alice@example.com' }),
          createMockUser({ id: '2', name: 'Bob', email: 'bob@example.com' }),
        ],
      });
      render(<AdminUsersPage {...props} />);

      const searchInput = screen.getByPlaceholderText('Search by name or email');
      fireEvent.change(searchInput, { target: { value: 'alice' } });

      expect(screen.getByText('Alice')).toBeInTheDocument();
      expect(screen.queryByText('Bob')).not.toBeInTheDocument();
    });

    it('filters users by role', () => {
      const props = createMockProps({
        users: [
          createMockUser({ id: '1', name: 'Admin User', isAdmin: true }),
          createMockUser({ id: '2', name: 'Regular User', isAdmin: false }),
        ],
      });
      render(<AdminUsersPage {...props} />);

      const roleFilter = screen.getByLabelText('Role');
      fireEvent.change(roleFilter, { target: { value: 'admin' } });

      expect(screen.getByText('Admin User')).toBeInTheDocument();
      expect(screen.queryByText('Regular User')).not.toBeInTheDocument();
    });

    it('filters users by status', () => {
      const props = createMockProps({
        users: [
          createMockUser({ id: '1', name: 'Active User', isActive: true }),
          createMockUser({ id: '2', name: 'Inactive User', isActive: false }),
        ],
      });
      render(<AdminUsersPage {...props} />);

      const statusFilter = screen.getByLabelText('Status');
      fireEvent.change(statusFilter, { target: { value: 'inactive' } });

      expect(screen.getByText('Inactive User')).toBeInTheDocument();
      expect(screen.queryByText('Active User')).not.toBeInTheDocument();
    });

    it('calls onExportUsers when export button clicked', () => {
      const onExportUsers = vi.fn();
      const props = createMockProps({ onExportUsers });
      render(<AdminUsersPage {...props} />);

      fireEvent.click(screen.getByRole('button', { name: 'Export' }));
      expect(onExportUsers).toHaveBeenCalledTimes(1);
    });
  });

  describe('Users Table', () => {
    it('renders table headers', () => {
      const props = createMockProps();
      const { container } = render(<AdminUsersPage {...props} />);

      // Check headers in the table thead
      const headers = container.querySelectorAll('thead th');
      expect(headers.length).toBe(7);
      expect(screen.getByRole('columnheader', { name: 'User' })).toBeInTheDocument();
      expect(screen.getByRole('columnheader', { name: 'Domain' })).toBeInTheDocument();
      expect(screen.getByRole('columnheader', { name: 'Role' })).toBeInTheDocument();
      expect(screen.getByRole('columnheader', { name: 'Status' })).toBeInTheDocument();
    });

    it('renders user data', () => {
      const props = createMockProps();
      render(<AdminUsersPage {...props} />);

      expect(screen.getByText('Test User')).toBeInTheDocument();
      expect(screen.getByText('test@example.com')).toBeInTheDocument();
      expect(screen.getByText('@example.com')).toBeInTheDocument();
    });

    it('shows loading state', () => {
      const props = createMockProps({ isLoadingUsers: true });
      render(<AdminUsersPage {...props} />);

      expect(screen.getByText('Loading users...')).toBeInTheDocument();
    });

    it('shows empty state when no users match filters', () => {
      const props = createMockProps({ users: [] });
      render(<AdminUsersPage {...props} />);

      expect(screen.getByText('No users found')).toBeInTheDocument();
      expect(screen.getByText('Try adjusting your filters')).toBeInTheDocument();
    });
  });

  describe('User Actions', () => {
    it('calls onUpdateUser when toggling admin status', () => {
      const onUpdateUser = vi.fn();
      const props = createMockProps({ onUpdateUser });
      render(<AdminUsersPage {...props} />);

      const adminButton = screen.getByTitle('Make admin');
      fireEvent.click(adminButton);

      expect(onUpdateUser).toHaveBeenCalledWith('1', { isAdmin: true });
    });

    it('calls onUpdateUser when toggling active status', () => {
      const onUpdateUser = vi.fn();
      const props = createMockProps({ onUpdateUser });
      render(<AdminUsersPage {...props} />);

      const activateButton = screen.getByTitle('Deactivate');
      fireEvent.click(activateButton);

      expect(onUpdateUser).toHaveBeenCalledWith('1', { isActive: false });
    });

    it('calls onDeleteUser when delete button clicked', () => {
      const onDeleteUser = vi.fn();
      const props = createMockProps({ onDeleteUser });
      render(<AdminUsersPage {...props} />);

      const deleteButton = screen.getByTitle('Delete');
      fireEvent.click(deleteButton);

      expect(onDeleteUser).toHaveBeenCalledWith('1');
    });
  });

  describe('User Display', () => {
    it('shows user name or fallback', () => {
      const props = createMockProps({
        users: [createMockUser({ name: null })],
      });
      render(<AdminUsersPage {...props} />);

      expect(screen.getByText('No name')).toBeInTheDocument();
    });

    it('displays admin role badge', () => {
      const props = createMockProps({
        users: [createMockUser({ isAdmin: true })],
      });
      const { container } = render(<AdminUsersPage {...props} />);

      // Find badge in table row
      const roleBadge = container.querySelector('tbody .semiont-badge--danger');
      expect(roleBadge).toBeInTheDocument();
      expect(roleBadge).toHaveTextContent('Admin');
    });

    it('displays user role badge', () => {
      const props = createMockProps({
        users: [createMockUser({ isAdmin: false })],
      });
      const { container } = render(<AdminUsersPage {...props} />);

      // Find User badge in table row (not "User" column header)
      const roleBadge = container.querySelector('tbody td:nth-child(3) .semiont-badge--default');
      expect(roleBadge).toBeInTheDocument();
      expect(roleBadge).toHaveTextContent('User');
    });

    it('displays active status badge', () => {
      const props = createMockProps({
        users: [createMockUser({ isActive: true })],
      });
      const { container } = render(<AdminUsersPage {...props} />);

      // Find badge in table row (not in stats card which also says "Active Users")
      const tableBadge = container.querySelector('tbody .semiont-badge--success');
      expect(tableBadge).toBeInTheDocument();
      expect(tableBadge).toHaveTextContent('Active');
    });

    it('displays inactive status badge', () => {
      const props = createMockProps({
        users: [createMockUser({ isActive: false })],
      });
      const { container } = render(<AdminUsersPage {...props} />);

      // Find badge in table row status column
      const statusBadge = container.querySelector('tbody td:nth-child(4) .semiont-badge--default');
      expect(statusBadge).toBeInTheDocument();
      expect(statusBadge).toHaveTextContent('Inactive');
    });

    it('shows never for users without last login', () => {
      const props = createMockProps({
        users: [createMockUser({ lastLogin: null })],
      });
      render(<AdminUsersPage {...props} />);

      expect(screen.getByText('Never')).toBeInTheDocument();
    });
  });

  describe('Toolbar Integration', () => {
    it('renders toolbar panels', () => {
      const props = createMockProps();
      render(<AdminUsersPage {...props} />);

      expect(screen.getByTestId('toolbar-panels')).toBeInTheDocument();
    });

    it('renders toolbar', () => {
      const props = createMockProps();
      render(<AdminUsersPage {...props} />);

      expect(screen.getByTestId('toolbar')).toBeInTheDocument();
    });
  });
});
