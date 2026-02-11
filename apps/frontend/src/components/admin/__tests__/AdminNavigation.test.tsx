import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { usePathname } from 'next/navigation';
import { AdminNavigation } from '../AdminNavigation';
import type { SimpleNavigationProps } from '@semiont/react-ui';

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

vi.mock('@semiont/react-ui', () => ({
  SimpleNavigation: (props: SimpleNavigationProps) => {
    mockSimpleNavigation(props);
    return <div data-testid="simple-navigation">Mocked SimpleNavigation</div>;
  },
  useNavigationEvents: () => mockEventBus,
  useEvents: () => mockEventBus,
  useMakeMeaningEvents: () => mockEventBus,
  useGlobalSettingsEvents: () => mockEventBus,
}));

describe('AdminNavigation', () => {
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
      render(<AdminNavigation />);
      expect(screen.getByTestId('simple-navigation')).toBeInTheDocument();
    });

    it('should pass correct title prop from translations', () => {
      render(<AdminNavigation />);

      expect(mockSimpleNavigation).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Administration',
        })
      );
    });

    it('should pass currentPath from usePathname', () => {
      const testPath = '/admin/users';
      (usePathname as any).mockReturnValue(testPath);

      render(<AdminNavigation />);

      expect(mockSimpleNavigation).toHaveBeenCalledWith(
        expect.objectContaining({
          currentPath: testPath,
        })
      );
    });

    it('should pass Link component as LinkComponent prop', () => {
      render(<AdminNavigation />);

      const call = mockSimpleNavigation.mock.calls[0]![0]!;
      expect(call.LinkComponent).toBeDefined();
    });

    it('should pass collapse/expand labels from Sidebar translations', () => {
      render(<AdminNavigation />);

      expect(mockSimpleNavigation).toHaveBeenCalledWith(
        expect.objectContaining({
          collapseSidebarLabel: 'Collapse sidebar',
          expandSidebarLabel: 'Expand sidebar',
        })
      );
    });

    it('should pass chevronLeft and bars icons', () => {
      render(<AdminNavigation />);

      const call = mockSimpleNavigation.mock.calls[0]![0]!;
      expect(call.icons).toBeDefined();
      expect(call.icons.chevronLeft).toBeDefined();
      expect(call.icons.bars).toBeDefined();
    });
  });

  describe('Navigation items configuration', () => {
    it('should pass 3 navigation items to SimpleNavigation', () => {
      render(<AdminNavigation />);

      const call = mockSimpleNavigation.mock.calls[0]![0]!;
      expect(call.items).toHaveLength(3);
    });

    it('should configure Users navigation item correctly', () => {
      render(<AdminNavigation />);

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
      render(<AdminNavigation />);

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
      render(<AdminNavigation />);

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
      render(<AdminNavigation />);

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
    it('should initialize with isCollapsed as false by default', () => {
      render(<AdminNavigation />);

      expect(mockSimpleNavigation).toHaveBeenCalledWith(
        expect.objectContaining({
          isCollapsed: false,
        })
      );
    });

    it('should load collapsed state from localStorage on mount', () => {
      (Storage.prototype.getItem as any).mockReturnValue('true');

      render(<AdminNavigation />);

      expect(localStorage.getItem).toHaveBeenCalledWith('admin-sidebar-collapsed');

      // Need to wait for useEffect to run and component to re-render
      // The second call should have isCollapsed: true
      const calls = mockSimpleNavigation.mock.calls;
      const lastCall = calls[calls.length - 1]![0]!;
      expect(lastCall.isCollapsed).toBe(true);
    });

    it('should remain false when localStorage has no value', () => {
      (Storage.prototype.getItem as any).mockReturnValue(null);

      render(<AdminNavigation />);

      const call = mockSimpleNavigation.mock.calls[0]![0]!;
      expect(call.isCollapsed).toBe(false);
    });

    it('should subscribe to navigation:sidebar-toggle event', () => {
      render(<AdminNavigation />);

      expect(mockEventBus.on).toHaveBeenCalledWith(
        'navigation:sidebar-toggle',
        expect.any(Function)
      );
    });

    it('should save collapsed state to localStorage when event is emitted', () => {
      render(<AdminNavigation />);

      // Get the event handler that was registered
      const onCall = mockEventBus.on.mock.calls.find(
        (call: any[]) => call[0] === 'navigation:sidebar-toggle'
      );
      expect(onCall).toBeDefined();
      const eventHandler = onCall![1];

      // Trigger the event
      eventHandler();

      expect(localStorage.setItem).toHaveBeenCalledWith('admin-sidebar-collapsed', 'true');
    });

    it('should update state when event handler is called', () => {
      render(<AdminNavigation />);

      // Get the event handler that was registered
      const onCall = mockEventBus.on.mock.calls.find(
        (call: any[]) => call[0] === 'navigation:sidebar-toggle'
      );
      expect(onCall).toBeDefined();
      const eventHandler = onCall![1];

      // Calling the event handler should save to localStorage
      eventHandler();
      expect(localStorage.setItem).toHaveBeenCalledWith('admin-sidebar-collapsed', expect.any(String));
    });

    it('should use admin-sidebar-collapsed as localStorage key', () => {
      render(<AdminNavigation />);

      expect(localStorage.getItem).toHaveBeenCalledWith('admin-sidebar-collapsed');

      // Get and trigger the event handler
      const onCall = mockEventBus.on.mock.calls.find(
        (call: any[]) => call[0] === 'navigation:sidebar-toggle'
      );
      const eventHandler = onCall![1];
      eventHandler();

      expect(localStorage.setItem).toHaveBeenCalledWith(
        'admin-sidebar-collapsed',
        expect.any(String)
      );
    });
  });

  describe('Optional navigationMenu prop', () => {
    it('should not pass dropdownContent when navigationMenu is not provided', () => {
      render(<AdminNavigation />);

      const call = mockSimpleNavigation.mock.calls[0]![0]!;
      expect(call.dropdownContent).toBeUndefined();
    });

    it('should pass dropdownContent when navigationMenu is provided', () => {
      const mockNavigationMenu = vi.fn(() => <div>Mock Menu</div>);

      render(<AdminNavigation navigationMenu={mockNavigationMenu} />);

      const call = mockSimpleNavigation.mock.calls[0]![0]!;
      expect(call.dropdownContent).toBeDefined();
      expect(call.dropdownContent).toBe(mockNavigationMenu);
    });

    it('should pass navigationMenu function with correct signature', () => {
      const mockNavigationMenu = vi.fn((onClose: () => void) => <div>Mock Menu</div>);

      render(<AdminNavigation navigationMenu={mockNavigationMenu} />);

      const call = mockSimpleNavigation.mock.calls[0]![0]!;
      expect(typeof call.dropdownContent).toBe('function');
    });
  });

  describe('Dynamic pathname updates', () => {
    it('should update currentPath when pathname changes', () => {
      const { rerender } = render(<AdminNavigation />);

      let call = mockSimpleNavigation.mock.calls[0]![0]!;
      expect(call.currentPath).toBe('/admin');

      (usePathname as any).mockReturnValue('/admin/users');
      rerender(<AdminNavigation />);

      call = mockSimpleNavigation.mock.calls[mockSimpleNavigation.mock.calls.length - 1]![0]!;
      expect(call.currentPath).toBe('/admin/users');
    });

    it('should handle multiple pathname changes', () => {
      const { rerender } = render(<AdminNavigation />);

      const paths = ['/admin/users', '/admin/security', '/admin/devops'];

      paths.forEach((path) => {
        (usePathname as any).mockReturnValue(path);
        rerender(<AdminNavigation />);

        const call = mockSimpleNavigation.mock.calls[mockSimpleNavigation.mock.calls.length - 1]![0]!;
        expect(call.currentPath).toBe(path);
      });
    });
  });

  describe('Props validation', () => {
    it('should pass all required SimpleNavigation props', () => {
      render(<AdminNavigation />);

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
      render(<AdminNavigation />);

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
      render(<AdminNavigation />);

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
