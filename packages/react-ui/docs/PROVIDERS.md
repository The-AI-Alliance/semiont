# Provider Pattern

`@semiont/react-ui` uses the **Provider Pattern** (React Context API) to achieve framework independence. This document explains the pattern and each provider implementation.

## Philosophy

The Provider Pattern allows the library to:

- ✅ Work with **any React framework** (Next.js, Vite, CRA, Remix, React Native)
- ✅ Support **any authentication system** (next-auth, Auth0, Clerk, custom)
- ✅ Support **any i18n library** (next-intl, react-i18next, custom)
- ✅ Support **any routing library** (Next.js Router, React Router, custom)
- ✅ Maintain **consistent architecture** across all cross-cutting concerns

## How It Works

1. **react-ui defines interfaces** - TypeScript contracts that apps must implement
2. **Apps implement managers** - Using their preferred libraries/frameworks
3. **Apps pass managers to Providers** - Via props at the root of the app
4. **Components use hooks** - To access managers without knowing the implementation

```tsx
// 1. react-ui defines the interface
interface TranslationManager {
  t: (namespace: string, key: string) => string;
}

// 2. App implements the manager (using any i18n library)
function useTranslationManager(): TranslationManager {
  const locale = useLocale();
  const messages = require(`@/messages/${locale}.json`);

  return {
    t: (namespace, key) => messages[namespace]?.[key] || key
  };
}

// 3. App passes manager to Provider
function App() {
  const translationManager = useTranslationManager();

  return (
    <TranslationProvider translationManager={translationManager}>
      {children}
    </TranslationProvider>
  );
}

// 4. Components use hooks (framework-agnostic)
function MyComponent() {
  const t = useTranslations('Toolbar');
  return <button>{t('save')}</button>;
}
```

## Available Providers

### SessionProvider

Manages authentication state and session expiration.

**Interface:**

```typescript
interface SessionManager {
  isAuthenticated: boolean;
  expiresAt: Date | null;
  timeUntilExpiry: number | null; // milliseconds
  isExpiringSoon: boolean;
}
```

**Usage:**

```tsx
import { SessionProvider, useSessionContext } from '@semiont/react-ui';

// App implementation (example using next-auth)
function useSessionManager(): SessionManager {
  const { data: session } = useSession();
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);

  // Parse JWT to get expiration
  useEffect(() => {
    if (session?.backendToken) {
      const payload = JSON.parse(atob(session.backendToken.split('.')[1]));
      setExpiresAt(new Date(payload.exp * 1000));
    }
  }, [session]);

  const timeUntilExpiry = expiresAt
    ? expiresAt.getTime() - Date.now()
    : null;

  return {
    isAuthenticated: !!session?.backendToken,
    expiresAt,
    timeUntilExpiry,
    isExpiringSoon: timeUntilExpiry !== null && timeUntilExpiry < 5 * 60 * 1000
  };
}

// In your app
<SessionProvider sessionManager={sessionManager}>
  {children}
</SessionProvider>

// In components
function MyComponent() {
  const { isAuthenticated, isExpiringSoon } = useSessionContext();

  if (isExpiringSoon) {
    return <SessionExpiryBanner />;
  }

  return <div>Authenticated: {isAuthenticated}</div>;
}
```

**Components that use SessionContext:**
- `SessionExpiredModal` - Shows modal when session expires
- `SessionExpiryBanner` - Warning banner before expiration
- `SessionTimer` - Displays countdown to expiration

---

### TranslationProvider

Manages internationalization and translations.

**Interface:**

```typescript
interface TranslationManager {
  t: (namespace: string, key: string) => string;
}
```

**Usage:**

```tsx
import { TranslationProvider, useTranslations } from '@semiont/react-ui';

// App implementation (example using next-intl)
function useTranslationManager(): TranslationManager {
  const locale = useLocale();

  // Load all message files
  const messages = {
    en: require('@/messages/en.json'),
    es: require('@/messages/es.json'),
    // ... other languages
  };

  return {
    t: (namespace, key) => {
      const localeMessages = messages[locale] || messages.en;
      return localeMessages[namespace]?.[key] || key;
    }
  };
}

// In your app
<TranslationProvider translationManager={translationManager}>
  {children}
</TranslationProvider>

// In components
function Toolbar() {
  const t = useTranslations('Toolbar');

  return (
    <div>
      <button>{t('save')}</button>
      <button>{t('cancel')}</button>
    </div>
  );
}
```

**Translation Namespaces:**

The library uses namespace-based translations. Common namespaces include:

- `Common` - Shared UI strings (save, cancel, delete, etc.)
- `Toolbar` - Toolbar actions
- `Footer` - Footer links and copyright
- `Navigation` - Navigation menu items
- `Settings` - User settings
- `ResourceViewer` - Resource viewing UI
- `AnnotateToolbar` - Annotation toolbar

See [INTERNATIONALIZATION.md](INTERNATIONALIZATION.md) for complete list.

---

### ApiClientProvider

Provides authenticated API client for all API operations.

**Interface:**

```typescript
interface ApiClientManager {
  client: SemiontApiClient | null; // null when unauthenticated
}
```

**Usage:**

```tsx
import { ApiClientProvider, useApiClient } from '@semiont/react-ui';
import { SemiontApiClient, baseUrl, accessToken } from '@semiont/api-client';

// App implementation (example using next-auth)
function useApiClientManager(): ApiClientManager {
  const { data: session } = useSession();

  const client = useMemo(() => {
    if (!session?.backendToken) {
      return null;
    }

    return new SemiontApiClient({
      baseUrl: baseUrl(''), // Relative URLs for browser
      accessToken: accessToken(session.backendToken),
      timeout: 30000
    });
  }, [session?.backendToken]);

  return { client };
}

// In your app
<ApiClientProvider apiClientManager={apiClientManager}>
  {children}
</ApiClientProvider>

// In components (usually via API hooks)
function MyComponent() {
  const resources = useResources();
  const { data } = resources.list.useQuery();

  return <div>{data?.length} resources</div>;
}
```

**Note:** Most components don't call `useApiClient()` directly. Instead, they use the higher-level API hooks like `useResources()`, `useAnnotations()`, etc.

See [API-INTEGRATION.md](API-INTEGRATION.md) for details.

---

### MakeMeaningEventBusProvider

Provides unified event bus for backend SSE events and UI interaction events.

**Interface:**

```typescript
interface MakeMeaningEventBus {
  on<T extends ResourceEvent['type']>(
    type: T,
    handler: (event: Extract<ResourceEvent, { type: T }>) => void
  ): void;
  off<T extends ResourceEvent['type']>(
    type: T,
    handler: (event: Extract<ResourceEvent, { type: T }>) => void
  ): void;
  emit<T extends ResourceEvent['type']>(
    type: T,
    data: Extract<ResourceEvent, { type: T }>['data']
  ): void;
}
```

**Props:**

```typescript
interface MakeMeaningEventBusProviderProps {
  rUri: ResourceUri;
  children: React.ReactNode;
}
```

**Usage:**

```tsx
import { MakeMeaningEventBusProvider, useMakeMeaningEvents } from '@semiont/react-ui';
import { resourceUri } from '@semiont/api-client';

// Wrap resource page with provider
export default function ResourcePage({ params }: { params: { id: string } }) {
  const rUri = resourceUri(params.id);

  return (
    <MakeMeaningEventBusProvider rUri={rUri}>
      <ResourceViewerPage rUri={rUri} />
    </MakeMeaningEventBusProvider>
  );
}

// Emit UI events in components
function TextSelector() {
  const eventBus = useMakeMeaningEvents();

  const handleSelection = (selection: Selection) => {
    eventBus.emit('ui:mark:select-comment', {
      exact: selection.exact,
      start: selection.start,
      end: selection.end,
      prefix: extractPrefix(selection.start),
      suffix: extractSuffix(selection.end)
    });
  };

  return <div onMouseUp={handleSelection}>...</div>;
}

// Subscribe to events in other components
function AnnotationPanel() {
  const eventBus = useMakeMeaningEvents();
  const [pendingAnnotation, setPendingAnnotation] = useState(null);

  useEffect(() => {
    const handler = (selection) => {
      setPendingAnnotation({
        selector: {
          type: 'TextQuoteSelector',
          exact: selection.exact,
          start: selection.start,
          end: selection.end,
          prefix: selection.prefix,
          suffix: selection.suffix
        },
        motivation: 'commenting'
      });
    };

    eventBus.on('ui:mark:select-comment', handler);
    return () => eventBus.off('ui:mark:select-comment', handler);
  }, [eventBus]);

  return <div>{/* Render annotation form */}</div>;
}
```

**Key Features:**

- **Resource-scoped:** Each resource page gets its own event bus instance (not global)
- **Backend events:** Automatically receives SSE events from make-meaning (detection, generation, annotation lifecycle)
- **UI events:** Components emit local user interaction events (text selection, annotation requests)
- **Type-safe:** Full TypeScript support with discriminated unions
- **Automatic cache invalidation:** Backend events trigger React Query cache invalidation
- **Real-time collaboration foundation:** UI events ready for P2P broadcast

**Event Types:**

Backend Events:
- Detection: `detection:started`, `detection:progress`, `detection:entity-found`, `detection:completed`, `detection:failed`
- Generation: `generation:started`, `generation:progress`, `generation:resource-created`, `generation:completed`
- Annotation: `mark:added`, `mark:removed`, `mark:body-updated`
- Entity Tags: `entity-tag:added`, `entity-tag:removed`
- Resource: `mark:archived`, `mark:unarchived`

UI Events:
- Selection: `ui:mark:select-comment`, `ui:mark:select-tag`, `ui:mark:select-assessment`, `ui:mark:select-reference`

**Important:** This provider is resource-scoped, not application-scoped. It should wrap individual resource pages, not the entire app. Multiple resource pages can have independent event buses.

See [EVENTS.md](EVENTS.md) for complete documentation.

---

### OpenResourcesProvider

Manages recently opened resources (e.g., for "Open Documents" list).

**Interface:**

```typescript
interface OpenResource {
  id: string;
  name: string;
  openedAt: number;
  order?: number;
  mediaType?: string;
}

interface OpenResourcesManager {
  openResources: OpenResource[];
  addResource: (id: string, name: string, mediaType?: string) => void;
  removeResource: (id: string) => void;
  updateResourceName: (id: string, name: string) => void;
  reorderResources: (oldIndex: number, newIndex: number) => void;
}
```

**Usage:**

```tsx
import { OpenResourcesProvider, useOpenResources } from '@semiont/react-ui';

// App implementation (example using localStorage)
function useOpenResourcesManager(): OpenResourcesManager {
  const [openResources, setOpenResources] = useState<OpenResource[]>([]);

  // Load from localStorage
  useEffect(() => {
    const stored = localStorage.getItem('openDocuments');
    if (stored) {
      setOpenResources(JSON.parse(stored));
    }
  }, []);

  // Save to localStorage
  useEffect(() => {
    localStorage.setItem('openDocuments', JSON.stringify(openResources));
  }, [openResources]);

  const addResource = (id: string, name: string, mediaType?: string) => {
    setOpenResources(prev => [
      ...prev.filter(r => r.id !== id),
      { id, name, openedAt: Date.now(), mediaType }
    ]);
  };

  const removeResource = (id: string) => {
    setOpenResources(prev => prev.filter(r => r.id !== id));
  };

  const updateResourceName = (id: string, name: string) => {
    setOpenResources(prev =>
      prev.map(r => r.id === id ? { ...r, name } : r)
    );
  };

  const reorderResources = (oldIndex: number, newIndex: number) => {
    setOpenResources(prev => {
      const result = Array.from(prev);
      const [removed] = result.splice(oldIndex, 1);
      result.splice(newIndex, 0, removed);
      return result.map((r, i) => ({ ...r, order: i }));
    });
  };

  return {
    openResources,
    addResource,
    removeResource,
    updateResourceName,
    reorderResources
  };
}

// In your app
<OpenResourcesProvider openResourcesManager={openResourcesManager}>
  {children}
</OpenResourcesProvider>

// In components
function OpenDocumentsList() {
  const { openResources, removeResource } = useOpenResources();

  return (
    <ul>
      {openResources.map(doc => (
        <li key={doc.id}>
          {doc.name}
          <button onClick={() => removeResource(doc.id)}>×</button>
        </li>
      ))}
    </ul>
  );
}
```

**Features:**
- Drag-and-drop reordering (using `@dnd-kit/sortable`)
- Cross-tab synchronization (via `storage` events)
- Persistence (localStorage, sessionStorage, or custom)

---

### RoutingContext

Provides framework-agnostic navigation.

**Interface:**

```typescript
interface RoutingConfig {
  Link: ComponentType<{ href: string; children: ReactNode; [key: string]: any }>;
  routes: {
    home: string;
    discover: string;
    resource: (id: string) => string;
    // ... other routes
  };
}
```

**Usage:**

```tsx
import { RoutingProvider } from '@semiont/react-ui';
import NextLink from 'next/link';

// App implementation (Next.js example)
const routingConfig = {
  Link: NextLink,
  routes: {
    home: '/',
    discover: '/know/discover',
    resource: (id) => `/know/resource/${id}`,
    moderate: '/moderate',
    administer: '/administer'
  }
};

// In your app
<RoutingProvider routing={routingConfig}>
  {children}
</RoutingProvider>

// In components
function NavigationMenu() {
  const { Link, routes } = useRouting();

  return (
    <nav>
      <Link href={routes.home}>Home</Link>
      <Link href={routes.discover}>Discover</Link>
    </nav>
  );
}
```

See [ROUTING.md](ROUTING.md) for details.

---

## Provider Order

Providers should be composed in this order (outer to inner):

```tsx
<SessionProvider sessionManager={sessionManager}>
  <TranslationProvider translationManager={translationManager}>
    <ApiClientProvider apiClientManager={apiClientManager}>
      <QueryClientProvider client={queryClient}>
        <RoutingProvider routing={routingConfig}>
          <OpenResourcesProvider openResourcesManager={openResourcesManager}>
            {children}
          </OpenResourcesProvider>
        </RoutingProvider>
      </QueryClientProvider>
    </ApiClientProvider>
  </TranslationProvider>
</SessionProvider>
```

**Rationale:**
1. Session is outermost (authentication affects everything)
2. Translation next (UI strings needed everywhere)
3. API Client (depends on session for auth token)
4. React Query (uses API client)
5. Routing (needs translations)
6. Open Resources innermost (app-specific, not used by core components)

## Testing with Providers

Use the test utilities to render components with all providers:

```tsx
import { renderWithProviders } from '@semiont/react-ui/test-utils';

it('should render with providers', () => {
  renderWithProviders(<MyComponent />);
  expect(screen.getByText('Hello')).toBeInTheDocument();
});

it('should work with authenticated client', () => {
  const mockClient = new SemiontApiClient({ ... });

  renderWithProviders(<MyComponent />, {
    apiClientManager: { client: mockClient }
  });
});
```

See [TESTING.md](TESTING.md) for complete testing guide.

## Anti-Patterns

### ❌ Don't: Create wrappers or aliases

```tsx
// WRONG - Don't wrap the manager in another context
function MyProvider({ children }) {
  const manager = useTranslationManager();
  return (
    <MyContext.Provider value={manager}>
      <TranslationProvider translationManager={manager}>
        {children}
      </TranslationProvider>
    </MyContext.Provider>
  );
}
```

### ✅ Do: Pass manager directly to Provider

```tsx
// CORRECT - Pass manager directly
function App({ children }) {
  const translationManager = useTranslationManager();

  return (
    <TranslationProvider translationManager={translationManager}>
      {children}
    </TranslationProvider>
  );
}
```

### ❌ Don't: Call hooks conditionally in managers

```tsx
// WRONG - Violates Rules of Hooks
const t = useMemo(() => {
  return (namespace: string, key: string) => {
    const translator = useNextIntlTranslations(namespace); // ❌ Can't call hooks here
    return translator(key);
  };
}, []);
```

### ✅ Do: Load data directly in managers

```tsx
// CORRECT - Load messages directly
const messages = require('@/messages/en.json');

return {
  t: (namespace, key) => messages[namespace]?.[key] || key
};
```

## See Also

- [EVENTS.md](EVENTS.md) - Event-driven architecture and MakeMeaningEventBusProvider
- [INTERNATIONALIZATION.md](INTERNATIONALIZATION.md) - Translation details
- [API-INTEGRATION.md](API-INTEGRATION.md) - API client usage
- [ROUTING.md](ROUTING.md) - Routing configuration
- [TESTING.md](TESTING.md) - Testing with providers
