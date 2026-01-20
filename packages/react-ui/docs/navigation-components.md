# Navigation Components

This document describes the navigation components available in @semiont/react-ui.

## Overview

The navigation components in this library are designed to be completely platform-agnostic, working with any React framework or routing solution. They accept platform-specific dependencies (like Link components and routing functions) as props, enabling them to work seamlessly in Next.js, Vite, React Native, or any other React environment.

## Components

### SidebarNavigation

A simple, flexible sidebar navigation component for fixed menu items.

#### Props

```typescript
interface SidebarNavigationProps {
  items: NavigationItem[];
  title?: string;
  currentPath: string;
  LinkComponent: ComponentType<any>;
  className?: string;
  showDescriptions?: boolean;
  activeClassName?: string;
  inactiveClassName?: string;
  isCollapsed?: boolean;
  showText?: boolean;
}
```

#### Usage Example

```tsx
import { SidebarNavigation } from '@semiont/react-ui';
import { Link } from 'next/link'; // or react-router, etc.
import { HomeIcon, SettingsIcon } from '@heroicons/react/24/outline';

const navigation = [
  { name: 'Home', href: '/', icon: HomeIcon },
  { name: 'Settings', href: '/settings', icon: SettingsIcon }
];

<SidebarNavigation
  items={navigation}
  currentPath={pathname}
  LinkComponent={Link}
  showDescriptions={true}
  isCollapsed={false}
/>
```

### CollapsibleResourceNavigation

A comprehensive navigation component with collapsible state, fixed navigation items, and draggable resource tabs.

#### Features

- **Collapsible/Expandable**: Toggle between full and compact views
- **Fixed Navigation Items**: Static menu items that don't change
- **Dynamic Resource Tabs**: Draggable tabs for open resources/documents
- **Drag & Drop Reordering**: Reorder resource tabs when expanded
- **Platform-Agnostic**: Works with any routing solution

#### Props

```typescript
interface CollapsibleResourceNavigationProps {
  // Fixed navigation items
  fixedItems: NavigationItem[];

  // Dynamic resources
  resources: OpenResource[];

  // Collapse state
  isCollapsed: boolean;
  onToggleCollapse: () => void;

  // Resource management
  onResourceClose: (id: string) => void;
  onResourceReorder: (oldIndex: number, newIndex: number) => void;

  // Navigation
  currentPath: string;
  LinkComponent: ComponentType<any>;
  onNavigate?: (path: string) => void;
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
    closeResource?: string;
  };

  // Icons (platform-specific)
  icons: {
    chevronLeft: ComponentType<{ className?: string }>;
    bars: ComponentType<{ className?: string }>;
    close: ComponentType<{ className?: string }>;
  };
}
```

#### Usage Example

```tsx
import { CollapsibleResourceNavigation } from '@semiont/react-ui';
import { Link } from 'next/link';
import { ChevronLeftIcon, Bars3Icon, XMarkIcon } from '@heroicons/react/24/outline';

function MyNavigation() {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [resources, setResources] = useState([]);

  const handleResourceReorder = (oldIndex: number, newIndex: number) => {
    const newResources = [...resources];
    const [removed] = newResources.splice(oldIndex, 1);
    newResources.splice(newIndex, 0, removed);
    setResources(newResources);
  };

  return (
    <CollapsibleResourceNavigation
      fixedItems={[
        { name: 'Browse', href: '/browse', icon: FolderIcon },
        { name: 'Create', href: '/create', icon: PlusIcon }
      ]}
      resources={resources}
      isCollapsed={isCollapsed}
      onToggleCollapse={() => setIsCollapsed(!isCollapsed)}
      onResourceClose={(id) => removeResource(id)}
      onResourceReorder={handleResourceReorder}
      currentPath={pathname}
      LinkComponent={Link}
      getResourceHref={(id) => `/resource/${id}`}
      icons={{
        chevronLeft: ChevronLeftIcon,
        bars: Bars3Icon,
        close: XMarkIcon
      }}
      translations={{
        title: 'Navigation',
        collapseSidebar: 'Collapse sidebar',
        expandSidebar: 'Expand sidebar'
      }}
    />
  );
}
```

### SortableResourceTab

A draggable tab component for resources, used within CollapsibleResourceNavigation.

#### Props

```typescript
interface SortableResourceTabProps {
  resource: OpenResource;
  isCollapsed: boolean;
  isActive: boolean;
  href: string;
  onClose: (id: string, e: React.MouseEvent) => void;
  LinkComponent: ComponentType<any>;
  translations: {
    dragToReorder?: string;
    closeResource?: string;
  };
}
```

#### Features

- **Drag Handle**: Icon serves as drag handle when expanded
- **Click Navigation**: Navigates to resource when clicked
- **Close Button**: Remove resource from navigation
- **Collapsed Mode**: Shows only icon when sidebar is collapsed
- **Visual States**: Different styles for active/inactive/dragging

## Platform Integration Examples

### Next.js Integration

```tsx
import { CollapsibleResourceNavigation } from '@semiont/react-ui';
import { Link } from 'next/link';
import { useRouter, usePathname } from 'next/navigation';

export function NextJsNavigation() {
  const router = useRouter();
  const pathname = usePathname();

  return (
    <CollapsibleResourceNavigation
      LinkComponent={Link}
      currentPath={pathname}
      onNavigate={(path) => router.push(path)}
      // ... other props
    />
  );
}
```

### React Router Integration

```tsx
import { CollapsibleResourceNavigation } from '@semiont/react-ui';
import { Link, useNavigate, useLocation } from 'react-router-dom';

export function ReactRouterNavigation() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <CollapsibleResourceNavigation
      LinkComponent={Link}
      currentPath={location.pathname}
      onNavigate={(path) => navigate(path)}
      // ... other props
    />
  );
}
```

### React Native Integration

```tsx
import { CollapsibleResourceNavigation } from '@semiont/react-ui';
import { useNavigation, useRoute } from '@react-navigation/native';
import { TouchableOpacity } from 'react-native';

// Create a Link adapter for React Native
const NativeLink = ({ href, children, ...props }) => (
  <TouchableOpacity onPress={() => navigation.navigate(href)} {...props}>
    {children}
  </TouchableOpacity>
);

export function NativeNavigation() {
  const navigation = useNavigation();
  const route = useRoute();

  return (
    <CollapsibleResourceNavigation
      LinkComponent={NativeLink}
      currentPath={route.name}
      onNavigate={(path) => navigation.navigate(path)}
      // ... other props
    />
  );
}
```

## Styling

All navigation components use BEM-style CSS classes for consistent styling:

```css
/* SidebarNavigation */
.sidebar-navigation
.sidebar-navigation__header
.sidebar-navigation__title
.sidebar-navigation__items
.sidebar-navigation__item
.sidebar-navigation__item--active

/* CollapsibleResourceNavigation */
.collapsible-resource-navigation
.collapsible-resource-navigation__header
.collapsible-resource-navigation__title
.collapsible-resource-navigation__collapse-btn
.collapsible-resource-navigation__expand-btn
.collapsible-resource-navigation__content
.collapsible-resource-navigation__resources

/* SortableResourceTab */
.semiont-resource-tab
.semiont-resource-tab--active
.semiont-resource-tab--inactive
.semiont-resource-tab--dragging
.semiont-resource-tab__link
.semiont-resource-tab__drag-handle
.semiont-resource-tab__icon
.semiont-resource-tab__name
.semiont-resource-tab__close
```

You can override these styles or add additional utility classes as needed.

## Accessibility

All navigation components include:

- Proper ARIA labels and roles
- Keyboard navigation support
- Screen reader announcements for drag & drop
- Focus management
- Semantic HTML structure

## Type Definitions

All types are exported from the package:

```typescript
import type {
  NavigationItem,
  OpenResource,
  CollapsibleResourceNavigationProps,
  SidebarNavigationProps,
  SortableResourceTabProps
} from '@semiont/react-ui';
```

## Best Practices

1. **Pass Icons as Props**: Don't import icon libraries in react-ui; pass them from the consuming app
2. **Handle Routing Externally**: Let the consuming app handle all routing logic
3. **Provide Translations**: Pass all UI text as props for internationalization
4. **Use Semantic Classes**: Add layout classes but don't override component styling
5. **Test Across Platforms**: Ensure components work in different React environments