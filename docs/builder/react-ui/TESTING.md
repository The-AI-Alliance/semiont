# Testing

How to test a React app, or a component, built on `@semiont/react-ui`: the test
utilities the package exports, and the way of testing they are built for.

How the library's own tests are run, written and organized is in the package's
[TESTING.md](../../../packages/react-ui/docs/TESTING.md).

## Testing Philosophy

### Composition Over Mocking

We favor **composition-based testing** over vitest module mocks (`vi.mock()`):

**❌ Don't: Use vitest module mocks for components**
```tsx
// WRONG - Global mock affects all tests
vi.mock('../NavigationMenu', () => ({
  NavigationMenu: () => <div>Mocked Menu</div>
}));
```

**✅ Do: Use real components via composition**
```tsx
// CORRECT - Test with real components
import { render, screen } from '@testing-library/react';

const t = (key: string) => `nav.${key}`;

it('should render navigation with branding', () => {
  render(
    <LeftSidebar Link={Link} routes={routes} t={t} tHome={tHome}>
      <NavigationMenu Link={Link} routes={routes} t={t} />
    </LeftSidebar>
  );

  // Tests actual component behavior
  expect(screen.getByText('Semiont')).toBeInTheDocument();
  expect(screen.getByText('nav.know')).toBeInTheDocument();
});
```

**Why composition is better:**
- Tests real component behavior, not mock approximations
- Catches integration bugs that mocks miss
- No maintenance burden when component APIs change
- More confident refactoring
- Follows React's component model

**When mocking is acceptable:**
- **Hooks** for UI state (`useDropdown`)
- **External APIs** (`fetch`, API clients)
- **Browser APIs** not available in jsdom (`scrollIntoView`, `IntersectionObserver`)
- **Utility modules** (`getAnnotationExactText`, `getResourceIcon`)

### Event-Driven Testing

A component says things on a bus; a test listens on the real bus rather than mocking it.
A provider-free component — a panel, an entry, a viewer — speaks on the session it is handed,
so the test makes that session with `createTestSemiontWrapper` and listens on its `eventBus`:

```tsx
import { createTestSemiontWrapper, renderWithProviders, fireEvent } from '@semiont/react-ui/test-utils';

// Session-scoped channels (mark:*, beckon:*, browse:click, …): the bus of the session the component is given
const { session, eventBus } = createTestSemiontWrapper();
const { container } = renderWithProviders(
  <ReferenceEntry session={session} reference={annotation} isFocused={false} />,
);
const clicked = vi.fn();
const sub = eventBus.on('browse:click').subscribe(clicked);

fireEvent.click(container.firstChild!);

expect(clicked).toHaveBeenCalledWith({ annotationId: annotation.id });
sub.unsubscribe();
```

`renderWithProviders` hands back the `SemiontBrowser` it provides on request
(`returnShellBus`); its `stream(channel)` reads the app-scoped channels. (`returnEventBus`
returns the bus of the session it provides, for a component that reads its session from
`SemiontProvider`.)

```tsx
// App-scoped channels (panel:*, shell:*, tabs:*, nav:*, settings:*): the browser
const { browser } = renderWithProviders(<Toolbar context="document" activePanel={null} />, { returnShellBus: true });
const toggled = vi.fn();
const sub = browser!.stream('panel:toggle').subscribe(toggled);
```

The browser, session and client in these tests are the real ones, over the in-memory doubles
of `@semiont/sdk/testing`. A bus operation nobody scripted rejects, naming itself.

## Test Utilities

### Installation

Test utilities are exported from a separate entry point:

```typescript
import { renderWithProviders } from '@semiont/react-ui/test-utils';
```

### renderWithProviders

Renders a component inside `TranslationProvider`, `SemiontProvider`, `ToastProvider` and
`LineNumbersProvider`.

**Basic Usage:**

```tsx
import { renderWithProviders, screen } from '@semiont/react-ui/test-utils';

it('should render component', () => {
  renderWithProviders(<Toolbar context="simple" activePanel={null} />);
  expect(screen.getByLabelText('Toolbar.settings')).toBeInTheDocument();
});
```

**With Custom Providers:**

`translationManager` and `browser` replace the [defaults](#defaults); every other option is a
React Testing Library render option.

```tsx
import { renderWithProviders, createMockTranslationManager, screen } from '@semiont/react-ui/test-utils';

it('labels the toolbar in the given words', () => {
  renderWithProviders(<Toolbar context="simple" activePanel={null} />, {
    translationManager: createMockTranslationManager({
      Toolbar: { settings: 'Ajustes' },
    }),
  });

  expect(screen.getByLabelText('Ajustes')).toBeInTheDocument();
});
```

## Mock Creators

### createMockTranslationManager

Creates a translation manager from a namespace → key → text table. A key the table lacks
renders as the bare key:

```tsx
import { createMockTranslationManager } from '@semiont/react-ui/test-utils';

const translations = createMockTranslationManager({
  Toolbar: {
    annotations: 'Annotations',
    history: 'History'
  }
});

renderWithProviders(<Toolbar context="document" activePanel={null} />, { translationManager: translations });
```

### createTestBrowserWithSignals

Builds a real `SemiontBrowser` whose active `SessionSignals` are pre-populated, so modal
tests can control the modal-driving flags without driving a session through its state
machine. Tests pass it via the `browser` option to `renderWithProviders`. The overrides
are the two flags, raised through the methods production calls, and their acknowledgement
callbacks, which stand in for the real methods under a spy:

```tsx
import { createTestBrowserWithSignals } from '@semiont/react-ui/test-utils';

const browser = createTestBrowserWithSignals({
  sessionEnded: { reason: 'expired' },
  acknowledgeSessionEnded: vi.fn(),
});

renderWithProviders(<SessionEndedModal />, { browser });
```

Permission-denied modal tests follow the same shape. `detail` is the gateway's own words, or
`null` when it gave none:

```tsx
const browser = createTestBrowserWithSignals({
  permissionDenied: { detail: 'Archiving needs the curator role.' },
  acknowledgePermissionDenied: vi.fn(),
});

renderWithProviders(<PermissionDeniedModal />, { browser });
```

## Defaults

Without `translationManager`, `renderWithProviders` uses `defaultMocks.translationManager`,
which renders every key as `Namespace.key`:

```ts
import { defaultMocks } from '@semiont/react-ui/test-utils';

defaultMocks.translationManager.t('Toolbar', 'settings'); // 'Toolbar.settings'
```

Without `browser`, it builds a real `SemiontBrowser` whose active session is a real
`SemiontSession` from `createTestSession({ gateway: stubGateway() })` (`@semiont/sdk/testing`):
no HTTP, no network. Every browser and client made this way is disposed after each test.

## Testing API Integration

### Stubbing a Live Query

A provider-free component reads through the session it is handed. Take that session from
`createTestSemiontWrapper`, spy on its client's query, and render inside its `SemiontWrapper`.
A query's failure is an emission — `{ status: 'failed', error }` — never a stream error, so a
failure is stubbed the same way:

```tsx
import { of } from 'rxjs';
import { createTestSemiontWrapper, renderInEnglish, screen } from '@semiont/react-ui/test-utils';

it('names the resource this one was derived from', () => {
  const { SemiontWrapper, session, client } = createTestSemiontWrapper();
  vi.spyOn(client.browse, 'resource').mockReturnValue(
    CacheObservable.from(of<CacheState<ResourceDescriptor>>({ status: 'ready', value: { ...resource, name: 'Source Doc' } })),
  );

  renderInEnglish(
    <ResourceInfoPanel session={session} resourceId={rId} documentEntityTypes={[]} wasDerivedFrom={resourceId} />,
    { wrapper: SemiontWrapper },
  );

  expect(screen.getByText('Source Doc')).toBeInTheDocument();
});

it('keeps the raw id when the source cannot be read', () => {
  const { SemiontWrapper, session, client } = createTestSemiontWrapper();
  vi.spyOn(client.browse, 'resource').mockReturnValue(
    CacheObservable.from(of<CacheState<ResourceDescriptor>>({ status: 'failed', error: new Error('Network error') })),
  );

  renderInEnglish(
    <ResourceInfoPanel session={session} resourceId={rId} documentEntityTypes={[]} wasDerivedFrom={resourceId} />,
    { wrapper: SemiontWrapper },
  );

  expect(screen.getByText(resourceId)).toBeInTheDocument();
});
```

## Testing Translations

### Test with Specific Translations

```tsx
import { renderWithProviders, createMockTranslationManager, screen } from '@semiont/react-ui/test-utils';

it('should display Spanish translations', () => {
  const translations = createMockTranslationManager({
    Toolbar: {
      annotations: 'Anotaciones',
      history: 'Historial',
      settings: 'Configuración'
    }
  });

  renderWithProviders(<Toolbar context="document" activePanel={null} />, { translationManager: translations });

  expect(screen.getByLabelText('Anotaciones')).toBeInTheDocument();
  expect(screen.getByLabelText('Historial')).toBeInTheDocument();
});
```

### Test with Default Mock

```tsx
import { renderWithProviders, screen } from '@semiont/react-ui/test-utils';

it('should render with namespace.key format', () => {
  renderWithProviders(<Toolbar context="document" activePanel={null} />);

  // Default mock returns "Namespace.key"
  expect(screen.getByLabelText('Toolbar.annotations')).toBeInTheDocument();
  expect(screen.getByLabelText('Toolbar.history')).toBeInTheDocument();
});
```

## Testing Session State

`createTestBrowserWithSignals` drives the modal flags on the active
`SessionSignals`. Set `sessionEnded` (or `permissionDenied`) to
raise the corresponding modal, and pass the result via the `browser` option.
The modal tests also replace `@headlessui/react`'s dialog parts with plain
elements through `vi.mock`, as `SessionEndedModal.test.tsx` does:

```tsx
import { renderWithProviders, createTestBrowserWithSignals, screen } from '@semiont/react-ui/test-utils';

describe('SessionEndedModal', () => {
  it('says why the session ended', () => {
    const browser = createTestBrowserWithSignals({
      sessionEnded: { reason: 'expired' },
    });

    // The default translation manager renders each key as `Namespace.key`.
    renderWithProviders(<SessionEndedModal />, { browser });

    expect(screen.getByText('SessionEndedModal.expired')).toBeInTheDocument();
  });

  it('should not show when nothing is raised', () => {
    const browser = createTestBrowserWithSignals();

    renderWithProviders(<SessionEndedModal />, { browser });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
```

## Testing User Interactions

Drive a component the way a person does, with `user-event`, and assert on what it asks of
the SDK: spy on the client the component was handed.

```tsx
import { createTestSemiontWrapper, renderInEnglish, screen } from '@semiont/react-ui/test-utils';
import { userEvent } from '@testing-library/user-event';

it('opens the resource this one was derived from', async () => {
  const user = userEvent.setup();
  const { SemiontWrapper, session, client } = createTestSemiontWrapper();
  const openResource = vi.spyOn(client.browse, 'openResource');

  renderInEnglish(
    <ResourceInfoPanel session={session} resourceId={rId} documentEntityTypes={[]} wasDerivedFrom={resourceId} />,
    { wrapper: SemiontWrapper },
  );

  await user.click(screen.getByText(resourceId));

  expect(openResource).toHaveBeenCalledWith(resourceId);
});
```

## Snapshot Testing

```tsx
import { renderWithProviders } from '@semiont/react-ui/test-utils';

it('should match snapshot', () => {
  const { container } = renderWithProviders(<NavigationMenu Link={Link} routes={routes} t={t} />);
  expect(container).toMatchSnapshot();
});
```

## Testing Accessibility

`jest-axe` ships no type declarations: react-ui declares them in
`packages/react-ui/src/types/jest-axe.d.ts`, adds the matcher to vitest's `Assertion` in
`packages/react-ui/src/types/vitest-matchers.d.ts`, and its `vitest.setup.ts` extends
`expect` once for every test.

```tsx
import { renderWithProviders, screen } from '@semiont/react-ui/test-utils';
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

it('should have no accessibility violations', async () => {
  const { container } = renderWithProviders(<Toolbar context="document" activePanel={null} />);
  const results = await axe(container);
  expect(results).toHaveNoViolations();
});

it('should have proper ARIA labels', () => {
  renderWithProviders(<Toolbar context="document" activePanel="info" />);

  const button = screen.getByRole('button', { name: 'Toolbar.resourceInfo' });
  expect(button).toHaveAttribute('aria-pressed', 'true');
});
```

## Testing Keyboard Navigation

```tsx
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

it('should navigate with keyboard', async () => {
  const user = userEvent.setup();

  render(<NavigationMenu Link={Link} routes={routes} t={(key) => key} />);

  await user.tab();
  expect(screen.getByRole('link', { name: 'know' })).toHaveFocus();

  await user.tab();
  expect(screen.getByRole('link', { name: 'moderate' })).toHaveFocus();
});
```

## Best Practices

### ✅ Do: Use real components via composition

```tsx
// CORRECT - Test with real child components
import { render, screen } from '@testing-library/react';

it('should render navigation', () => {
  render(
    <LeftSidebar Link={Link} routes={routes} t={(key) => `nav.${key}`} tHome={tHome}>
      {(isCollapsed, toggleCollapsed, navigationMenu) => navigationMenu(() => {})}
    </LeftSidebar>
  );

  // Verify real NavigationMenu rendered
  expect(screen.getByText('nav.know')).toBeInTheDocument();
});
```

### ✅ Do: Mock only hooks, APIs, and browser APIs

```tsx
// CORRECT - Mock UI state hooks
vi.mock('@/hooks/useUI', () => ({
  useDropdown: vi.fn(() => ({
    isOpen: false,
    toggle: vi.fn(),
    close: vi.fn(),
    dropdownRef: { current: null },
  })),
}));

// CORRECT - Spy on browser APIs jsdom lacks (vitest.setup.ts gives scrollIntoView a no-op to spy on)
vi.spyOn(Element.prototype, 'scrollIntoView');
```

### ✅ Do: Test actual rendered content

```tsx
import { render, screen } from '@testing-library/react';

it('should display translated text', () => {
  render(<NavigationMenu Link={Link} routes={routes} t={(key) => `translated.${key}`} />);

  // Verify actual text rendered by component
  expect(screen.getByText('translated.know')).toBeInTheDocument();
});
```

### ✅ Do: Test error states

```tsx
import { render, screen, fireEvent } from '@testing-library/react';

it('should display error message on failure', () => {
  const onRetry = vi.fn();
  render(<ResourceErrorState error={new Error('Network error')} onRetry={onRetry} />);

  expect(screen.getByText('Network error')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
  expect(onRetry).toHaveBeenCalledTimes(1);
});
```

### ✅ Do: Test loading states

```tsx
import { render, screen } from '@testing-library/react';

it('should show the loading message', () => {
  render(<ResourceLoadingState />);
  expect(screen.getByText('Loading resource...')).toBeInTheDocument();
});
```

### ❌ Don't: Use vi.mock() for React components

```tsx
// WRONG - Global mock affects all tests
vi.mock('../NavigationMenu', () => ({
  NavigationMenu: () => <div>Mock</div>
}));

// CORRECT - Use real component
import { NavigationMenu } from '@semiont/react-ui';
```

### ❌ Don't: Mock EventBus methods

```tsx
import { EventBus } from '@semiont/core';

// WRONG - Breaks real event flow
vi.spyOn(EventBus.prototype, 'on');
vi.spyOn(EventBus.prototype, 'emit');

// CORRECT - Listen on the real bus
const { browser } = renderWithProviders(<Toolbar context="document" activePanel={null} />, { returnShellBus: true });
const seen = vi.fn();
browser!.stream('panel:toggle').subscribe(seen);
```

### ❌ Don't: Test implementation details

```tsx
import { screen } from '@testing-library/react';

const { container } = renderWithProviders(<Toolbar context="document" activePanel="info" />);

// WRONG - Testing internal markup
expect(container.querySelector('[data-panel="info"]')).toHaveAttribute('data-active', 'true');

// CORRECT - Testing behavior
expect(screen.getByLabelText('Toolbar.resourceInfo')).toHaveAttribute('aria-pressed', 'true');
```

### ❌ Don't: Make tests dependent on each other

```tsx
// WRONG - Tests share state
let sharedData: { value: number };

it('test 1', () => {
  sharedData = { value: 1 };
});

it('test 2', () => {
  expect(sharedData.value).toBe(1); // ❌ Depends on test 1
});
```

### ✅ Do: Use descriptive test names

```tsx
// Good test names
it('should display error when API returns 404')
it('should disable save button when form is invalid')
it('should call onSubmit with correct parameters')
it('should emit resource-selected event when clicking resource')
it('should render real NavigationMenu with navigation links')
```
