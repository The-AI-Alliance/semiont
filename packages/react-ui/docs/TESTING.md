# Testing

The test utilities, and the way of testing they are built for, are in the
builder docs: [TESTING.md](../../../docs/builder/react-ui/TESTING.md). This
page is how the library's own tests are run, written and organized.

## Overview

The library includes:

- **1300+ tests** with high coverage
- **Composition-based testing** over vitest module mocks
- **Event-driven architecture** testing patterns
- **Test utilities** for easy component testing
- **Real component integration** for authentic behavior validation
- **Vitest + React Testing Library** setup

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

- [SESSION.md](../../../docs/builder/react-ui/SESSION.md) - Provider configuration
- [API-INTEGRATION.md](../../../docs/builder/react-ui/API-INTEGRATION.md) - Testing API hooks
- [COMPONENTS.md](../../../docs/builder/react-ui/COMPONENTS.md) - Component testing examples
