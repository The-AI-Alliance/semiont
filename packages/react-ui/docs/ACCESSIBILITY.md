# React UI Accessibility Documentation

`@semiont/react-ui` provides accessible React components following [WCAG 2.1 Level AA](https://www.w3.org/WAI/WCAG21/quickref/) guidelines.

## Table of Contents

1. [Core Components](#core-components)
2. [Accessibility Hooks](#accessibility-hooks)
3. [Live Regions](#live-regions)
4. [Testing](#testing)
5. [Implementation Guidelines](#implementation-guidelines)

## Core Components

### SkipLinks
Implements [WCAG 2.4.1 Bypass Blocks](https://www.w3.org/WAI/WCAG21/Understanding/bypass-blocks.html):

```tsx
import { SkipLinks } from '@semiont/react-ui';

<SkipLinks />  // Default: main content & navigation
<SkipLinks links={customLinks} />  // Custom destinations
```

### LiveRegion
Provides [WCAG 4.1.3 Status Messages](https://www.w3.org/WAI/WCAG21/Understanding/status-messages.html):

```tsx
import { LiveRegionProvider } from '@semiont/react-ui';

<LiveRegionProvider>
  {/* Application content */}
</LiveRegionProvider>
```

### SettingsPanel
Language-aware settings with live announcements:

```tsx
import { SettingsPanel } from '@semiont/react-ui';

<SettingsPanel
  locale={locale}
  onLocaleChange={handleLocaleChange}
  theme={theme}
  onThemeChange={handleThemeChange}
/>
```

## Accessibility Hooks

### useFormValidation
Manages form accessibility per [WCAG 3.3 Input Assistance](https://www.w3.org/WAI/WCAG21/Understanding/input-assistance):

```tsx
const { errors, getFieldProps, getErrorProps } = useFormValidation();

<input {...getFieldProps('email')} />
{errors.email && <span {...getErrorProps('email')}>{errors.email}</span>}
```

### useLiveRegion
Announces dynamic content ([ARIA Live Regions](https://www.w3.org/WAI/ARIA/apg/patterns/liveregion/)):

```tsx
const { announce } = useLiveRegion();
announce('Operation completed', 'polite');    // Non-urgent
announce('Error occurred', 'assertive');      // Urgent
```

### Specialized Announcement Hooks

```tsx
// Search operations
const { announceSearching, announceSearchResults } = useSearchAnnouncements();

// Drag & drop
const { announcePickup, announceDrop } = useDragAnnouncements();

// Resource loading
const { announceResourceLoading, announceResourceReady } = useResourceLoadingAnnouncements();

// Form operations
const { announceFormSaving, announceFormSaved } = useFormAnnouncements();

// Language changes
const { announceLanguageChange } = useLanguageChangeAnnouncements();
```

## Live Regions

Components automatically announce state changes per [WCAG 4.1.3](https://www.w3.org/WAI/WCAG21/Understanding/status-messages.html):

- **Search**: Result counts, no results, errors
- **Forms**: Saving, saved, validation errors
- **Resources**: Loading, ready, errors
- **Drag & Drop**: Pickup, move, drop positions
- **Language**: Locale changes

## Testing

### Automated Testing with jest-axe

All components include `.a11y.test.tsx` files using [jest-axe](https://github.com/nickcolley/jest-axe):

```tsx
import { render } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

it('should have no WCAG violations', async () => {
  const { container } = render(<Component />);
  const results = await axe(container);
  expect(results).toHaveNoViolations();
});
```

### CI/CD Integration

```yaml
# .github/workflows/accessibility-tests.yml
- name: Run accessibility tests
  run: npm test -- --grep "Accessibility"

- name: Run Lighthouse CI
  run: npm run lighthouse
  env:
    LIGHTHOUSE_ACCESSIBILITY_THRESHOLD: 90
```

## Implementation Guidelines

### Required ARIA Attributes

Form inputs per [WCAG 3.3.2](https://www.w3.org/WAI/WCAG21/Understanding/labels-or-instructions.html):
- `aria-invalid` for validation state
- `aria-describedby` for error/help text
- `aria-required` for required fields

Navigation per [WCAG 2.4.8](https://www.w3.org/WAI/WCAG21/Understanding/location.html):
- `aria-current="page"` for active items
- `aria-label` for nav regions

Drag & drop per [ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/):
- Live announcements for all operations
- Keyboard alternatives (Alt+Up/Down)

### Language Support

Content language per [WCAG 3.1.2](https://www.w3.org/WAI/WCAG21/Understanding/language-of-parts.html):
```tsx
// UI locale (interface language)
<html lang={locale}>

// Resource content language (may differ from UI)
<div lang={resource.language}>
```

### Test Coverage

| Component | Status | Coverage |
|-----------|--------|----------|
| SignInForm | ✅ Complete | WCAG 2.1 AA |
| SignUpForm | ✅ Complete | WCAG 2.1 AA |
| Footer | ✅ Complete | WCAG 2.1 AA |
| NavigationMenu | ✅ Complete | WCAG 2.1 AA |
| LiveRegion | ✅ Complete | WCAG 2.1 AA |
| SkipLinks | ✅ Complete | WCAG 2.1 AA |

## References

- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
- [ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)
- [axe-core Rules](https://github.com/dequelabs/axe-core/blob/develop/doc/rule-descriptions.md)
- [Testing Library](https://testing-library.com/docs/queries/about#priority)