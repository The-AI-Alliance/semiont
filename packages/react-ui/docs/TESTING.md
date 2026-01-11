# Testing

Comprehensive testing guide for `@semiont/react-ui` components and applications using the library.

## Overview

The library includes:

- **800+ tests** with high coverage
- **Test utilities** for easy component testing
- **Mock providers** for all cross-cutting concerns
- **Vitest + React Testing Library** setup

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
import { renderWithProviders, createMockTranslationManager } from '@semiont/react-ui/test-utils';
import { SemiontApiClient } from '@semiont/api-client';

it('should work with authenticated client', () => {
  const mockClient = new SemiontApiClient({
    baseUrl: 'https://api.test.com',
    accessToken: 'test-token'
  });

  const translations = createMockTranslationManager({
    Toolbar: {
      save: 'Guardar',
      cancel: 'Cancelar'
    }
  });

  renderWithProviders(<MyComponent />, {
    apiClientManager: { client: mockClient },
    translationManager: translations,
    sessionManager: {
      isAuthenticated: true,
      expiresAt: new Date(Date.now() + 3600000),
      timeUntilExpiry: 3600000,
      isExpiringSoon: false
    }
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

### createMockSessionManager

Creates a session manager with custom state:

```tsx
import { createMockSessionManager } from '@semiont/react-ui/test-utils';

const session = createMockSessionManager({
  isAuthenticated: true,
  expiresAt: new Date(Date.now() + 300000), // 5 minutes
  timeUntilExpiry: 300000,
  isExpiringSoon: true
});

renderWithProviders(<SessionBanner />, { sessionManager: session });
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

  apiClientManager: {
    client: null // Unauthenticated by default
  },

  sessionManager: {
    isAuthenticated: false,
    expiresAt: null,
    timeUntilExpiry: null,
    isExpiringSoon: false
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
  // Create mock client
  const mockClient = new SemiontApiClient({
    baseUrl: 'https://api.test.com',
    accessToken: 'test-token'
  });

  // Mock the API method
  vi.spyOn(mockClient, 'listResources').mockResolvedValue({
    resources: [
      { id: 'r1', name: 'Resource 1', created: new Date() }
    ]
  });

  renderWithProviders(<ResourceList />, {
    apiClientManager: { client: mockClient }
  });

  // Wait for async loading
  await screen.findByText('Resource 1');

  expect(mockClient.listResources).toHaveBeenCalled();
});
```

### Testing React Query Hooks

```tsx
import { QueryClient } from '@tanstack/react-query';
import { renderWithProviders } from '@semiont/react-ui/test-utils';

it('should handle query errors', async () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false }, // Disable retries for tests
      mutations: { retry: false }
    }
  });

  const mockClient = new SemiontApiClient({ ... });
  vi.spyOn(mockClient, 'listResources').mockRejectedValue(
    new Error('Network error')
  );

  renderWithProviders(<ResourceList />, {
    apiClientManager: { client: mockClient },
    queryClient
  });

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
import { renderWithProviders, createMockSessionManager } from '@semiont/react-ui/test-utils';

describe('SessionExpiryBanner', () => {
  it('should show warning when expiring soon', () => {
    const session = createMockSessionManager({
      isAuthenticated: true,
      expiresAt: new Date(Date.now() + 60000), // 1 minute
      timeUntilExpiry: 60000,
      isExpiringSoon: true
    });

    renderWithProviders(<SessionExpiryBanner />, { sessionManager: session });

    expect(screen.getByText(/expiring soon/i)).toBeInTheDocument();
  });

  it('should not show when not expiring soon', () => {
    const session = createMockSessionManager({
      isAuthenticated: true,
      expiresAt: new Date(Date.now() + 3600000), // 1 hour
      timeUntilExpiry: 3600000,
      isExpiringSoon: false
    });

    renderWithProviders(<SessionExpiryBanner />, { sessionManager: session });

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

```tsx
// src/components/MyComponent/__tests__/MyComponent.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MyComponent } from '../MyComponent';
import { TranslationProvider } from '../../../contexts/TranslationContext';

describe('MyComponent', () => {
  const mockTranslationManager = {
    t: (namespace: string, key: string) => `${namespace}.${key}`
  };

  const renderComponent = (props = {}) => {
    return render(
      <TranslationProvider translationManager={mockTranslationManager}>
        <MyComponent {...props} />
      </TranslationProvider>
    );
  };

  describe('Rendering', () => {
    it('should render without crashing', () => {
      const { container } = renderComponent();
      expect(container).toBeInTheDocument();
    });

    it('should display translated text', () => {
      renderComponent();
      expect(screen.getByText('MyComponent.title')).toBeInTheDocument();
    });
  });

  describe('Props', () => {
    it('should accept custom className', () => {
      renderComponent({ className: 'custom-class' });
      expect(screen.getByTestId('my-component')).toHaveClass('custom-class');
    });
  });

  describe('User Interactions', () => {
    it('should call onClick when clicked', async () => {
      const handleClick = vi.fn();
      const user = userEvent.setup();

      renderComponent({ onClick: handleClick });

      await user.click(screen.getByRole('button'));

      expect(handleClick).toHaveBeenCalledTimes(1);
    });
  });

  describe('Edge Cases', () => {
    it('should handle missing translations gracefully', () => {
      const emptyManager = { t: () => '' };

      render(
        <TranslationProvider translationManager={emptyManager}>
          <MyComponent />
        </TranslationProvider>
      );

      expect(screen.getByTestId('my-component')).toBeInTheDocument();
    });
  });
});
```

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

## Best Practices

### ✅ Do: Use renderWithProviders for integration tests

```tsx
it('should work end-to-end', () => {
  renderWithProviders(<MyFeature />);
  // Tests the component with all providers
});
```

### ✅ Do: Create focused unit tests

```tsx
it('should format date correctly', () => {
  const result = formatDate(new Date('2024-01-01'));
  expect(result).toBe('Jan 1, 2024');
});
```

### ✅ Do: Test error states

```tsx
it('should display error message on failure', async () => {
  const mockClient = createMockClient();
  vi.spyOn(mockClient, 'listResources').mockRejectedValue(
    new Error('Network error')
  );

  renderWithProviders(<ResourceList />, {
    apiClientManager: { client: mockClient }
  });

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
```

## See Also

- [PROVIDERS.md](PROVIDERS.md) - Provider configuration
- [API-INTEGRATION.md](API-INTEGRATION.md) - Testing API hooks
- [COMPONENTS.md](COMPONENTS.md) - Component testing examples
