# Routing

`@semiont/react-ui` has no router and imports none. A component that renders a link takes the
host's `Link` component, and one that builds a path takes the host's `routes` object.

## The two props

```tsx
import type { LinkComponentProps, RouteBuilder } from '@semiont/react-ui';
```

**`Link`** is any component that accepts `LinkComponentProps`: `href`, `children`, and
optionally `className`, `title` and `onClick`. Further props pass through to the host's link.

**`routes`** is a `RouteBuilder`, which turns an id into a path:

```ts
interface RouteBuilder {
  resourceDetail: (id: string) => string;
  knowledge?: () => string;
  moderate?: () => string;
}
```

A `ResourceId` is a string, so `routes.resourceDetail(resourceId)` needs no conversion.

`resourceDetail` is the path of every link to a resource. `knowledge` and `moderate` are optional:
`NavigationMenu` links to them, and `ResourceViewerPage` filters by an entity type at
`routes.knowledge()`; a host without those pages leaves them out.

## Which components take them

| Takes | Components |
|---|---|
| `Link` and `routes` | `PageLayout`, `UnifiedHeader`, `LeftSidebar`, `NavigationMenu`, `AnnotationHistory`, `HistoryEvent`, `ReferencesPanel`, `UnifiedAnnotationsPanel`, `ResourceViewerPage` |
| `Link` only | `CollapsibleResourceNavigation`, `SortableResourceTab`, `SimpleNavigation`, `AuthErrorDisplay` |

Each declares them in its props as `Link: ComponentType<LinkComponentProps>` and
`routes: RouteBuilder`; `NavigationMenu` takes a `Partial<RouteBuilder>`.

```tsx
<AnnotationHistory events={events} Link={Link} routes={routes} />
```

Two components name paths of their own: `NavigationMenu` links to `/know` and `/moderate` when
`routes` lacks `knowledge` or `moderate`, and `AuthErrorDisplay` links to `/auth/signin`.

## Supplying them

A host writes both once and passes them wherever they are asked for. React Router's link takes
`to` where `LinkComponentProps` has `href`, so a host over React Router adapts it:

```tsx
import { Link as RouterLink } from 'react-router';
import type { LinkComponentProps, RouteBuilder } from '@semiont/react-ui';

export function Link({ href, ...props }: LinkComponentProps) {
  return <RouterLink to={href} {...props} />;
}

export const routes: RouteBuilder = {
  resourceDetail: (id) => `/know/resource/${id}`,
  knowledge: () => '/know',
  moderate: () => '/moderate',
};
```

A framework whose link already takes `href` (Next.js) needs no adapter: pass its `Link` as it
is. The Semiont Browser's own pair is `apps/browser/src/lib/routing.tsx`.

## Navigation that is not a link

Following a reference, opening a panel and closing a tab are not links. They reach the host as
callbacks (`onOpenResource`, `onOpenPanel`, `onNavigate`) or as events on the bus. See
[COMPONENTS.md](COMPONENTS.md) for the callbacks and [EVENTS.md](EVENTS.md) for the events.

## Testing

A test passes a plain anchor and a literal `routes`:

```tsx
const Link = ({ href, children, ...props }: LinkComponentProps) => <a href={href} {...props}>{children}</a>;
const routes: RouteBuilder = { resourceDetail: (id) => `/resource/${id}` };

render(<AnnotationHistory events={[]} Link={Link} routes={routes} />);
```
