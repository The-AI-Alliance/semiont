# React UI Accessibility Architecture

## Overview

`@semiont/react-ui` is built with accessibility as a core design principle. This document details the accessibility architecture, patterns, and utilities provided by the component library.

**WCAG Compliance:** 2.1 Level AA

## Table of Contents

1. [Core Components](#core-components)
2. [Accessibility Hooks](#accessibility-hooks)
3. [ARIA Patterns](#aria-patterns)
4. [Testing Infrastructure](#testing-infrastructure)
5. [Component Patterns](#component-patterns)
6. [Live Regions & Announcements](#live-regions--announcements)
7. [Focus Management](#focus-management)
8. [Development Guidelines](#development-guidelines)

## Core Components

### SkipLinks

Provides keyboard users quick navigation to main content areas:

```tsx
import { SkipLinks } from '@semiont/react-ui';

// Automatically hidden, visible on focus
<SkipLinks />

// Generates:
// - Skip to main content
// - Skip to navigation
// - Skip to search
```

**Implementation Details:**
- Uses `sr-only focus-within:not-sr-only` for visibility
- High z-index (`z-[9999]`) to overlay all content
- Focus ring and hover states for visibility

### KeyboardShortcutsHelpModal

Displays all available keyboard shortcuts:

```tsx
import { KeyboardShortcutsHelpModal } from '@semiont/react-ui';

<KeyboardShortcutsHelpModal
  isOpen={showHelp}
  onClose={() => setShowHelp(false)}
/>
```

**Features:**
- Grouped shortcuts by category
- Platform-aware (Mac vs Windows/Linux)
- Fully keyboard navigable
- Screen reader friendly descriptions

## Accessibility Hooks

### useKeyboardShortcuts

Manages keyboard shortcuts with platform detection:

```tsx
import { useKeyboardShortcuts } from '@semiont/react-ui';

function MyComponent() {
  useKeyboardShortcuts([
    {
      key: 's',
      ctrlOrCmd: true,
      handler: () => saveDocument(),
      description: 'Save document',
      enabled: canSave
    },
    {
      key: 'Escape',
      handler: () => closeModal(),
      description: 'Close modal'
    }
  ]);
}
```

**Features:**
- Automatic platform detection (Cmd on Mac, Ctrl on Windows/Linux)
- Context-aware (disabled in input fields)
- Prevents browser default behaviors
- TypeScript typed for safety

### useRovingTabIndex

Implements WAI-ARIA roving tabindex pattern:

```tsx
import { useRovingTabIndex } from '@semiont/react-ui';

function ListComponent({ items }) {
  const { containerRef, handleKeyDown, focusItem } = useRovingTabIndex(
    items.length,
    {
      orientation: 'vertical',
      loop: true
    }
  );

  return (
    <ul ref={containerRef} onKeyDown={handleKeyDown}>
      {items.map((item, index) => (
        <li key={item.id} tabIndex={-1}>
          {item.name}
        </li>
      ))}
    </ul>
  );
}
```

**Supported Navigation:**
- Arrow keys (orientation aware)
- Home/End keys
- Grid navigation support
- Loop or bounded navigation

### useLiveRegion

Announces dynamic content to screen readers:

```tsx
import { useLiveRegion } from '@semiont/react-ui';

function SearchComponent() {
  const { announce } = useLiveRegion();

  const handleSearch = async (query) => {
    announce('Searching...', 'polite');
    const results = await search(query);
    announce(
      `${results.length} results found`,
      'polite'
    );
  };
}
```

**Priority Levels:**
- `polite` - Waits for current speech to finish
- `assertive` - Interrupts current speech

### useDoubleKeyPress

Detects double key press patterns:

```tsx
import { useDoubleKeyPress } from '@semiont/react-ui';

function App() {
  // Double Escape closes all overlays
  useDoubleKeyPress('Escape', () => {
    closeAllModals();
  }, 300); // 300ms timeout
}
```

## ARIA Patterns

### Modal Dialogs

All modals use Headless UI Dialog for consistency:

```tsx
import { Dialog } from '@headlessui/react';

export function AccessibleModal({ isOpen, onClose, title, children }) {
  return (
    <Dialog
      open={isOpen}
      onClose={onClose}
      aria-labelledby="dialog-title"
    >
      <Dialog.Overlay className="fixed inset-0 bg-black/30" />
      <Dialog.Panel>
        <Dialog.Title id="dialog-title">
          {title}
        </Dialog.Title>
        {children}
      </Dialog.Panel>
    </Dialog>
  );
}
```

**Features:**
- Focus trap management
- Focus restoration on close
- Escape key handling
- Click outside to close

### Combobox Pattern

Accessible autocomplete implementation:

```tsx
import { Combobox } from '@headlessui/react';

export function SearchCombobox({ options }) {
  return (
    <Combobox>
      <Combobox.Input
        aria-label="Search"
        aria-autocomplete="list"
        aria-expanded={open}
      />
      <Combobox.Options>
        {options.map(option => (
          <Combobox.Option key={option.id} value={option}>
            {option.name}
          </Combobox.Option>
        ))}
      </Combobox.Options>
    </Combobox>
  );
}
```

### Tab Pattern

Accessible tabs with proper ARIA attributes:

```tsx
export function TabsComponent({ tabs }) {
  return (
    <div>
      <div role="tablist" aria-label="Resource sections">
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={selectedIndex === index}
            aria-controls={`panel-${tab.id}`}
            id={`tab-${tab.id}`}
            tabIndex={selectedIndex === index ? 0 : -1}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab, index) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`panel-${tab.id}`}
          aria-labelledby={`tab-${tab.id}`}
          hidden={selectedIndex !== index}
          tabIndex={0}
        >
          {tab.content}
        </div>
      ))}
    </div>
  );
}
```

## Testing Infrastructure

### Accessibility Test Files

Dedicated `.a11y.test.tsx` files for components:

```tsx
// SignInForm.a11y.test.tsx
import { render } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { SignInForm } from '../SignInForm';

expect.extend(toHaveNoViolations);

describe('SignInForm Accessibility', () => {
  it('should have no WCAG violations', async () => {
    const { container } = render(
      <SignInForm {...props} />
    );

    const results = await axe(container, {
      rules: {
        // Configure specific rules if needed
        'color-contrast': { enabled: true },
        'label': { enabled: true }
      }
    });

    expect(results).toHaveNoViolations();
  });

  it('should have proper focus management', () => {
    const { getByLabelText } = render(
      <SignInForm {...props} />
    );

    const emailInput = getByLabelText('Email');
    emailInput.focus();
    expect(document.activeElement).toBe(emailInput);
  });
});
```

### Test Utilities

Helper functions for accessibility testing:

```tsx
// test-utils/accessibility.ts
export function renderWithA11y(component: React.ReactElement) {
  const { container, ...rest } = render(component);

  return {
    container,
    ...rest,
    checkA11y: async () => {
      const results = await axe(container);
      return results;
    }
  };
}

// Usage
const { checkA11y } = renderWithA11y(<MyComponent />);
const results = await checkA11y();
expect(results).toHaveNoViolations();
```

## Component Patterns

### Form Components

All form components include:

```tsx
export interface AccessibleInputProps {
  label: string;
  error?: string;
  required?: boolean;
  description?: string;
}

export function AccessibleInput({
  label,
  error,
  required,
  description,
  ...props
}: AccessibleInputProps) {
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const descId = `${inputId}-desc`;

  return (
    <div>
      <label htmlFor={inputId}>
        {label}
        {required && <span aria-label="required">*</span>}
      </label>

      {description && (
        <span id={descId} className="text-sm text-gray-600">
          {description}
        </span>
      )}

      <input
        id={inputId}
        aria-required={required}
        aria-invalid={!!error}
        aria-describedby={
          [description && descId, error && errorId]
            .filter(Boolean)
            .join(' ') || undefined
        }
        {...props}
      />

      {error && (
        <span id={errorId} role="alert" className="text-red-500">
          {error}
        </span>
      )}
    </div>
  );
}
```

### Loading States

Accessible loading indicators:

```tsx
export function LoadingState({ message = 'Loading...' }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="flex items-center gap-2"
    >
      <Spinner aria-hidden="true" />
      <span className="sr-only">{message}</span>
    </div>
  );
}
```

### Empty States

Informative empty states:

```tsx
export function EmptyState({
  title,
  description,
  action
}: EmptyStateProps) {
  return (
    <div role="status" aria-label="No content available">
      <h3>{title}</h3>
      <p>{description}</p>
      {action && (
        <button
          onClick={action.onClick}
          aria-label={action.label}
        >
          {action.text}
        </button>
      )}
    </div>
  );
}
```

## Live Regions & Announcements

### LiveRegionProvider

Provides screen reader announcements:

```tsx
import { LiveRegionProvider } from '@semiont/react-ui';

export function App() {
  return (
    <LiveRegionProvider>
      {/* Your app components */}
    </LiveRegionProvider>
  );
}
```

### Specialized Announcement Hooks

```tsx
// Search announcements
import { useSearchAnnouncements } from '@semiont/react-ui';

function Search() {
  const { announceSearchResults, announceSearching } = useSearchAnnouncements();

  const handleSearch = async (query) => {
    announceSearching();
    const results = await search(query);
    announceSearchResults(results.length, query);
  };
}

// Document announcements
import { useDocumentAnnouncements } from '@semiont/react-ui';

function DocumentEditor() {
  const {
    announceDocumentSaved,
    announceDocumentDeleted,
    announceError
  } = useDocumentAnnouncements();

  const handleSave = async () => {
    try {
      await save();
      announceDocumentSaved();
    } catch (error) {
      announceError(error.message);
    }
  };
}
```

## Focus Management

### Focus Restoration

Components restore focus after operations:

```tsx
export function ModalWithFocusRestore({ trigger, content }) {
  const triggerRef = useRef<HTMLElement>(null);
  const [isOpen, setIsOpen] = useState(false);

  const handleClose = () => {
    setIsOpen(false);
    // Restore focus to trigger
    triggerRef.current?.focus();
  };

  return (
    <>
      <button ref={triggerRef} onClick={() => setIsOpen(true)}>
        {trigger}
      </button>
      <Modal isOpen={isOpen} onClose={handleClose}>
        {content}
      </Modal>
    </>
  );
}
```

### Focus Trap

Custom focus trap implementation:

```tsx
export function FocusTrap({ children, active }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) return;

    const container = containerRef.current;
    if (!container) return;

    // Get focusable elements
    const focusable = container.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );

    const firstFocusable = focusable[0] as HTMLElement;
    const lastFocusable = focusable[focusable.length - 1] as HTMLElement;

    // Focus first element
    firstFocusable?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;

      if (e.shiftKey) {
        if (document.activeElement === firstFocusable) {
          e.preventDefault();
          lastFocusable?.focus();
        }
      } else {
        if (document.activeElement === lastFocusable) {
          e.preventDefault();
          firstFocusable?.focus();
        }
      }
    };

    container.addEventListener('keydown', handleKeyDown);
    return () => container.removeEventListener('keydown', handleKeyDown);
  }, [active]);

  return <div ref={containerRef}>{children}</div>;
}
```

## Development Guidelines

### Component Checklist

When creating new components:

- [ ] Use semantic HTML
- [ ] Add proper ARIA attributes
- [ ] Implement keyboard navigation
- [ ] Include focus indicators
- [ ] Add screen reader announcements
- [ ] Write accessibility tests
- [ ] Document keyboard shortcuts

### TypeScript Support

Type-safe accessibility props:

```tsx
export interface A11yProps {
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  'aria-live'?: 'polite' | 'assertive' | 'off';
  'aria-busy'?: boolean;
  'aria-invalid'?: boolean;
  'aria-required'?: boolean;
  'aria-expanded'?: boolean;
  'aria-haspopup'?: boolean | 'menu' | 'listbox' | 'tree' | 'grid' | 'dialog';
  'aria-current'?: boolean | 'page' | 'step' | 'location' | 'date' | 'time';
  role?: string;
  tabIndex?: number;
}

export interface AccessibleComponentProps extends A11yProps {
  // Component specific props
}
```

### CSS Classes

Tailwind utilities for accessibility:

```tsx
// Focus visible states
const focusClasses = 'focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2';

// Screen reader only
const srOnly = 'sr-only';

// Visible on focus (skip links)
const srOnlyFocusable = 'sr-only focus:not-sr-only';

// High contrast mode support
const highContrast = 'contrast-more:border-slate-400 contrast-more:border-2';

// Reduced motion
const reducedMotion = 'motion-reduce:transition-none motion-reduce:animate-none';
```

## Best Practices

### 1. Progressive Enhancement

```tsx
// Start with HTML that works without JavaScript
<form method="POST" action="/api/submit">
  <input name="title" required />
  <button type="submit">Submit</button>
</form>

// Enhance with JavaScript
<form onSubmit={handleSubmit}>
  {/* Same form with enhanced behavior */}
</form>
```

### 2. Descriptive Labels

```tsx
// Bad: Generic label
<button aria-label="Delete">🗑️</button>

// Good: Descriptive label
<button aria-label="Delete document 'Project Proposal'">
  🗑️
</button>
```

### 3. Error Handling

```tsx
// Announce errors to screen readers
const handleError = (error: Error) => {
  announce(`Error: ${error.message}`, 'assertive');
  setError(error);
};
```

### 4. Loading States

```tsx
// Inform screen readers of loading state
<div aria-live="polite" aria-busy={isLoading}>
  {isLoading ? 'Loading...' : `${results.length} results`}
</div>
```

## Testing Commands

```bash
# Run all tests including accessibility
npm test

# Run only accessibility tests
npm test -- --grep "accessibility|a11y"

# Generate accessibility report
npm run test:a11y:report

# Run axe-core on specific component
npm test -- SignInForm.a11y.test.tsx
```

## Resources

- [WAI-ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)
- [Headless UI Documentation](https://headlessui.com/)
- [Jest-axe Documentation](https://github.com/nickcolley/jest-axe)
- [React Accessibility Documentation](https://react.dev/reference/react-dom/components#accessibility-attributes)

## Related Documentation

- [Component Documentation](./COMPONENTS.md)
- [Testing Guide](./TESTING.md)
- [Frontend Accessibility](../../apps/frontend/docs/ACCESSIBILITY.md)