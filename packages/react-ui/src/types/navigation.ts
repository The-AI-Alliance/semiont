import { ComponentType, ReactNode } from 'react';

/**
 * Represents a single navigation item
 */
export interface NavigationItem {
  /** Display name for the navigation item */
  name: string;
  /** Target URL/path for the navigation item */
  href: string;
  /** Icon component to display */
  icon: ComponentType<any>;
  /** Optional description/tooltip text */
  description?: string;
}

/**
 * Props for navigation components that need framework-specific routing
 */
export interface NavigationProps {
  /** List of navigation items to display */
  items: NavigationItem[];
  /** Current active path for highlighting */
  currentPath: string;
  /** Framework-specific Link component (e.g., Next.js Link) */
  LinkComponent: ComponentType<{
    href: string;
    className?: string;
    children: ReactNode;
    title?: string;
  }>;
  /** Optional CSS class name */
  className?: string;
  /** Optional section title */
  title?: string;
}

/**
 * Props for the SidebarNavigation component
 */
export interface SidebarNavigationProps extends NavigationProps {
  /** Whether to show descriptions as tooltips */
  showDescriptions?: boolean;
  /** Custom active item class */
  activeClassName?: string;
  /** Custom inactive item class */
  inactiveClassName?: string;
}