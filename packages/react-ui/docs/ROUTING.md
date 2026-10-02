# Routing

`@semiont/react-ui` has no router and imports none. A component that renders a link or builds
a URL takes two props from its host: a `Link` component and a `routes` object.

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

## Which components take them

`PageLayout`, `UnifiedHeader`, `LeftSidebar`, `AnnotationHistory`, `HistoryEvent`,
`ReferencesPanel` and `UnifiedAnnotationsPanel`. Each declares `Link` and `routes` in its
`Props`.

```tsx
<AnnotationHistory events={events} Link={Link} routes={routes} />
```

## Supplying them

A host writes both once and passes them wherever they are asked for. React Router's link takes
`to` where `LinkComponentProps` has `href`, so a host over React Router adapts it:

```tsx
<<<<<<< HEAD
import { Link as RouterLink } from 'react-router';
import type { LinkComponentProps, RouteBuilder } from '@semiont/react-ui';

export function Link({ href, ...props }: LinkComponentProps) {
  return <RouterLink to={href} {...props} />;
}

export const routes: RouteBuilder = {
  resourceDetail: (id) => `/know/resource/${id}`,
  knowledge: () => '/know',
  moderate: () => '/moderate',
=======
import React from 'react';
import { Link as RouterLink } from 'react-router';
import type { LinkComponentProps, RouteBuilder } from '@semiont/react-ui';

export const Link = React.forwardRef<HTMLAnchorElement, LinkComponentProps>(
  function Link({ href, ...props }, ref) {
    return <RouterLink ref={ref} to={href} {...props} />;
  },
);

export const routes: RouteBuilder = {
  resourceDetail: (id) => `/know/resource/${id}`,
  userProfile: (id) => `/users/${id}`,
  search: (query) => `/search?q=${encodeURIComponent(query)}`,
  home: () => '/',
  knowledge: () => '/know',
  moderate: () => '/moderate',
  admin: () => '/admin',
>>>>>>> 7ed63a20b (Browser and react-ui docs: remove what no longer exists — routing provider, deleted modals and hooks, client.emit, and a performance guide with no commands)
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
<<<<<<< HEAD
const routes: RouteBuilder = { resourceDetail: (id) => `/resource/${id}` };
=======
const routes: RouteBuilder = {
  resourceDetail: (id) => `/resource/${id}`,
  userProfile: (id) => `/users/${id}`,
  search: (query) => `/search?q=${query}`,
  home: () => '/',
};
>>>>>>> 7ed63a20b (Browser and react-ui docs: remove what no longer exists — routing provider, deleted modals and hooks, client.emit, and a performance guide with no commands)

render(<AnnotationHistory events={[]} Link={Link} routes={routes} />);
```
