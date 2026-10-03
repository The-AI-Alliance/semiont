# Testing

Comprehensive testing guide for `@semiont/react-ui` components and applications using the library.

## Overview

The library includes:

- **1300+ tests** with high coverage
- **Composition-based testing** over vitest module mocks
- **Event-driven architecture** testing patterns
- **Test utilities** for easy component testing
- **Real component integration** for authentic behavior validation
- **Vitest + React Testing Library** setup

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

## Running Tests

### Command Line

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Type checking
npm run typecheck
```

### Coverage Reports

Coverage reports are generated in the `coverage/` directory:

```bash
npm run test:coverage

# Open coverage report
open coverage/index.html
```

## Writing Tests for Library Components

If contributing to `@semiont/react-ui`, follow these patterns:

### Component Test Structure

Organize tests into logical describe blocks with clear test names:

```tsx
// src/components/layout/__tests__/LeftSidebar.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { LeftSidebar, type LinkComponentProps, type RouteBuilder } from '@semiont/react-ui';

// No mocks - using real components via composition

// Mock Link component
const MockLink = ({ href, children, ...props }: LinkComponentProps) => (
  <a href={href} {...props}>{children}</a>
);

// Mock routes
const mockRoutes: RouteBuilder = {
  resourceDetail: (id) => `/know/resource/${id}`,
};

// Mock translation functions
const mockT = (key: string) => `nav.${key}`;
const mockTHome = (key: string) => `home.${key}`;

describe('LeftSidebar Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('should render with required props', () => {
      render(
        <LeftSidebar
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
        >
          <div>Sidebar Content</div>
        </LeftSidebar>
      );

      expect(screen.getByText('Sidebar Content')).toBeInTheDocument();
    });

    it('should render branding when expanded', () => {
      render(
        <LeftSidebar
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
        >
          <div>Content</div>
        </LeftSidebar>
      );

      // Real SemiontBranding renders "Semiont" text
      expect(screen.getByText('Semiont')).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have proper ARIA attributes on nav element', () => {
      render(
        <LeftSidebar
          Link={MockLink}
          routes={mockRoutes}
          t={mockT}
          tHome={mockTHome}
        >
          <div>Content</div>
        </LeftSidebar>
      );

      const nav = screen.getByRole('navigation');
      expect(nav).toHaveAttribute('aria-label', 'Main navigation');
    });
  });
});
```

**Key principles from real tests:**
1. **No component mocks** - Import and use real child components
2. **Mock only necessities** - Translation functions, Link components, routes
3. **Descriptive test names** - Clear "should" statements
4. **Organized describe blocks** - Group by feature (Rendering, Accessibility, User Interactions)
5. **Test real behavior** - Verify actual rendered text, not mock artifacts
6. **Clean setup** - Use `beforeEach` to reset state between tests

### Hook Test Pattern

```tsx
// src/hooks/__tests__/useUI.test.tsx
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDropdown } from '@semiont/react-ui';

describe('useDropdown', () => {
  it('starts closed', () => {
    const { result } = renderHook(() => useDropdown());

    expect(result.current.isOpen).toBe(false);
  });

  it('toggle opens and closes', () => {
    const { result } = renderHook(() => useDropdown());

    act(() => result.current.toggle());
    expect(result.current.isOpen).toBe(true);

    act(() => result.current.toggle());
    expect(result.current.isOpen).toBe(false);
  });
});
```

## Known Test Issues

### SearchModal Tests (Skipped)

Four SearchModal test files are skipped because of memory issues with HeadlessUI Dialog in jsdom:

- **Issue**: HeadlessUI's `<Dialog>` component creates complex DOM structures with portals, transitions, and focus management that cause Out Of Memory errors in jsdom, even with increased heap size
- **Impact**: 36 tests across 4 test files are skipped
- **Files affected**:
  - `SearchModal.basic.test.tsx` (6 tests)
  - `SearchModal.visual.test.tsx` (15 tests)
  - `SearchModal.accessibility.test.tsx` (7 tests)
  - `SearchModal.keyboard.test.tsx` (8 tests)

`SearchModal.search-wiring.test.tsx` runs: it replaces HeadlessUI's dialog parts with plain
elements through `vi.mock`.

**Potential solutions**:
1. Mock HeadlessUI Dialog component entirely
2. Use Playwright/Cypress for integration tests instead of jsdom
3. Redesign SearchModal to use a lighter modal implementation

The tests remain in place with detailed TODO comments for future implementation.

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

## Testing Philosophy Summary

The `@semiont/react-ui` library uses **composition-based testing** as the primary pattern:

### Core Principles

1. **Real components, not mocks** - Tests use actual React components via composition
2. **The real bus for events** - A test subscribes on the real bus — the session's, or the browser's `stream` — instead of mocking `EventBus`
3. **Mock minimally** - Only mock hooks, external APIs, and browser APIs not available in jsdom
4. **Test behavior, not implementation** - Verify what users see, not internal state
5. **Isolated tests** - Each test is independent with clean state

### What to Mock

**✅ DO Mock:**
- UI state hooks (`useDropdown`)
- External APIs (`fetch`, API client methods)
- Browser APIs not in jsdom (`scrollIntoView`, `IntersectionObserver`)
- Utility modules (`getAnnotationExactText`, `getResourceIcon`)

**❌ DON'T Mock:**
- React components (`NavigationMenu`, `SemiontBranding`)
- EventBus methods (`on`, `off`, `emit`)
- React Context Providers
- Component props or callbacks

### Test Organization

Tests are organized by component type:

```
src/
├── components/
│   ├── layout/__tests__/           # Layout: LeftSidebar, UnifiedHeader, PageLayout
│   ├── annotation/__tests__/       # Annotation: AnnotateToolbar, AnnotationPanel
│   ├── resource/__tests__/         # Resource views: BrowseView, ResourceViewer
│   │   └── panels/__tests__/       # Resource panels: ResourceInfoPanel, CommentsPanel
│   └── navigation/__tests__/       # Navigation: NavigationMenu, SkipLinks
└── hooks/__tests__/                # Custom hooks
```

### Real Examples

Our codebase includes 1300+ tests demonstrating these patterns:

- **[LeftSidebar.test.tsx](../src/components/layout/__tests__/LeftSidebar.test.tsx)** - Layout component with real NavigationMenu and SemiontBranding
- **[UnifiedHeader.test.tsx](../src/components/layout/__tests__/UnifiedHeader.test.tsx)** - Header with real child components and dropdown hook
- **[PageLayout.test.tsx](../src/components/layout/__tests__/PageLayout.test.tsx)** - Full page layout with a real UnifiedHeader
- **[BrowseView.test.tsx](../src/components/resource/__tests__/BrowseView.test.tsx)** - Event-driven component listening on the real bus
- **[AnnotateToolbar.test.tsx](../src/components/annotation/__tests__/AnnotateToolbar.test.tsx)** - Presentational component: values in, choices reported through callbacks
- **[ResourceInfoPanel.test.tsx](../src/components/resource/panels/__tests__/ResourceInfoPanel.test.tsx)** - Panel component with event tracking

### Key Benefits

1. **Confidence** - Tests match production behavior
2. **Refactoring** - Change component internals without breaking tests
3. **Integration bugs** - Catch real component interaction issues
4. **Maintenance** - No mock updates when component APIs change
5. **Documentation** - Tests show how components actually work

## See Also

- [SESSION.md](SESSION.md) - Provider configuration
- [API-INTEGRATION.md](API-INTEGRATION.md) - Testing API hooks
- [COMPONENTS.md](COMPONENTS.md) - Component testing examples
