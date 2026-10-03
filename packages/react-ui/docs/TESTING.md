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
import { NavigationMenu } from '../NavigationMenu';
import { SemiontBranding } from '../SemiontBranding';

it('should render navigation with branding', () => {
  render(
    <LeftSidebar>
      <NavigationMenu {...props} />
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
- **Hooks** for UI state (`useDropdown`, `useModal`)
- **External APIs** (`fetch`, API clients)
- **Browser APIs** not available in jsdom (`scrollIntoView`, `IntersectionObserver`)
- **Utility modules** (`formatDate`, `parseJson`)

### Event-Driven Testing

A component says things on a bus; a test listens on the real bus rather than mocking it.
`renderWithProviders` hands back both buses on request:

```tsx
import { renderWithProviders, screen, fireEvent } from '@semiont/react-ui/test-utils';

// Session-scoped channels (mark:*, beckon:*, browse:click, …): the client's bus
const { eventBus } = renderWithProviders(<ReferenceEntry {...props} />, { returnEventBus: true });
const clicked = vi.fn();
const sub = eventBus!.on('browse:click').subscribe(clicked);

fireEvent.click(screen.getByRole('button'));

expect(clicked).toHaveBeenCalledWith(expect.objectContaining({ annotationId: props.reference.id }));
sub.unsubscribe();
```

```tsx
// App-scoped channels (panel:*, shell:*, tabs:*, nav:*, settings:*): the browser
const { browser } = renderWithProviders(<Toolbar {...props} />, { returnShellBus: true });
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

Renders components with all necessary providers pre-configured.

**Basic Usage:**

```tsx
import { renderWithProviders, screen } from '@semiont/react-ui/test-utils';

it('should render component', () => {
  renderWithProviders(<MyComponent />);
  expect(screen.getByText('Hello')).toBeInTheDocument();
});
```

**With Custom Providers:**

```tsx
import { renderWithProviders, createMockTranslationManager, createTestBrowserWithSignals } from '@semiont/react-ui/test-utils';

it('should work with authenticated client', () => {
  const translations = createMockTranslationManager({
    Toolbar: {
      save: 'Guardar',
      cancel: 'Cancelar'
    }
  });

  renderWithProviders(<MyComponent />, {
    apiBaseUrl: 'https://api.test.com',
    translationManager: translations,
    browser: createTestBrowserWithSignals({
      sessionExpired: { message: 'Token expired' },
    }),
  });

  expect(screen.getByText('Guardar')).toBeInTheDocument();
});
```

## Mock Creators

### createMockTranslationManager

Creates a translation manager with custom translations:

```tsx
import { createMockTranslationManager } from '@semiont/react-ui/test-utils';

const translations = createMockTranslationManager({
  Common: {
    save: 'Save',
    cancel: 'Cancel'
  },
  Toolbar: {
    undo: 'Undo',
    redo: 'Redo'
  }
});

renderWithProviders(<Toolbar />, { translationManager: translations });
```

### createTestBrowserWithSignals

Builds a fake `SemiontBrowser` with the active `SessionSignals` observables
pre-populated, so modal tests can control the modal-driving flags without
driving a real session through its state machine. Tests pass it via the
`browser` option to `renderWithProviders`. The only overrides are the
modal flags and their acknowledgement callbacks:

```tsx
import { createTestBrowserWithSignals } from '@semiont/react-ui/test-utils';

const browser = createTestBrowserWithSignals({
  sessionExpired: { message: 'Token expired at 5pm' },
  acknowledgeSessionExpired: vi.fn(),
});

renderWithProviders(<SessionExpiredModal />, { browser });
```

Permission-denied modal tests follow the same shape:

```tsx
const browser = createTestBrowserWithSignals({
  permissionDenied: { message: 'Not allowed' },
  acknowledgePermissionDenied: vi.fn(),
});

renderWithProviders(<PermissionDeniedModal />, { browser });
```

## Default Mocks

When you don't provide custom values, `renderWithProviders` uses these defaults:

```typescript
{
  translationManager: {
    t: (namespace, key) => `${namespace}.${key}` // Returns "Toolbar.save"
  },

  apiBaseUrl: 'http://localhost:4000', // default

  // browser: when omitted, renderWithProviders builds a fake SemiontBrowser
  // (createFakeBrowserForTests) seeded with a fake active session whose
  // `client` is a real SemiontClient pointed at `apiBaseUrl`. All flags are
  // unset: empty KB list, no active KB, no modal flags raised, mutations are
  // vi.fn() stubs. The app-scoped (shell) bus is a real EventBus so
  // `semiont.emit/on/stream` round-trip through a live subject.
}
```

## Testing API Integration

### Mocking API Client

```tsx
import { vi } from 'vitest';
import { SemiontClient, BrowseNamespace } from '@semiont/sdk';

it('should fetch resources', async () => {
  // Spy on the namespace method that the component uses.
  // The SemiontProvider inside renderWithProviders constructs the client;
  // spy on the prototype to intercept calls from any instance.
  vi.spyOn(BrowseNamespace.prototype, 'resources').mockReturnValue(
    of({ resources: [{ id: 'r1', name: 'Resource 1' }] } as any),
  );

  renderWithProviders(<ResourceList />, {
    apiBaseUrl: 'https://api.test.com',
  });

  await screen.findByText('Resource 1');
});
```

### Testing Bus-Backed Queries

For components that subscribe to `semiont.browse.*` Observables, mock
the namespace methods on the prototype. The `renderWithProviders` helper
creates a real `SemiontClient` internally; prototype spies intercept
calls from that instance.

```tsx
import { BrowseNamespace } from '@semiont/sdk';
import { of, throwError } from 'rxjs';

it('should handle query errors', async () => {
  vi.spyOn(BrowseNamespace.prototype, 'resources').mockReturnValue(
    throwError(() => new Error('Network error')),
  );

  renderWithProviders(<ResourceList />);

  await screen.findByText(/error/i);
});
```

## Testing Translations

### Test with Specific Translations

```tsx
it('should display Spanish translations', () => {
  const translations = createMockTranslationManager({
    Toolbar: {
      save: 'Guardar',
      cancel: 'Cancelar',
      delete: 'Eliminar'
    }
  });

  renderWithProviders(<Toolbar />, { translationManager: translations });

  expect(screen.getByText('Guardar')).toBeInTheDocument();
  expect(screen.getByText('Cancelar')).toBeInTheDocument();
});
```

### Test with Default Mock

```tsx
it('should render with namespace.key format', () => {
  renderWithProviders(<Toolbar />);

  // Default mock returns "Namespace.key"
  expect(screen.getByText('Toolbar.save')).toBeInTheDocument();
  expect(screen.getByText('Toolbar.cancel')).toBeInTheDocument();
});
```

## Testing Session State

`createTestBrowserWithSignals` drives the modal flags on the active
`SessionSignals`. Set `sessionExpired` (or `permissionDenied`) to
raise the corresponding modal, and pass the result via the `browser` option:

```tsx
import { renderWithProviders, createTestBrowserWithSignals } from '@semiont/react-ui/test-utils';

describe('SessionExpiredModal', () => {
  it('should show when the session has expired', () => {
    const browser = createTestBrowserWithSignals({
      sessionExpired: { message: 'Token expired' },
    });

    renderWithProviders(<SessionExpiredModal />, { browser });

    expect(screen.getByText(/session expired/i)).toBeInTheDocument();
  });

  it('should not show when no expiry flag is raised', () => {
    const browser = createTestBrowserWithSignals();

    renderWithProviders(<SessionExpiredModal />, { browser });

    expect(screen.queryByText(/session expired/i)).not.toBeInTheDocument();
  });
});
```

## Testing User Interactions

Open-resource mutations live on the `SemiontBrowser`. Inject a browser
whose mutation is a `vi.fn()` via the `browser` option, then assert on it:

```tsx
import { renderWithProviders, screen, createTestBrowserWithSignals } from '@semiont/react-ui/test-utils';
import { userEvent } from '@testing-library/user-event';

it('should call addOpenResource when button clicked', async () => {
  const user = userEvent.setup();
  const browser = createTestBrowserWithSignals();

  renderWithProviders(<AddDocumentButton />, { browser });

  await user.click(screen.getByRole('button', { name: /add/i }));

  expect(browser.addOpenResource).toHaveBeenCalledWith(
    'doc-123',
    'New Document',
    'text/plain'
  );
});
```

## Snapshot Testing

```tsx
import { renderWithProviders } from '@semiont/react-ui/test-utils';

it('should match snapshot', () => {
  const { container } = renderWithProviders(<NavigationMenu />);
  expect(container).toMatchSnapshot();
});
```

## Testing Accessibility

```tsx
import { renderWithProviders, screen } from '@semiont/react-ui/test-utils';
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

it('should have no accessibility violations', async () => {
  const { container } = renderWithProviders(<Toolbar />);
  const results = await axe(container);
  expect(results).toHaveNoViolations();
});

it('should have proper ARIA labels', () => {
  renderWithProviders(<CloseButton />);

  const button = screen.getByRole('button', { name: /close/i });
  expect(button).toHaveAttribute('aria-label', 'Close');
});
```

## Testing Keyboard Navigation

```tsx
import { userEvent } from '@testing-library/user-event';

it('should navigate with keyboard', async () => {
  const user = userEvent.setup();

  renderWithProviders(<NavigationMenu />);

  const firstLink = screen.getByRole('link', { name: /home/i });
  firstLink.focus();

  await user.keyboard('{Tab}');

  const secondLink = screen.getByRole('link', { name: /know/i });
  expect(secondLink).toHaveFocus();
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
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { LeftSidebar } from '../LeftSidebar';

// No mocks - using real components via composition

// Mock Link component
const MockLink = ({ href, children, ...props }: any) => (
  <a href={href} {...props}>{children}</a>
);

// Mock routes
const mockRoutes = {
  home: () => '/',
} as any;

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
      expect(nav).toHaveAttribute('id', 'main-navigation');
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
// src/hooks/__tests__/useMyHook.test.ts
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useMyHook } from '../useMyHook';

describe('useMyHook', () => {
  it('should return initial value', () => {
    const { result } = renderHook(() => useMyHook());

    expect(result.current.value).toBe(0);
  });

  it('should update value', () => {
    const { result } = renderHook(() => useMyHook());

    act(() => {
      result.current.increment();
    });

    expect(result.current.value).toBe(1);
  });
});
```

## Known Test Issues

### SearchModal Tests (Skipped)

All SearchModal component tests are currently skipped due to memory issues with HeadlessUI Dialog in jsdom:

- **Issue**: HeadlessUI's `<Dialog>` component creates complex DOM structures with portals, transitions, and focus management that cause Out Of Memory errors in jsdom, even with increased heap size
- **Impact**: 38 tests across 4 test files are skipped
- **Files affected**:
  - `SearchModal.basic.test.tsx` (8 tests)
  - `SearchModal.visual.test.tsx` (15 tests)
  - `SearchModal.accessibility.test.tsx` (7 tests)
  - `SearchModal.keyboard.test.tsx` (8 tests)

**Potential solutions**:
1. Mock HeadlessUI Dialog component entirely
2. Use Playwright/Cypress for integration tests instead of jsdom
3. Redesign SearchModal to use a lighter modal implementation

The tests remain in place with detailed TODO comments for future implementation.

## Best Practices

### ✅ Do: Use real components via composition

```tsx
// CORRECT - Test with real child components
import { NavigationMenu } from '../NavigationMenu';

it('should render navigation', () => {
  render(
    <LeftSidebar>
      <NavigationMenu {...props} />
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

// CORRECT - Mock browser APIs not in jsdom
vi.mock('window.scrollTo', () => vi.fn());
```

### ✅ Do: Test actual rendered content

```tsx
it('should display translated text', () => {
  render(<MyComponent t={(key) => `translated.${key}`} />);

  // Verify actual text rendered by component
  expect(screen.getByText('translated.title')).toBeInTheDocument();
});
```

### ✅ Do: Test error states

```tsx
it('should display error message on failure', async () => {
  vi.spyOn(BrowseNamespace.prototype, 'resources').mockReturnValue(
    throwError(() => new Error('Network error')),
  );

  renderWithProviders(<ResourceList />);

  await screen.findByText(/error/i);
});
```

### ✅ Do: Test loading states

```tsx
it('should show loading spinner', () => {
  renderWithProviders(<ResourceList />);
  expect(screen.getByRole('status')).toBeInTheDocument();
});
```

### ❌ Don't: Use vi.mock() for React components

```tsx
// WRONG - Global mock affects all tests
vi.mock('../NavigationMenu', () => ({
  NavigationMenu: () => <div>Mock</div>
}));

// CORRECT - Use real component
import { NavigationMenu } from '../NavigationMenu';
```

### ❌ Don't: Mock EventBus methods

```tsx
// WRONG - Breaks real event flow
vi.spyOn(EventBus, 'on');
vi.spyOn(EventBus, 'emit');

// CORRECT - Listen on the real bus
const { eventBus } = renderWithProviders(<MyComponent />, { returnEventBus: true });
const seen = vi.fn();
eventBus!.on('browse:click').subscribe(seen);
```

### ❌ Don't: Test implementation details

```tsx
// WRONG - Testing internal state
expect(component.state.count).toBe(5);

// CORRECT - Testing behavior
expect(screen.getByText('Count: 5')).toBeInTheDocument();
```

### ❌ Don't: Make tests dependent on each other

```tsx
// WRONG - Tests share state
let sharedData;

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
2. **The real bus for events** - A test subscribes on the bus `renderWithProviders` returns instead of mocking `EventBus`
3. **Mock minimally** - Only mock hooks, external APIs, and browser APIs not available in jsdom
4. **Test behavior, not implementation** - Verify what users see, not internal state
5. **Isolated tests** - Each test is independent with clean state

### What to Mock

**✅ DO Mock:**
- UI state hooks (`useDropdown`, `useModal`, `useCollapsible`)
- External APIs (`fetch`, API client methods)
- Browser APIs not in jsdom (`scrollIntoView`, `IntersectionObserver`)
- Utility modules (`formatDate`, `parseJson`)

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
- **[AnnotateToolbar.test.tsx](../src/components/annotation/__tests__/AnnotateToolbar.test.tsx)** - Event emissions and subscriptions on the real bus
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
