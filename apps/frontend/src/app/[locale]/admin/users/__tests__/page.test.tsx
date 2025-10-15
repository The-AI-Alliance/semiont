import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AdminUsers from '../client';
import { api } from '@/lib/api';

// Mock the API client
vi.mock('@/lib/api-client', () => ({
  api: {
    admin: {
      users: {
        all: {
          useQuery: vi.fn()
        },
        stats: {
          useQuery: vi.fn()
        },
        update: {
          useMutation: vi.fn()
        },
        delete: {
          useMutation: vi.fn()
        }
      }
    }
  }
}));

// Mock window.confirm
Object.defineProperty(window, 'confirm', {
  writable: true,
  value: vi.fn()
});

// Mock the useTheme hook
vi.mock('@/hooks/useTheme', () => ({
  useTheme: () => ({
    theme: 'system',
    setTheme: vi.fn()
  })
}));

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
  let mockUpdateMutation: { mutateAsync: Mock };
  let mockDeleteMutation: { mutateAsync: Mock };

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Setup mutation mocks
    mockUpdateMutation = {
      mutateAsync: vi.fn(),
    };

    mockDeleteMutation = {
      mutateAsync: vi.fn(),
    };

    // Setup default mock implementations
    (api.admin.users.all.useQuery as Mock).mockReturnValue({
      data: mockUsersResponse,
      isLoading: false,
      error: null
    });

    (api.admin.users.stats.useQuery as Mock).mockReturnValue({
      data: mockStatsResponse,
      isLoading: false,
      error: null
    });

    (api.admin.users.update.useMutation as Mock).mockReturnValue(mockUpdateMutation);
    (api.admin.users.delete.useMutation as Mock).mockReturnValue(mockDeleteMutation);

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
      (api.admin.users.stats.useQuery as Mock).mockReturnValue({
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
      (api.admin.users.all.useQuery as Mock).mockReturnValue({
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
      (api.admin.users.all.useQuery as Mock).mockReturnValue({
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
        expect(mockUpdateMutation.mutateAsync).toHaveBeenCalledWith({
          id: '2',
          data: { isAdmin: true }
        });
      });
    });

    it('should toggle active status when pencil button is clicked', async () => {
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
        expect(mockUpdateMutation.mutateAsync).toHaveBeenCalledWith({
          id: '3',
          data: { isActive: true }
        });
      });
    });

    it('should delete user when trash button is clicked and confirmed', async () => {
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

      expect(window.confirm).toHaveBeenCalledWith(
        'Are you sure you want to delete this user? This action cannot be undone.'
      );

      await waitFor(() => {
        expect(mockDeleteMutation.mutateAsync).toHaveBeenCalledWith('2');
      });
    });

    it('should not delete user when deletion is cancelled', async () => {
      (window.confirm as Mock).mockReturnValue(false);

      render(
        <TestWrapper>
          <AdminUsers />
        </TestWrapper>
      );

      const userRows = screen.getAllByRole('row');
      const regularUserRow = userRows.find(row => 
        row.textContent?.includes('user@company.com')
      );
      
      const trashButton = regularUserRow?.querySelector('button[title="Delete user"]');
      fireEvent.click(trashButton!);

      expect(window.confirm).toHaveBeenCalled();
      expect(mockDeleteMutation.mutateAsync).not.toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('should handle update errors gracefully', async () => {
      mockUpdateMutation.mutateAsync.mockRejectedValue(new Error('Update failed'));
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

    it('should handle delete errors gracefully', async () => {
      mockDeleteMutation.mutateAsync.mockRejectedValue(new Error('Delete failed'));
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
      
      const trashButton = regularUserRow?.querySelector('button[title="Delete user"]');
      fireEvent.click(trashButton!);

      await waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith('Failed to delete user:', expect.any(Error));
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