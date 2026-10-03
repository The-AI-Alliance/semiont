# Navigation Components

The sidebar and menu navigation in `@semiont/react-ui`. None of these components imports a router
or an icon library: the host passes its `Link` (see [ROUTING.md](ROUTING.md)) and its icons as
props, and the components report what the user did as events on the bus.

| Component | Renders |
|---|---|
| `CollapsibleResourceNavigation` | A sidebar of fixed items followed by one tab per open resource, reorderable by drag or keyboard |
| `SortableResourceTab` | One open-resource tab; `CollapsibleResourceNavigation` renders these |
| `SimpleNavigation` | A titled sidebar of fixed items |
| `NavigationMenu` | The Know and Moderate links, for a header dropdown or a sidebar |
| `ObservableLink` | A plain anchor that emits `nav:link-clicked` when clicked |

## CollapsibleResourceNavigation

Props: `CollapsibleResourceNavigationProps`. The resources are the session's open resources
(`OpenResource` from `@semiont/sdk`); `getResourceHref` turns a resource id into its path, which
is usually `routes.resourceDetail`.

```tsx
import { CollapsibleResourceNavigation } from '@semiont/react-ui';
import { Link, routes } from './routing';

<CollapsibleResourceNavigation
  fixedItems={[{ name: 'Discover', href: '/know/discover', icon: TelescopeIcon }]}
  resources={openResources}
  isCollapsed={isCollapsed}
  currentPath={pathname}
  Link={Link}
  getResourceHref={routes.resourceDetail}
  onNavigate={navigate}
  translations={{ title: 'Knowledge' }}
  icons={{ chevronLeft: ChevronLeftIcon, bars: Bars3Icon, close: XMarkIcon }}
/>
```

It changes nothing itself. Reordering emits `tabs:reorder`, closing a tab emits `tabs:close`, and
the collapse control emits `shell:sidebar-toggle`; the host's state follows those events. Closing
the tab that is showing calls `onNavigate` with the first fixed item's `href`, so the page does
not stay on a resource that is no longer open.

`navigationMenu`, when given, renders in a dropdown under the header and receives a function that
closes it.

The Semiont Browser's use is `apps/browser/src/components/knowledge/KnowledgeNavigation.tsx`.

## SimpleNavigation

Props: `SimpleNavigationProps`, with items of type `SimpleNavigationItem`. A title, a list of fixed
items, and the same `Link`, `isCollapsed`, `icons` and dropdown (`dropdownContent`) as above. The
collapse control emits `shell:sidebar-toggle`.

The Semiont Browser's use is `apps/browser/src/components/moderation/ModerationNavigation.tsx`.

## NavigationMenu

Takes `Link`, `routes` and a translate function `t`, and renders links to `routes.knowledge()`
and `routes.moderate()`, or to `/know` and `/moderate` when `routes` lacks them. `currentPath` marks the current one with `aria-current="page"`, and
`onItemClick` runs when either is clicked, which a dropdown uses to close itself.

## ObservableLink

Props: `ObservableLinkProps`, an anchor's attributes plus an optional `label`. It renders an
`<a>`, not the host's `Link`, and emits `nav:link-clicked` with the `href` and `label` before the
browser follows it.

## Styling

Each component's classes are defined beside it: `CollapsibleResourceNavigation.css`,
`SimpleNavigation.css`, `NavigationMenu.css` and `NavigationTabs.css` in
`packages/react-ui/src/components/navigation/`.
