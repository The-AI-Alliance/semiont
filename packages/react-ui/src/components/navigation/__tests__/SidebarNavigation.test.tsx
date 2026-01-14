import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SidebarNavigation } from '../SidebarNavigation';
import type { NavigationItem } from '../../../types/navigation';

// Mock icon component
const MockIcon = ({ className }: { className?: string }) => (
  <svg className={className} data-testid="mock-icon" />
);

// Mock Link component
const MockLink = ({
  href,
  children,
  className,
  title
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
  title?: string;
}) => (
  <a
    href={href}
    className={className}
    title={title}
    data-testid={`link-${href}`}
    onClick={(e) => e.preventDefault()}
  >
    {children}
  </a>
);

describe('SidebarNavigation', () => {
  const mockItems: NavigationItem[] = [
    {
      name: 'Users',
      href: '/admin/users',
      icon: MockIcon,
      description: 'Manage users'
    },
    {
      name: 'Settings',
      href: '/admin/settings',
      icon: MockIcon,
      description: 'System settings'
    },
    {
      name: 'Reports',
      href: '/admin/reports',
      icon: MockIcon,
      description: 'View reports'
    }
  ];

  it('renders all navigation items', () => {
    render(
      <SidebarNavigation
        items={mockItems}
        currentPath="/admin/users"
        LinkComponent={MockLink as any}
      />
    );

    expect(screen.getByText('Users')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByText('Reports')).toBeInTheDocument();
  });

  it('renders with title when provided', () => {
    render(
      <SidebarNavigation
        items={mockItems}
        title="Administration"
        currentPath="/admin/users"
        LinkComponent={MockLink as any}
      />
    );

    expect(screen.getByText('Administration')).toBeInTheDocument();
  });

  it('applies active class to current path item', () => {
    render(
      <SidebarNavigation
        items={mockItems}
        currentPath="/admin/settings"
        LinkComponent={MockLink as any}
      />
    );

    const settingsLink = screen.getByTestId('link-/admin/settings');
    expect(settingsLink).toHaveClass('sidebar-navigation__item--active');

    const usersLink = screen.getByTestId('link-/admin/users');
    expect(usersLink).toHaveClass('sidebar-navigation__item--inactive');
  });

  it('applies custom active and inactive classes when provided', () => {
    render(
      <SidebarNavigation
        items={mockItems}
        currentPath="/admin/users"
        LinkComponent={MockLink as any}
        activeClassName="custom-active"
        inactiveClassName="custom-inactive"
      />
    );

    const usersLink = screen.getByTestId('link-/admin/users');
    expect(usersLink).toHaveClass('custom-active');
    expect(usersLink).not.toHaveClass('sidebar-navigation__item--active');

    const settingsLink = screen.getByTestId('link-/admin/settings');
    expect(settingsLink).toHaveClass('custom-inactive');
    expect(settingsLink).not.toHaveClass('sidebar-navigation__item--inactive');
  });

  it('includes descriptions as title attributes when showDescriptions is true', () => {
    render(
      <SidebarNavigation
        items={mockItems}
        currentPath="/admin/users"
        LinkComponent={MockLink as any}
        showDescriptions={true}
      />
    );

    const usersLink = screen.getByTestId('link-/admin/users');
    expect(usersLink).toHaveAttribute('title', 'Manage users');

    const settingsLink = screen.getByTestId('link-/admin/settings');
    expect(settingsLink).toHaveAttribute('title', 'System settings');
  });

  it('excludes descriptions when showDescriptions is false', () => {
    render(
      <SidebarNavigation
        items={mockItems}
        currentPath="/admin/users"
        LinkComponent={MockLink as any}
        showDescriptions={false}
      />
    );

    const usersLink = screen.getByTestId('link-/admin/users');
    expect(usersLink).not.toHaveAttribute('title');
  });

  it('renders icons for each navigation item', () => {
    render(
      <SidebarNavigation
        items={mockItems}
        currentPath="/admin/users"
        LinkComponent={MockLink as any}
      />
    );

    const icons = screen.getAllByTestId('mock-icon');
    expect(icons).toHaveLength(3);
  });

  it('applies correct icon classes based on active state', () => {
    render(
      <SidebarNavigation
        items={mockItems}
        currentPath="/admin/users"
        LinkComponent={MockLink as any}
      />
    );

    const icons = screen.getAllByTestId('mock-icon');

    // First icon should be active (Users is active)
    expect(icons[0]).toHaveClass('sidebar-navigation__icon--active');

    // Other icons should be inactive
    expect(icons[1]).toHaveClass('sidebar-navigation__icon--inactive');
    expect(icons[2]).toHaveClass('sidebar-navigation__icon--inactive');
  });

  it('applies custom className when provided', () => {
    const { container } = render(
      <SidebarNavigation
        items={mockItems}
        currentPath="/admin/users"
        LinkComponent={MockLink as any}
        className="custom-navigation-class"
      />
    );

    const navigation = container.querySelector('.sidebar-navigation');
    expect(navigation).toHaveClass('custom-navigation-class');
  });

  it('handles empty items array gracefully', () => {
    render(
      <SidebarNavigation
        items={[]}
        currentPath="/admin/users"
        LinkComponent={MockLink as any}
      />
    );

    // Should render without errors
    const navigation = document.querySelector('.sidebar-navigation');
    expect(navigation).toBeInTheDocument();
  });
});