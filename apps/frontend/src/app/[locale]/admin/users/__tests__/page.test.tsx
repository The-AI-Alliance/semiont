import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AdminUsers from '../client';
import { useAdmin } from '@semiont/react-ui';

// Mock the API hooks
vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual('@semiont/react-ui');
  return {
    ...actual,
    useAdmin: vi.fn(),
    useTheme: () => ({
      theme: 'system',
      setTheme: vi.fn()
    })
  };
});

// Mock window functions
Object.defineProperty(window, 'confirm', {
  writable: true,
  value: vi.fn()
});

Object.defineProperty(window, 'alert', {
  writable: true,
  value: vi.fn()
});

// Mock the Toolbar component
vi.mock('@/components/Toolbar', () => ({
  Toolbar: () => null
}));

// Mock the SettingsPanel component
vi.mock('@/components/SettingsPanel', () => ({
  SettingsPanel: () => null
}));

// Mock data
const mockUsers = [
  {
    id: '1',
    email: 'admin@company.com',
    name: 'Admin User',
    image: null,
    domain: 'company.com',
    provider: 'google',
    isAdmin: true,
    isActive: true,
    lastLogin: '2023-12-01T10:00:00Z',
    created: '2023-01-01T10:00:00Z',
    updatedAt: '2023-12-01T10:00:00Z'
  },
  {
    id: '2',
    email: 'user@company.com',
    name: 'Regular User',
    image: null,
    domain: 'company.com',
    provider: 'google',
    isAdmin: false,
    isActive: true,
    lastLogin: null,
    created: '2023-06-01T10:00:00Z',
    updatedAt: '2023-06-01T10:00:00Z'
  },
  {
    id: '3',
    email: 'inactive@company.com',
    name: null,
    image: null,
    domain: 'company.com',
    provider: 'google',
    isAdmin: false,
    isActive: false,
    lastLogin: '2023-11-01T10:00:00Z',
    created: '2023-05-01T10:00:00Z',
    updatedAt: '2023-11-01T10:00:00Z'
  }
];

const mockStats = {
  totalUsers: 3,
  activeUsers: 2,
  adminUsers: 1,
  recentSignups: [{ id: '1', name: 'Admin User', email: 'admin@company.com', created: '2023-12-01T10:00:00Z' }]
};

const mockUsersResponse = {
  success: true,
  users: mockUsers
};

const mockStatsResponse = {
  success: true,
  stats: mockStats
};

// Test wrapper with QueryClient
function TestWrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}

describe('AdminUsers Page', () => {
  const mockListQuery = vi.fn();
  const mockStatsQuery = vi.fn();
  const mockUpdateMutation = vi.fn();

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Setup default mock implementations
    mockListQuery.mockReturnValue({
      data: mockUsersResponse,
      isLoading: false,
      error: null
    });

    mockStatsQuery.mockReturnValue({
      data: mockStatsResponse,
      isLoading: false,
      error: null
    });

    mockUpdateMutation.mockReturnValue({
      mutateAsync: vi.fn()
    });

    vi.mocked(useAdmin).mockReturnValue({
      users: {
        list: {
          useQuery: mockListQuery
        },
        stats: {
          useQuery: mockStatsQuery
        },
        update: {
          useMutation: mockUpdateMutation
        }
      },
      oauth: {
        config: {
          useQuery: vi.fn()
        }
      }
    });

    (window.confirm as Mock).mockReturnValue(true);
  });

  describe('Page Structure', () => {
    it('should render the page header correctly', () => {
      render(
        <TestWrapper>
          <AdminUsers />
        </TestWrapper>
      );

      expect(screen.getByText('User Management')).toBeInTheDocument();
      expect(screen.getByText('Manage users, permissions, and domain access')).toBeInTheDocument();
      expect(screen.getByText('Add User')).toBeInTheDocument();
    });

    it('should render stats cards with correct data', () => {
      render(
        <TestWrapper>
          <AdminUsers />
        </TestWrapper>
      );

      expect(screen.getByText('Total Users')).toBeInTheDocument();
      expect(screen.getByText('3')).toBeInTheDocument();
      expect(screen.getByText('Active Users')).toBeInTheDocument();
      expect(screen.getByText('2')).toBeInTheDocument();
      expect(screen.getByText('Administrators')).toBeInTheDocument();
      // Look for "1" in the context of administrators
      const adminCard = screen.getByText('Administrators').closest('.bg-white');
      expect(adminCard).toHaveTextContent('1');
      expect(screen.getByText('Recent Users')).toBeInTheDocument();
    });

    it('should render search and filter controls', () => {
      render(
        <TestWrapper>
          <AdminUsers />
        </TestWrapper>
      );

      expect(screen.getByPlaceholderText('Search by name or email...')).toBeInTheDocument();
      expect(screen.getByDisplayValue('All Roles')).toBeInTheDocument();
      expect(screen.getByDisplayValue('All Status')).toBeInTheDocument();
      expect(screen.getByText('Export Users')).toBeInTheDocument();
    });

  });

  describe('Loading States', () => {
    it('should show loading state for stats', () => {
      mockStatsQuery.mockReturnValue({
        data: null,
        isLoading: true,
        error: null
      });

      render(
        <TestWrapper>
          <AdminUsers />
        </TestWrapper>
      );

      // Should show skeleton loading cards
      expect(document.querySelectorAll('.animate-pulse')).toHaveLength(4);
    });

    it('should show loading state for users table', () => {
      mockListQuery.mockReturnValue({
        data: null,
        isLoading: true,
        error: null
      });

      render(
        <TestWrapper>
          <AdminUsers />
        </TestWrapper>
      );

      expect(screen.getByText('Loading users...')).toBeInTheDocument();
      expect(document.querySelector('.animate-spin')).toBeInTheDocument();
    });
  });

  describe('User Table', () => {
    it('should render all users in the table', () => {
      render(
        <TestWrapper>
          <AdminUsers />
        </TestWrapper>
      );

      expect(screen.getByText('admin@company.com')).toBeInTheDocument();
      expect(screen.getByText('Admin User')).toBeInTheDocument();
      expect(screen.getByText('user@company.com')).toBeInTheDocument();
      expect(screen.getByText('Regular User')).toBeInTheDocument();
      expect(screen.getByText('inactive@company.com')).toBeInTheDocument();
      expect(screen.getByText('No name')).toBeInTheDocument();
    });

    it('should display user roles correctly', () => {
      render(
        <TestWrapper>
          <AdminUsers />
        </TestWrapper>
      );

      // Use more specific selector to find role badges, not button titles
      const adminBadges = screen.getAllByText('admin', { selector: 'span.inline-flex' });
      const userBadges = screen.getAllByText('user', { selector: 'span.inline-flex' });

      expect(adminBadges).toHaveLength(1);
      expect(userBadges).toHaveLength(2);
    });

    it('should display user status correctly', () => {
      render(
        <TestWrapper>
          <AdminUsers />
        </TestWrapper>
      );

      // Use more specific selector to find status badges, not button titles
      const activeBadges = screen.getAllByText('active', { selector: 'span.inline-flex' });
      const inactiveBadges = screen.getAllByText('inactive', { selector: 'span.inline-flex' });

      expect(activeBadges).toHaveLength(2);
      expect(inactiveBadges).toHaveLength(1);
    });

    it('should display last login correctly', () => {
      render(
        <TestWrapper>
          <AdminUsers />
        </TestWrapper>
      );

      expect(screen.getByText('12/1/2023')).toBeInTheDocument();
      expect(screen.getByText('11/1/2023')).toBeInTheDocument();
      expect(screen.getByText('Never')).toBeInTheDocument();
    });

    it('should display domains correctly', () => {
      render(
        <TestWrapper>
          <AdminUsers />
        </TestWrapper>
      );

      const domainElements = screen.getAllByText('@company.com');
      expect(domainElements).toHaveLength(3);
    });
  });

  describe('Search and Filtering', () => {
    it('should filter users by search term (email)', async () => {
      render(
        <TestWrapper>
          <AdminUsers />
        </TestWrapper>
      );

      const searchInput = screen.getByPlaceholderText('Search by name or email...');
      fireEvent.change(searchInput, { target: { value: 'admin@' } });

      // Only the admin user should be visible
      expect(screen.getByText('admin@company.com')).toBeInTheDocument();
      expect(screen.queryByText('user@company.com')).not.toBeInTheDocument();
      expect(screen.queryByText('inactive@company.com')).not.toBeInTheDocument();
    });

    it('should filter users by search term (name)', async () => {
      render(
        <TestWrapper>
          <AdminUsers />
        </TestWrapper>
      );

      const searchInput = screen.getByPlaceholderText('Search by name or email...');
      fireEvent.change(searchInput, { target: { value: 'Regular' } });

      // Only the regular user should be visible
      expect(screen.queryByText('admin@company.com')).not.toBeInTheDocument();
      expect(screen.getByText('user@company.com')).toBeInTheDocument();
      expect(screen.queryByText('inactive@company.com')).not.toBeInTheDocument();
    });

    it('should filter users by role', async () => {
      render(
        <TestWrapper>
          <AdminUsers />
        </TestWrapper>
      );

      const roleSelect = screen.getByDisplayValue('All Roles');
      fireEvent.change(roleSelect, { target: { value: 'admin' } });

      // Only admin users should be visible
      expect(screen.getByText('admin@company.com')).toBeInTheDocument();
      expect(screen.queryByText('user@company.com')).not.toBeInTheDocument();
      expect(screen.queryByText('inactive@company.com')).not.toBeInTheDocument();
    });

    it('should filter users by status', async () => {
      render(
        <TestWrapper>
          <AdminUsers />
        </TestWrapper>
      );

      const statusSelect = screen.getByDisplayValue('All Status');
      fireEvent.change(statusSelect, { target: { value: 'inactive' } });

      // Only inactive users should be visible
      expect(screen.queryByText('admin@company.com')).not.toBeInTheDocument();
      expect(screen.queryByText('user@company.com')).not.toBeInTheDocument();
      expect(screen.getByText('inactive@company.com')).toBeInTheDocument();
    });

    it('should combine search and filters', async () => {
      render(
        <TestWrapper>
          <AdminUsers />
        </TestWrapper>
      );

      const searchInput = screen.getByPlaceholderText('Search by name or email...');
      const statusSelect = screen.getByDisplayValue('All Status');

      fireEvent.change(searchInput, { target: { value: 'company.com' } });
      fireEvent.change(statusSelect, { target: { value: 'active' } });

      // Only active users matching search should be visible
      expect(screen.getByText('admin@company.com')).toBeInTheDocument();
      expect(screen.getByText('user@company.com')).toBeInTheDocument();
      expect(screen.queryByText('inactive@company.com')).not.toBeInTheDocument();
    });
  });

  describe('Empty States', () => {
    it('should show empty state when no users match filters', () => {
      render(
        <TestWrapper>
          <AdminUsers />
        </TestWrapper>
      );

      const searchInput = screen.getByPlaceholderText('Search by name or email...');
      fireEvent.change(searchInput, { target: { value: 'nonexistent@example.com' } });

      expect(screen.getByText('No users found')).toBeInTheDocument();
      expect(screen.getByText('Try adjusting your search criteria or filters.')).toBeInTheDocument();
    });

    it('should show empty state when no users exist', () => {
      mockListQuery.mockReturnValue({
        data: { success: true, users: [] },
        isLoading: false,
        error: null
      });

      render(
        <TestWrapper>
          <AdminUsers />
        </TestWrapper>
      );

      expect(screen.getByText('No users found')).toBeInTheDocument();
    });
  });

  describe('User Actions', () => {
    it('should toggle admin status when shield button is clicked', async () => {
      const mockMutateAsync = vi.fn();
      mockUpdateMutation.mockReturnValue({
        mutateAsync: mockMutateAsync
      });

      render(
        <TestWrapper>
          <AdminUsers />
        </TestWrapper>
      );

      // Find the shield button for the regular user (should make them admin)
      const userRows = screen.getAllByRole('row');
      const regularUserRow = userRows.find(row =>
        row.textContent?.includes('user@company.com')
      );

      const shieldButton = regularUserRow?.querySelector('button[title="Make admin"]');
      expect(shieldButton).toBeInTheDocument();

      fireEvent.click(shieldButton!);

      await waitFor(() => {
        expect(mockMutateAsync).toHaveBeenCalledWith({
          id: '2',
          data: { isAdmin: true }
        });
      });
    });

    it('should toggle active status when pencil button is clicked', async () => {
      const mockMutateAsync = vi.fn();
      mockUpdateMutation.mockReturnValue({
        mutateAsync: mockMutateAsync
      });

      render(
        <TestWrapper>
          <AdminUsers />
        </TestWrapper>
      );

      // Find the pencil button for the inactive user (should activate them)
      const userRows = screen.getAllByRole('row');
      const inactiveUserRow = userRows.find(row =>
        row.textContent?.includes('inactive@company.com')
      );

      const pencilButton = inactiveUserRow?.querySelector('button[title="Activate user"]');
      expect(pencilButton).toBeInTheDocument();

      fireEvent.click(pencilButton!);

      await waitFor(() => {
        expect(mockMutateAsync).toHaveBeenCalledWith({
          id: '3',
          data: { isActive: true }
        });
      });
    });

    it('should show alert when delete button is clicked (delete not implemented)', async () => {
      render(
        <TestWrapper>
          <AdminUsers />
        </TestWrapper>
      );

      // Find the trash button for the regular user
      const userRows = screen.getAllByRole('row');
      const regularUserRow = userRows.find(row =>
        row.textContent?.includes('user@company.com')
      );

      const trashButton = regularUserRow?.querySelector('button[title="Delete user"]');
      expect(trashButton).toBeInTheDocument();

      fireEvent.click(trashButton!);

      // Delete is not implemented - just shows alert
      await waitFor(() => {
        expect(window.alert).toHaveBeenCalledWith('Delete user functionality is not currently available');
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle update errors gracefully', async () => {
      const mockMutateAsync = vi.fn().mockRejectedValue(new Error('Update failed'));
      mockUpdateMutation.mockReturnValue({
        mutateAsync: mockMutateAsync
      });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      render(
        <TestWrapper>
          <AdminUsers />
        </TestWrapper>
      );

      const userRows = screen.getAllByRole('row');
      const regularUserRow = userRows.find(row =>
        row.textContent?.includes('user@company.com')
      );

      const shieldButton = regularUserRow?.querySelector('button[title="Make admin"]');
      fireEvent.click(shieldButton!);

      await waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith('Failed to update user:', expect.any(Error));
      });

      consoleSpy.mockRestore();
    });
  });

  describe('Accessibility', () => {
    it('should have proper ARIA labels and roles', () => {
      render(
        <TestWrapper>
          <AdminUsers />
        </TestWrapper>
      );

      // Check for proper form labels
      expect(screen.getByLabelText('Search Users')).toBeInTheDocument();
      expect(screen.getByLabelText('Role')).toBeInTheDocument();
      expect(screen.getByLabelText('Status')).toBeInTheDocument();

      // Check for proper table structure
      expect(screen.getByRole('table')).toBeInTheDocument();
      expect(screen.getAllByRole('columnheader')).toHaveLength(7);
    });

    it('should have proper button titles for screen readers', () => {
      render(
        <TestWrapper>
          <AdminUsers />
        </TestWrapper>
      );

      // Check that we have the expected number of each button type
      expect(screen.getAllByTitle(/admin/)).toHaveLength(3); // Make admin + Remove admin buttons
      expect(screen.getAllByTitle(/user/)).toHaveLength(6); // 2 Deactivate + 1 Activate + 3 Delete user buttons
      expect(screen.getAllByTitle('Delete user')).toHaveLength(3);

      // Verify specific button titles exist
      expect(screen.getByTitle('Remove admin')).toBeInTheDocument(); // Admin has "Remove admin"
      expect(screen.getAllByTitle('Make admin')).toHaveLength(2); // 2 non-admin users have "Make admin"
      expect(screen.getByTitle('Activate user')).toBeInTheDocument(); // Inactive user has "Activate"
      expect(screen.getAllByTitle('Deactivate user')).toHaveLength(2); // 2 active users have "Deactivate"
    });
  });

});
