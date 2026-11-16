import type { ReactNode } from 'react';

export interface SimpleNavigationItem {
  name: string;
  href: string;
  icon: React.ComponentType<any>;
  description?: string;
}

export interface SimpleNavigationProps {
  title: string;
  items: SimpleNavigationItem[];
  currentPath: string;
  LinkComponent: React.ComponentType<any>;
  dropdownContent?: ((onClose: () => void) => ReactNode) | undefined;
}
