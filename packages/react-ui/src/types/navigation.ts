import { ComponentType } from 'react';

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
