# Frontend Accessibility Documentation

The Semiont frontend implements [WCAG 2.1 Level AA](https://www.w3.org/WAI/WCAG21/quickref/) accessibility standards.

## Table of Contents

1. [Next.js Implementation](#nextjs-implementation)
2. [Keyboard Navigation](#keyboard-navigation)
3. [Testing](#testing)
4. [Guidelines](#guidelines)

## Next.js Implementation

### HTML Language Attribute

Set per [WCAG 3.1.1](https://www.w3.org/WAI/WCAG21/Understanding/language-of-page.html):

```tsx
// app/[locale]/layout.tsx
export default function RootLayout({
  params: { locale }
}: {
  params: { locale: string }
}) {
  return (
    <html lang={locale}>
      <body>
        <SkipLinks />
        {children}
      </body>
    </html>
  );
}
```

### Focus Management

Route changes restore focus to main content:

```tsx
useEffect(() => {
  const main = document.getElementById('main-content');
  main?.focus();
}, [pathname]);
```

### Forms

Implement [WCAG 3.3 Input Assistance](https://www.w3.org/WAI/WCAG21/Understanding/input-assistance):

```tsx
<input
  aria-required="true"
  aria-invalid={!!errors.email}
  aria-describedby={errors.email ? 'email-error' : undefined}
/>
{errors.email && (
  <span id="email-error" role="alert">
    {errors.email}
  </span>
)}
```

## Keyboard Navigation

### Global Shortcuts

| Shortcut | Action | Context |
|----------|--------|---------|
| `Cmd/Ctrl + K` | Open search | Global |
| `Cmd/Ctrl + N` | New document | Authenticated |
| `/` | Focus search | Not in input |
| `?` | Show help | Global |
| `Esc` | Close modal | Modal open |
| `Esc Esc` | Close all | Global |

### Implementation

Using `@semiont/react-ui` hooks:

```tsx
import { useKeyboardShortcuts } from '@semiont/react-ui';

useKeyboardShortcuts([
  {
    key: 'k',
    ctrlOrCmd: true,
    handler: () => openSearch(),
    description: 'Open search'
  }
]);
```

## Testing

### Automated Tests

Using [jest-axe](https://github.com/nickcolley/jest-axe):

```tsx
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

it('has no WCAG violations', async () => {
  const { container } = render(<Page />);
  const results = await axe(container);
  expect(results).toHaveNoViolations();
});
```

### CI/CD Pipeline

```yaml
# .github/workflows/accessibility-tests.yml
jobs:
  test-frontend-accessibility:
    steps:
      - name: Run accessibility tests
        run: npm test -- --grep "accessibility"

      - name: Run Lighthouse CI
        run: npm run lighthouse
        env:
          LIGHTHOUSE_ACCESSIBILITY_THRESHOLD: 90
```

### Manual Testing

1. **Keyboard**: Tab through all elements, test shortcuts
2. **Screen Readers**: NVDA (Windows), VoiceOver (macOS)
3. **Visual**: 200% zoom, high contrast mode

## Guidelines

### Component Requirements

- Semantic HTML elements
- ARIA labels for icons/buttons
- Keyboard navigation support
- Focus indicators (ring-2 ring-cyan-500)
- Live region announcements
- Loading/error states

### Tailwind Utilities

```css
/* Screen reader only */
.sr-only

/* Visible on focus */
.sr-only.focus:not-sr-only

/* Focus states */
.focus:ring-2 .focus:ring-cyan-500

/* High contrast */
.contrast-more:border-2

/* Reduced motion */
.motion-reduce:transition-none
```

## References

- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
- [Next.js Accessibility](https://nextjs.org/docs/architecture/accessibility)
- [Headless UI](https://headlessui.com/)
- [Testing Library](https://testing-library.com/docs/queries/byrole)