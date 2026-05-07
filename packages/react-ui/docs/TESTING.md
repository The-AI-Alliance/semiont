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

For components that use EventBus, use the **EventTracker pattern** instead of mocking EventBus methods:

**❌ Don't: Mock EventBus methods**
```tsx
// WRONG - Breaks real event flow
vi.spyOn(EventBus, 'on');
vi.spyOn(EventBus, 'emit');
```

**✅ Do: Use EventTracker to verify events**
```tsx
// CORRECT - Real EventBus with event tracking
import { createEventTracker, EventTrackingWrapper } from '@/test-utils/eventTracker';

it('should emit resource-selected event', () => {
  const tracker = createEventTracker();

  render(
    <EventTrackingWrapper tracker={tracker}>
      <BrowseView {...props} />
    </EventTrackingWrapper>
  );

  fireEvent.click(screen.getByText('Resource 1'));

  expect(tracker.getEvents('resource-selected')).toHaveLength(1);
  expect(tracker.getLastEvent('resource-selected')?.payload).toEqual({
    resourceId: 'res-1',
    resourceName: 'Resource 1'
  });
});
```

**EventTracker benefits:**
- Tests real EventBus subscriptions and emissions
- Verifies event payloads and order
- No mock maintenance when EventBus API changes
- Catches event-driven integration bugs
- Provides helper methods: `getEvents()`, `getLastEvent()`, `clearEvents()`

**Real example from BrowseView.test.tsx:**
```tsx
describe('Event Emissions', () => {
  it('should emit resource-selected when clicking resource', () => {
    const tracker = createEventTracker();

    render(
      <EventTrackingWrapper tracker={tracker}>
        <BrowseView resources={mockResources} />
      </EventTrackingWrapper>
    );

    fireEvent.click(screen.getByText('Document 1'));

    const events = tracker.getEvents('resource-selected');
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      resourceId: 'doc-1',
      resourceName: 'Document 1'
    });
  });
});
```

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
import { renderWithProviders, createMockTranslationManager, createMockKnowledgeBaseSession } from '@semiont/react-ui/test-utils';

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
    knowledgeBaseSession: createMockKnowledgeBaseSession({
      isAuthenticated: true,
      token: 'test-token',
      expiresAt: new Date(Date.now() + 3600000),
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

### createMockKnowledgeBaseSession

Creates a `KnowledgeBaseSessionContext` value with custom overrides. Tests pass it via `knowledgeBaseSession` to `renderWithProviders`:

```tsx
import { createMockKnowledgeBaseSession } from '@semiont/react-ui/test-utils';

const session = createMockKnowledgeBaseSession({
  isAuthenticated: true,
  isAdmin: true,
  displayName: 'Alice',
  expiresAt: new Date(Date.now() + 300000), // 5 minutes
});

renderWithProviders(<UserBadge />, { knowledgeBaseSession: session });
```

For modal tests, set the modal-driving flags directly:

```tsx
const session = createMockKnowledgeBaseSession({
  sessionExpiredAt: Date.now(),
  sessionExpiredMessage: 'Token expired at 5pm',
  acknowledgeSessionExpired: vi.fn(),
});

renderWithProviders(<SessionExpiredModal />, { knowledgeBaseSession: session });
```

### createMockOpenResourcesManager

Creates an open resources manager:

```tsx
import { createMockOpenResourcesManager } from '@semiont/react-ui/test-utils';

const resources = createMockOpenResourcesManager([
  { id: 'doc-1', name: 'Document 1', openedAt: Date.now() },
  { id: 'doc-2', name: 'Document 2', openedAt: Date.now() }
]);

renderWithProviders(<OpenDocumentsList />, {
  openResourcesManager: resources
});

// Verify mock functions were called
expect(resources.addResource).toHaveBeenCalledWith('doc-3', 'New Doc');
```

## Default Mocks

When you don't provide custom values, `renderWithProviders` uses these defaults:

```typescript
{
  translationManager: {
    t: (namespace, key) => `${namespace}.${key}` // Returns "Toolbar.save"
  },

  apiBaseUrl: 'http://localhost:4000', // default

  knowledgeBaseSession: {
    // Defaults from defaultMockKnowledgeBaseSession — all auth flags false,
    // empty KB list, no active KB, no session, no modal flags raised.
    isAuthenticated: false,
    isAdmin: false,
    isModerator: false,
    activeKnowledgeBase: null,
    session: null,
    sessionExpiredAt: null,
    permissionDeniedAt: null,
    // ...mutations are vi.fn() stubs
  },

  openResourcesManager: {
    openResources: [],
    addResource: vi.fn(),
    removeResource: vi.fn(),
    updateResourceName: vi.fn(),
    reorderResources: vi.fn()
  }
}
```

## Testing API Integration

### Mocking API Client

```tsx
import { vi } from 'vitest';
import { SemiontApiClient } from '@semiont/api-client';

it('should fetch resources', async () => {
  // Spy on the namespace method that the component uses.
  // The ApiClientProvider inside renderWithProviders constructs the client;
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
creates a real `SemiontApiClient` internally; prototype spies intercept
calls from that instance.

```tsx
import { BrowseNamespace } from '@semiont/api-client';
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

```tsx
import { renderWithProviders, createMockKnowledgeBaseSession } from '@semiont/react-ui/test-utils';

describe('SessionExpiryBanner', () => {
  it('should show warning when expiring soon', () => {
    const session = createMockKnowledgeBaseSession({
      isAuthenticated: true,
      expiresAt: new Date(Date.now() + 60000), // 1 minute
    });

    renderWithProviders(<SessionExpiryBanner />, { knowledgeBaseSession: session });

    expect(screen.getByText(/expiring soon/i)).toBeInTheDocument();
  });

  it('should not show when not expiring soon', () => {
    const session = createMockKnowledgeBaseSession({
      isAuthenticated: true,
      expiresAt: new Date(Date.now() + 3600000), // 1 hour
    });

    renderWithProviders(<SessionExpiryBanner />, { knowledgeBaseSession: session });

    expect(screen.queryByText(/expiring soon/i)).not.toBeInTheDocument();
  });
});
```

## Testing User Interactions

```tsx
import { renderWithProviders, screen } from '@semiont/react-ui/test-utils';
import { userEvent } from '@testing-library/user-event';

it('should call addResource when button clicked', async () => {
  const user = userEvent.setup();
  const mockManager = createMockOpenResourcesManager();

  renderWithProviders(<AddDocumentButton />, {
    openResourcesManager: mockManager
  });

  await user.click(screen.getByRole('button', { name: /add/i }));

  expect(mockManager.addResource).toHaveBeenCalledWith(
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
  about: () => '/about',
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

### Testing Event-Driven Components

For components that emit or listen to EventBus events, use the EventTracker pattern:

```tsx
// src/components/annotation/__tests__/AnnotateToolbar.test.tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AnnotateToolbar } from '../AnnotateToolbar';
import { createEventTracker, EventTrackingWrapper } from '@/test-utils/eventTracker';

describe('AnnotateToolbar', () => {
  let tracker: ReturnType<typeof createEventTracker>;

  beforeEach(() => {
    tracker = createEventTracker();
  });

  describe('Event Emissions', () => {
    it('should emit annotation-mode-changed when toggling mode', () => {
      render(
        <EventTrackingWrapper tracker={tracker}>
          <AnnotateToolbar currentMode="select" />
        </EventTrackingWrapper>
      );

      // Click highlight button
      const highlightBtn = screen.getByLabelText('Highlight mode');
      fireEvent.click(highlightBtn);

      // Verify event was emitted
      const events = tracker.getEvents('annotation-mode-changed');
      expect(events).toHaveLength(1);
      expect(events[0].payload).toEqual({ mode: 'highlight' });
    });

    it('should emit save-annotations when save clicked', () => {
      render(
        <EventTrackingWrapper tracker={tracker}>
          <AnnotateToolbar currentMode="highlight" />
        </EventTrackingWrapper>
      );

      fireEvent.click(screen.getByLabelText('Save annotations'));

      const events = tracker.getEvents('save-annotations');
      expect(events).toHaveLength(1);
    });
  });

  describe('Event Subscriptions', () => {
    it('should update UI when receiving annotation-created event', () => {
      const { rerender } = render(
        <EventTrackingWrapper tracker={tracker}>
          <AnnotateToolbar currentMode="select" />
        </EventTrackingWrapper>
      );

      // Simulate EventBus event
      tracker.emit('annotation-created', {
        annotationId: 'ann-1',
        type: 'highlight'
      });

      rerender(
        <EventTrackingWrapper tracker={tracker}>
          <AnnotateToolbar currentMode="select" />
        </EventTrackingWrapper>
      );

      // Verify UI updated - undo button should now be enabled
      expect(screen.getByLabelText('Undo')).not.toBeDisabled();
    });
  });
});
```

**EventTracker API:**
- `tracker.getEvents(eventName)` - Get all events of a specific type
- `tracker.getLastEvent(eventName)` - Get most recent event of a type
- `tracker.clearEvents()` - Reset event history between tests
- `tracker.emit(eventName, payload)` - Simulate EventBus events

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

### ✅ Do: Use EventTracker for event-driven components

```tsx
it('should emit events on interaction', () => {
  const tracker = createEventTracker();

  render(
    <EventTrackingWrapper tracker={tracker}>
      <BrowseView {...props} />
    </EventTrackingWrapper>
  );

  fireEvent.click(screen.getByText('Resource 1'));

  expect(tracker.getEvents('resource-selected')).toHaveLength(1);
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

// CORRECT - Use EventTracker
const tracker = createEventTracker();
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
2. **EventTracker for events** - Event-driven testing with `createEventTracker()` instead of mocking EventBus
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
- React components (`NavigationMenu`, `Footer`, `SemiontBranding`)
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
│   └── navigation/__tests__/       # Navigation: NavigationMenu, Footer
└── hooks/__tests__/                # Custom hooks
```

### Real Examples

Our codebase includes 1300+ tests demonstrating these patterns:

- **[LeftSidebar.test.tsx](../src/components/layout/__tests__/LeftSidebar.test.tsx)** - Layout component with real NavigationMenu and SemiontBranding
- **[UnifiedHeader.test.tsx](../src/components/layout/__tests__/UnifiedHeader.test.tsx)** - Header with real child components and dropdown hook
- **[PageLayout.test.tsx](../src/components/layout/__tests__/PageLayout.test.tsx)** - Full page layout with real UnifiedHeader and Footer
- **[BrowseView.test.tsx](../src/components/resource/__tests__/BrowseView.test.tsx)** - Event-driven component using EventTracker
- **[AnnotateToolbar.test.tsx](../src/components/annotation/__tests__/AnnotateToolbar.test.tsx)** - Event emissions and subscriptions with EventTracker
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
