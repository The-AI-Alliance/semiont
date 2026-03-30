import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { renderWithProviders } from '../../../test-utils';
import { SimpleNavigation } from '../SimpleNavigation';
import type { SimpleNavigationItem } from '../SimpleNavigation';

const MockChevronLeft = (props: any) => <span data-testid="chevron" {...props} />;
const MockBars = (props: any) => <span data-testid="bars" {...props} />;

const MockLink = ({ href, children, ...props }: any) => (
  <a href={href} {...props}>{children}</a>
);

const MockIcon1 = (props: any) => <span data-testid="icon-1" {...props} />;
const MockIcon2 = (props: any) => <span data-testid="icon-2" {...props} />;

const defaultItems: SimpleNavigationItem[] = [
  { name: 'Dashboard', href: '/admin/dashboard', icon: MockIcon1 },
  { name: 'Users', href: '/admin/users', icon: MockIcon2, description: 'Manage users' },
];

const defaultProps = {
  title: 'Administration',
  items: defaultItems,
  currentPath: '/admin/dashboard',
  LinkComponent: MockLink,
  isCollapsed: false,
  icons: {
    chevronLeft: MockChevronLeft,
    bars: MockBars,
  },
  collapseSidebarLabel: 'Collapse sidebar',
  expandSidebarLabel: 'Expand sidebar',
};

describe('SimpleNavigation', () => {
  describe('title visibility', () => {
    it('renders title when not collapsed', () => {
      renderWithProviders(<SimpleNavigation {...defaultProps} />);

      expect(screen.getByText('Administration')).toBeInTheDocument();
    });

    it('hides title when collapsed', () => {
      renderWithProviders(
        <SimpleNavigation {...defaultProps} isCollapsed={true} />
      );

      expect(screen.queryByText('Administration')).not.toBeInTheDocument();
    });
  });

  describe('navigation items', () => {
    it('renders navigation items', () => {
      renderWithProviders(<SimpleNavigation {...defaultProps} />);

      expect(screen.getByText('Dashboard')).toBeInTheDocument();
      expect(screen.getByText('Users')).toBeInTheDocument();
    });

    it('marks active item with aria-current="page"', () => {
      renderWithProviders(<SimpleNavigation {...defaultProps} />);

      const dashboardLink = screen.getByText('Dashboard').closest('a');
      expect(dashboardLink).toHaveAttribute('aria-current', 'page');

      const usersLink = screen.getByText('Users').closest('a');
      expect(usersLink).not.toHaveAttribute('aria-current');
    });

    it('shows item text when not collapsed', () => {
      renderWithProviders(<SimpleNavigation {...defaultProps} />);

      expect(screen.getByText('Dashboard')).toBeInTheDocument();
      expect(screen.getByText('Users')).toBeInTheDocument();
    });

    it('shows only icons when collapsed', () => {
      renderWithProviders(
        <SimpleNavigation {...defaultProps} isCollapsed={true} />
      );

      // Text spans should not be present in collapsed mode
      expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
      expect(screen.queryByText('Users')).not.toBeInTheDocument();

      // Icons should still be rendered
      const icons = screen.getAllByTestId(/^icon-/);
      expect(icons.length).toBe(2);
    });
  });

  describe('sidebar toggle', () => {
    it('emits browse:sidebar-toggle on collapse button click', () => {
      const handler = vi.fn();

      const { eventBus } = renderWithProviders(
        <SimpleNavigation {...defaultProps} />,
        { returnEventBus: true }
      );

      const subscription = eventBus!.get('browse:sidebar-toggle').subscribe(handler);

      const collapseButton = screen.getByLabelText('Collapse sidebar');
      fireEvent.click(collapseButton);

      expect(handler).toHaveBeenCalledWith(undefined);

      subscription.unsubscribe();
    });

    it('shows expand label when collapsed', () => {
      renderWithProviders(
        <SimpleNavigation {...defaultProps} isCollapsed={true} />
      );

      expect(screen.getByLabelText('Expand sidebar')).toBeInTheDocument();
    });
  });

  describe('dropdown', () => {
    it('opens dropdown when header button clicked if dropdownContent provided', () => {
      const dropdownContent = (onClose: () => void) => (
        <div data-testid="dropdown-content">
          <button onClick={onClose}>Close</button>
        </div>
      );

      renderWithProviders(
        <SimpleNavigation {...defaultProps} dropdownContent={dropdownContent} />
      );

      // Dropdown should not be visible initially
      expect(screen.queryByTestId('dropdown-content')).not.toBeInTheDocument();

      // Click header button to open dropdown
      const headerButton = screen.getByRole('button', { name: /Administration/i });
      fireEvent.click(headerButton);

      expect(screen.getByTestId('dropdown-content')).toBeInTheDocument();
    });

    it('closes dropdown on outside click', () => {
      const dropdownContent = (onClose: () => void) => (
        <div data-testid="dropdown-content">Dropdown</div>
      );

      renderWithProviders(
        <SimpleNavigation {...defaultProps} dropdownContent={dropdownContent} />
      );

      // Open dropdown
      const headerButton = screen.getByRole('button', { name: /Administration/i });
      fireEvent.click(headerButton);
      expect(screen.getByTestId('dropdown-content')).toBeInTheDocument();

      // Click outside
      fireEvent.mouseDown(document.body);

      expect(screen.queryByTestId('dropdown-content')).not.toBeInTheDocument();
    });
  });
});
