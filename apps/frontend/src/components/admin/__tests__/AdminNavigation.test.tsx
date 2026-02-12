import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { usePathname } from 'next/navigation';
import { AdminNavigation } from '../AdminNavigation';
import type { SimpleNavigationProps } from '@semiont/react-ui';
import { useEventSubscriptions } from '@semiont/react-ui';

// Mock next/navigation
vi.mock('next/navigation', () => ({
  usePathname: vi.fn(),
}));

// Mock @/i18n/routing to use the same mock as next/navigation
vi.mock('@/i18n/routing', async () => {
  const { usePathname } = await import('next/navigation');
  return {
    usePathname,
    Link: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
  };
});

// Mock next-intl
const mockTranslations = {
  Administration: {
    title: 'Administration',
    users: 'Users',
    usersDescription: 'User management and permissions',
    oauthSettings: 'OAuth Settings',
    oauthSettingsDescription: 'View OAuth configuration',
    devops: 'DevOps',
    devopsDescription: 'Development operations and tools',
  },
  Sidebar: {
    collapseSidebar: 'Collapse sidebar',
    expandSidebar: 'Expand sidebar',
  },
};

vi.mock('next-intl', () => ({
  useTranslations: (namespace: string) => (key: string) => {
    const translations = mockTranslations[namespace as keyof typeof mockTranslations];
    return translations?.[key as keyof typeof translations] || key;
  },
}));

// Mock Heroicons
vi.mock('@heroicons/react/24/outline', () => ({
  UsersIcon: ({ className }: { className?: string }) => (
    <svg data-testid="users-icon" className={className} />
  ),
  ShieldCheckIcon: ({ className }: { className?: string }) => (
    <svg data-testid="shield-check-icon" className={className} />
  ),
  CommandLineIcon: ({ className }: { className?: string }) => (
    <svg data-testid="command-line-icon" className={className} />
  ),
  ChevronLeftIcon: ({ className }: { className?: string }) => (
    <svg data-testid="chevron-left-icon" className={className} />
  ),
  Bars3Icon: ({ className }: { className?: string }) => (
    <svg data-testid="bars3-icon" className={className} />
  ),
}));

// Mock SimpleNavigation component and event bus hooks
const mockSimpleNavigation = vi.fn();
const mockEventBus = {
  on: vi.fn(),
  off: vi.fn(),
  emit: vi.fn(),
};

vi.mock('@semiont/react-ui', () => {
  // Use factory function to properly handle mock references
  const mockEventBusLocal = {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  };

  return {
    SimpleNavigation: (props: any) => {
      mockSimpleNavigation(props);
      return <div data-testid="simple-navigation">Mocked SimpleNavigation</div>;
    },
    useNavigationEvents: () => mockEventBusLocal,
    useEventBus: () => mockEventBusLocal,
    useMakeMeaningEvents: () => mockEventBusLocal,
    useGlobalSettingsEvents: () => mockEventBusLocal,
    useEventSubscriptions: vi.fn(),
  };
});

describe('AdminNavigation', () => {
  const defaultProps = {
    isCollapsed: false,
    toggleCollapsed: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (usePathname as any).mockReturnValue('/admin');
    // Mock localStorage
    Storage.prototype.getItem = vi.fn();
    Storage.prototype.setItem = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('SimpleNavigation integration', () => {
    it('should render SimpleNavigation component', () => {
      render(<AdminNavigation {...defaultProps} />);
      expect(screen.getByTestId('simple-navigation')).toBeInTheDocument();
    });

    it('should pass correct title prop from translations', () => {
      render(<AdminNavigation {...defaultProps} />);

      expect(mockSimpleNavigation).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Administration',
        })
      );
    });

    it('should pass currentPath from usePathname', () => {
      const testPath = '/admin/users';
      (usePathname as any).mockReturnValue(testPath);

      render(<AdminNavigation {...defaultProps} />);

      expect(mockSimpleNavigation).toHaveBeenCalledWith(
        expect.objectContaining({
          currentPath: testPath,
        })
      );
    });

    it('should pass Link component as LinkComponent prop', () => {
      render(<AdminNavigation {...defaultProps} />);

      const call = mockSimpleNavigation.mock.calls[0]![0]!;
      expect(call.LinkComponent).toBeDefined();
    });

    it('should pass collapse/expand labels from Sidebar translations', () => {
      render(<AdminNavigation {...defaultProps} />);

      expect(mockSimpleNavigation).toHaveBeenCalledWith(
        expect.objectContaining({
          collapseSidebarLabel: 'Collapse sidebar',
          expandSidebarLabel: 'Expand sidebar',
        })
      );
    });

    it('should pass chevronLeft and bars icons', () => {
      render(<AdminNavigation {...defaultProps} />);

      const call = mockSimpleNavigation.mock.calls[0]![0]!;
      expect(call.icons).toBeDefined();
      expect(call.icons.chevronLeft).toBeDefined();
      expect(call.icons.bars).toBeDefined();
    });
  });

  describe('Navigation items configuration', () => {
    it('should pass 3 navigation items to SimpleNavigation', () => {
      render(<AdminNavigation {...defaultProps} />);

      const call = mockSimpleNavigation.mock.calls[0]![0]!;
      expect(call.items).toHaveLength(3);
    });

    it('should configure Users navigation item correctly', () => {
      render(<AdminNavigation {...defaultProps} />);

      const call = mockSimpleNavigation.mock.calls[0]![0]!;
      const usersItem = call.items[0];

      expect(usersItem).toEqual(
        expect.objectContaining({
          name: 'Users',
          href: '/admin/users',
          description: 'User management and permissions',
        })
      );
      expect(usersItem.icon).toBeDefined();
    });

    it('should configure OAuth Settings navigation item correctly', () => {
      render(<AdminNavigation {...defaultProps} />);

      const call = mockSimpleNavigation.mock.calls[0]![0]!;
      const oauthItem = call.items[1];

      expect(oauthItem).toEqual(
        expect.objectContaining({
          name: 'OAuth Settings',
          href: '/admin/security',
          description: 'View OAuth configuration',
        })
      );
      expect(oauthItem.icon).toBeDefined();
    });

    it('should configure DevOps navigation item correctly', () => {
      render(<AdminNavigation {...defaultProps} />);

      const call = mockSimpleNavigation.mock.calls[0]![0]!;
      const devopsItem = call.items[2];

      expect(devopsItem).toEqual(
        expect.objectContaining({
          name: 'DevOps',
          href: '/admin/devops',
          description: 'Development operations and tools',
        })
      );
      expect(devopsItem.icon).toBeDefined();
    });

    it('should pass all items with correct structure', () => {
      render(<AdminNavigation {...defaultProps} />);

      const call = mockSimpleNavigation.mock.calls[0]![0]!;

      call.items.forEach((item: any) => {
        expect(item).toHaveProperty('name');
        expect(item).toHaveProperty('href');
        expect(item).toHaveProperty('icon');
        expect(item).toHaveProperty('description');
        expect(typeof item.name).toBe('string');
        expect(typeof item.href).toBe('string');
        expect(typeof item.description).toBe('string');
      });
    });
  });

  describe('Collapse/expand state management', () => {
    it('should pass isCollapsed prop to SimpleNavigation', () => {
      render(<AdminNavigation {...defaultProps} isCollapsed={true} />);

      expect(mockSimpleNavigation).toHaveBeenCalledWith(
        expect.objectContaining({
          isCollapsed: true,
        })
      );
    });

    it('should pass isCollapsed as false when prop is false', () => {
      render(<AdminNavigation {...defaultProps} isCollapsed={false} />);

      const call = mockSimpleNavigation.mock.calls[0]![0]!;
      expect(call.isCollapsed).toBe(false);
    });

    it('should subscribe to navigation:sidebar-toggle event', () => {
      render(<AdminNavigation {...defaultProps} />);

      expect(vi.mocked(useEventSubscriptions)).toHaveBeenCalledWith(
        expect.objectContaining({
          'navigation:sidebar-toggle': expect.any(Function),
        })
      );
    });

    it('should call toggleCollapsed when sidebar-toggle event is handled', () => {
      const mockToggleCollapsed = vi.fn();

      render(<AdminNavigation {...defaultProps} toggleCollapsed={mockToggleCollapsed} />);

      // Get the subscriptions object passed to useEventSubscriptions
      const mockUseEventSubs = vi.mocked(useEventSubscriptions);
      const subscriptions = mockUseEventSubs.mock.calls[0]![0]!;
      const toggleHandler = subscriptions['navigation:sidebar-toggle'];

      // Call the toggle handler
      expect(toggleHandler).toBeDefined();
      toggleHandler!(undefined);

      expect(mockToggleCollapsed).toHaveBeenCalledTimes(1);
    });
  });

  describe('Optional navigationMenu prop', () => {
    it('should not pass dropdownContent when navigationMenu is not provided', () => {
      render(<AdminNavigation {...defaultProps} />);

      const call = mockSimpleNavigation.mock.calls[0]![0]!;
      expect(call.dropdownContent).toBeUndefined();
    });

    it('should pass dropdownContent when navigationMenu is provided', () => {
      const mockNavigationMenu = vi.fn(() => <div>Mock Menu</div>);

      render(<AdminNavigation {...defaultProps} navigationMenu={mockNavigationMenu} />);

      const call = mockSimpleNavigation.mock.calls[0]![0]!;
      expect(call.dropdownContent).toBeDefined();
      expect(call.dropdownContent).toBe(mockNavigationMenu);
    });

    it('should pass navigationMenu function with correct signature', () => {
      const mockNavigationMenu = vi.fn((onClose: () => void) => <div>Mock Menu</div>);

      render(<AdminNavigation {...defaultProps} navigationMenu={mockNavigationMenu} />);

      const call = mockSimpleNavigation.mock.calls[0]![0]!;
      expect(typeof call.dropdownContent).toBe('function');
    });
  });

  describe('Dynamic pathname updates', () => {
    it('should update currentPath when pathname changes', () => {
      const { rerender } = render(<AdminNavigation {...defaultProps} />);

      let call = mockSimpleNavigation.mock.calls[0]![0]!;
      expect(call.currentPath).toBe('/admin');

      (usePathname as any).mockReturnValue('/admin/users');
      rerender(<AdminNavigation {...defaultProps} />);

      call = mockSimpleNavigation.mock.calls[mockSimpleNavigation.mock.calls.length - 1]![0]!;
      expect(call.currentPath).toBe('/admin/users');
    });

    it('should handle multiple pathname changes', () => {
      const { rerender } = render(<AdminNavigation {...defaultProps} />);

      const paths = ['/admin/users', '/admin/security', '/admin/devops'];

      paths.forEach((path) => {
        (usePathname as any).mockReturnValue(path);
        rerender(<AdminNavigation {...defaultProps} />);

        const call = mockSimpleNavigation.mock.calls[mockSimpleNavigation.mock.calls.length - 1]![0]!;
        expect(call.currentPath).toBe(path);
      });
    });
  });

  describe('Props validation', () => {
    it('should pass all required SimpleNavigation props', () => {
      render(<AdminNavigation {...defaultProps} />);

      const call = mockSimpleNavigation.mock.calls[0]![0]!;

      // Required props from SimpleNavigationProps interface
      expect(call.title).toBeDefined();
      expect(call.items).toBeDefined();
      expect(call.currentPath).toBeDefined();
      expect(call.LinkComponent).toBeDefined();
      expect(call.isCollapsed).toBeDefined();
      expect(call.icons).toBeDefined();
      expect(call.collapseSidebarLabel).toBeDefined();
      expect(call.expandSidebarLabel).toBeDefined();
    });

    it('should pass props with correct types', () => {
      render(<AdminNavigation {...defaultProps} />);

      const call = mockSimpleNavigation.mock.calls[0]![0]!;

      expect(typeof call.title).toBe('string');
      expect(Array.isArray(call.items)).toBe(true);
      expect(typeof call.currentPath).toBe('string');
      expect(typeof call.isCollapsed).toBe('boolean');
      expect(typeof call.icons).toBe('object');
      expect(typeof call.collapseSidebarLabel).toBe('string');
      expect(typeof call.expandSidebarLabel).toBe('string');
    });

    it('should not pass any unexpected props to SimpleNavigation', () => {
      render(<AdminNavigation {...defaultProps} />);

      const call = mockSimpleNavigation.mock.calls[0]![0]!;
      const expectedKeys = [
        'title',
        'items',
        'currentPath',
        'LinkComponent',
        'isCollapsed',
        'icons',
        'collapseSidebarLabel',
        'expandSidebarLabel',
      ];

      const actualKeys = Object.keys(call);

      actualKeys.forEach((key) => {
        expect(
          expectedKeys.includes(key) || key === 'dropdownContent'
        ).toBe(true);
      });
    });
  });
});
