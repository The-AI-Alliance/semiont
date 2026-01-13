# Frontend Accessibility Guide

## Overview

The Semiont frontend implements comprehensive accessibility features to ensure an inclusive experience for all users. This document covers frontend-specific accessibility implementations, testing procedures, and best practices.

**Standards Compliance:** WCAG 2.1 Level AA

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Next.js Accessibility Features](#nextjs-accessibility-features)
3. [Routing & Navigation](#routing--navigation)
4. [Form Handling](#form-handling)
5. [Testing Procedures](#testing-procedures)
6. [Keyboard Shortcuts](#keyboard-shortcuts)
7. [Screen Reader Support](#screen-reader-support)
8. [Development Guidelines](#development-guidelines)

## Architecture Overview

The frontend accessibility architecture consists of:

- **Next.js App Router** - Server-side rendering for better accessibility
- **@semiont/react-ui** - Accessible components with built-in semantic CSS and ARIA support
- **Headless UI** - Fully accessible component primitives for app-specific components
- **Tailwind CSS** - Utility classes for focus states and responsive design in app layouts
- **React Query** - Accessible loading and error states
- **NextAuth.js** - Accessible authentication flows

## Next.js Accessibility Features

### Server-Side Rendering (SSR)

SSR provides several accessibility benefits:

```tsx
// app/[locale]/layout.tsx
export default function RootLayout({
  children,
  params: { locale }
}: {
  children: React.ReactNode;
  params: { locale: string };
}) {
  return (
    <html lang={locale}>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body>
        <SkipLinks /> {/* Imported from @semiont/react-ui */}
        {children}
      </body>
    </html>
  );
}
```

### Metadata Management

Page-specific metadata for screen readers:

```tsx
// app/[locale]/know/discover/page.tsx
export const metadata = {
  title: 'Discover Resources - Semiont',
  description: 'Search and discover knowledge resources'
};
```

### Image Optimization

Next.js Image component with required alt text:

```tsx
import Image from 'next/image';

<Image
  src="/logo.png"
  alt="Semiont logo"
  width={200}
  height={50}
  priority // For above-the-fold images
/>
```

## Routing & Navigation

### Accessible Routing

The frontend uses Next.js routing with accessibility enhancements:

```tsx
// src/i18n/routing.tsx
import { useRouter } from '@/i18n/routing';

function NavigationMenu() {
  const router = useRouter();
  const pathname = usePathname();

  return (
    <nav role="navigation" aria-label="Main navigation">
      <Link
        href="/know"
        aria-current={pathname.includes('/know') ? 'page' : undefined}
      >
        Knowledge Base
      </Link>
    </nav>
  );
}
```

### Focus Management on Route Change

```tsx
// src/app/[locale]/layout.tsx
'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

export function RouteChangeHandler() {
  const pathname = usePathname();

  useEffect(() => {
    // Reset focus to main content on route change
    const mainContent = document.getElementById('main-content');
    if (mainContent) {
      mainContent.focus();
    }

    // Announce route change to screen readers
    const title = document.title;
    announce(`Navigated to ${title}`, 'polite');
  }, [pathname]);

  return null;
}
```

## Form Handling

### Accessible Form Components

All forms implement proper labeling and error handling:

```tsx
// src/components/forms/DocumentForm.tsx
export function DocumentForm() {
  const [errors, setErrors] = useState({});

  return (
    <form role="form" aria-label="Create document">
      <div>
        <label htmlFor="title" className="sr-only">
          Document Title
        </label>
        <input
          id="title"
          name="title"
          type="text"
          required
          aria-required="true"
          aria-invalid={!!errors.title}
          aria-describedby={errors.title ? 'title-error' : undefined}
          placeholder="Enter document title"
          className="focus:ring-2 focus:ring-cyan-500"
        />
        {errors.title && (
          <span id="title-error" role="alert" className="text-red-500">
            {errors.title}
          </span>
        )}
      </div>
    </form>
  );
}
```

### Form Validation

Progressive enhancement with client and server validation:

```tsx
// Server action with accessibility
async function createDocument(formData: FormData) {
  'use server';

  const validation = validateDocument(formData);

  if (!validation.success) {
    return {
      errors: validation.errors,
      message: 'Please fix the errors and try again'
    };
  }

  // Process form...
}
```

## Testing Procedures

### Automated Testing

The frontend includes comprehensive accessibility tests:

```tsx
// src/app/__tests__/page.test.tsx
import { render } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

describe('HomePage Accessibility', () => {
  it('should have no accessibility violations', async () => {
    const { container } = render(<HomePage />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
```

### Manual Testing Checklist

1. **Keyboard Navigation**
   - Tab through all interactive elements
   - Verify focus indicators are visible
   - Check skip links functionality
   - Test keyboard shortcuts

2. **Screen Reader Testing**
   - Test with NVDA (Windows)
   - Test with VoiceOver (macOS)
   - Verify announcements for dynamic content
   - Check form labels and errors

3. **Visual Testing**
   - Zoom to 200% and verify no horizontal scroll
   - Test with Windows High Contrast mode
   - Verify color contrast ratios

### Lighthouse CI Integration

```yaml
# .github/workflows/accessibility-tests.yml
- name: Run Lighthouse CI
  run: |
    cd apps/frontend
    npm run lighthouse
  env:
    LIGHTHOUSE_ACCESSIBILITY_THRESHOLD: 90
```

## Keyboard Shortcuts

### Global Shortcuts

The frontend implements these keyboard shortcuts:

| Shortcut | Action | Context |
|----------|--------|---------|
| `Cmd/Ctrl + K` | Open search | Global |
| `Cmd/Ctrl + N` | New document | When authenticated |
| `/` | Focus search | When not in input |
| `?` | Show help | Global |
| `Esc` | Close modal | When modal open |
| `Esc Esc` | Close all overlays | Global |

### Implementation

```tsx
// src/hooks/useGlobalKeyboardShortcuts.ts
import { useKeyboardShortcuts } from '@semiont/react-ui';
import { useRouter } from '@/i18n/routing';

export function useGlobalKeyboardShortcuts() {
  const router = useRouter();
  const { openSearch, openHelp } = useModals();

  useKeyboardShortcuts([
    {
      key: 'k',
      ctrlOrCmd: true,
      handler: () => openSearch(),
      description: 'Open global search'
    },
    {
      key: 'n',
      ctrlOrCmd: true,
      handler: () => router.push('/know/compose'),
      description: 'Create new document'
    },
    {
      key: '?',
      handler: () => openHelp(),
      description: 'Show keyboard shortcuts'
    }
  ]);
}
```

## Screen Reader Support

### Live Regions

Dynamic content updates are announced:

```tsx
// src/components/SearchResults.tsx
export function SearchResults({ results, isLoading }) {
  return (
    <div>
      <div
        role="status"
        aria-live="polite"
        aria-busy={isLoading}
        className="sr-only"
      >
        {isLoading
          ? 'Searching...'
          : `${results.length} results found`
        }
      </div>
      {/* Results list */}
    </div>
  );
}
```

### Loading States

Accessible loading indicators:

```tsx
// src/components/LoadingSpinner.tsx
export function LoadingSpinner({ label = 'Loading...' }) {
  return (
    <div role="status" aria-label={label}>
      <svg
        className="animate-spin"
        aria-hidden="true"
        viewBox="0 0 24 24"
      >
        {/* Spinner SVG */}
      </svg>
      <span className="sr-only">{label}</span>
    </div>
  );
}
```

## Development Guidelines

### Component Checklist

When creating new components:

- [ ] Use semantic HTML elements
- [ ] Add ARIA labels where needed
- [ ] Implement keyboard navigation
- [ ] Include focus indicators
- [ ] Test with axe-core
- [ ] Add loading/error states
- [ ] Document keyboard shortcuts

### Common Patterns

#### Accessible Modals

```tsx
import { Dialog } from '@headlessui/react';

export function AccessibleModal({ isOpen, onClose, title, children }) {
  return (
    <Dialog
      open={isOpen}
      onClose={onClose}
      className="relative z-50"
    >
      <Dialog.Overlay className="fixed inset-0 bg-black/30" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <Dialog.Panel className="bg-white rounded-lg p-6">
          <Dialog.Title className="text-lg font-medium">
            {title}
          </Dialog.Title>
          {children}
        </Dialog.Panel>
      </div>
    </Dialog>
  );
}
```

#### Accessible Tables

```tsx
export function DataTable({ data, columns }) {
  return (
    <table role="table">
      <caption className="sr-only">
        Data table with {data.length} rows
      </caption>
      <thead>
        <tr>
          {columns.map(col => (
            <th key={col.key} scope="col">
              {col.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.map(row => (
          <tr key={row.id}>
            {columns.map(col => (
              <td key={col.key}>
                {row[col.key]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

### CSS Utilities

Tailwind classes for accessibility:

```css
/* Focus states */
.focus-visible:ring-2
.focus-visible:ring-cyan-500
.focus-visible:ring-offset-2

/* Screen reader only */
.sr-only

/* Skip links (visible on focus) */
.sr-only.focus:not-sr-only

/* High contrast mode */
@media (prefers-contrast: high) {
  .high-contrast:border-2
  .high-contrast:border-black
}

/* Reduced motion */
@media (prefers-reduced-motion: reduce) {
  .motion-reduce:transition-none
  .motion-reduce:animation-none
}
```

## Troubleshooting

### Common Issues

1. **Focus Lost After Navigation**
   - Solution: Implement focus management in layout
   - Use `useEffect` to set focus on route change

2. **Form Errors Not Announced**
   - Solution: Add `role="alert"` to error messages
   - Use `aria-describedby` on inputs

3. **Keyboard Shortcuts Conflict**
   - Solution: Check for input focus before triggering
   - Disable shortcuts in contentEditable areas

4. **Screen Reader Silent on Updates**
   - Solution: Use live regions with appropriate politeness
   - Ensure aria-busy is set during loading

## Resources

- [Next.js Accessibility](https://nextjs.org/docs/architecture/accessibility)
- [Headless UI Documentation](https://headlessui.com/)
- [Testing Library Accessibility](https://testing-library.com/docs/queries/byrole)
- [Tailwind CSS Accessibility](https://tailwindcss.com/docs/screen-readers)

## Related Documentation

- [Keyboard Navigation Guide](./KEYBOARD-NAV.md)
- [Component Library Accessibility](../../packages/react-ui/docs/ACCESSIBILITY.md)
- [Testing Guide](./TESTING.md#accessibility-testing)