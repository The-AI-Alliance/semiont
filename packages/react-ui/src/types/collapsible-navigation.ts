import { ComponentType, ReactNode } from 'react';

/**
 * Represents an open resource/document in the navigation
 */
export interface OpenResource {
  id: string;
  name: string;
  openedAt: number;
  mediaType?: string;
}

/**
 * Props for the sortable resource tab component
 */
export interface SortableResourceTabProps {
  resource: OpenResource;
  isCollapsed: boolean;
  isActive: boolean;
  href: string;
  onClose: (id: string, e: React.MouseEvent) => void;
  LinkComponent: ComponentType<any>;
  dragHandleProps?: any;
  isDragging?: boolean;
  translations: {
    dragToReorder?: string;
    dragToReorderDoc?: string;
    closeResource?: string;
  };
}

/**
 * Props for the collapsible resource navigation component
 */
export interface CollapsibleResourceNavigationProps {
  // Fixed navigation items
  fixedItems: Array<{
    name: string;
    href: string;
    icon: ComponentType<{ className?: string }>;
    description?: string;
  }>;

  // Dynamic resources
  resources: OpenResource[];

  // Collapse state
  isCollapsed: boolean;
  onToggleCollapse: () => void;

  // Resource management
  onResourceClose: (id: string) => void;
  onResourceReorder: (oldIndex: number, newIndex: number) => void;
  onResourceSelect?: (id: string) => void;

  // Navigation
  currentPath: string;
  LinkComponent: ComponentType<any>;
  onNavigate?: (path: string) => void;

  // Resource URL builder
  getResourceHref: (resourceId: string) => string;

  // Styling
  className?: string;
  activeClassName?: string;
  inactiveClassName?: string;

  // Translations
  translations: {
    title?: string;
    collapseSidebar?: string;
    expandSidebar?: string;
    dragToReorder?: string;
    dragToReorderDoc?: string;
    closeResource?: string;
    dragInstructions?: string;
  };

  // Icons (to avoid platform-specific imports)
  icons: {
    chevronLeft: ComponentType<{ className?: string }>;
    bars: ComponentType<{ className?: string }>;
    close: ComponentType<{ className?: string }>;
  };
}

/**
 * Drag and drop sensor configuration
 */
export interface DragSensorConfig {
  activationConstraint?: {
    distance?: number;
    delay?: number;
    tolerance?: number;
  };
}