# React UI Accessibility Documentation

`@semiont/react-ui` provides accessible React components following [WCAG 2.1 Level AA](https://www.w3.org/WAI/WCAG21/quickref/) guidelines.

## Table of Contents

1. [Core Components](#core-components)
2. [Accessibility Hooks](#accessibility-hooks)
3. [Live Regions](#live-regions)
4. [Testing](#testing)
5. [Implementation Guidelines](#implementation-guidelines)

## Core Components

### SkipLinks and MainContent
Implement [WCAG 2.4.1 Bypass Blocks](https://www.w3.org/WAI/WCAG21/Understanding/bypass-blocks.html):

```tsx
import { SkipLinks, MainContent } from '@semiont/react-ui';

function Page() {
  return (
    <>
      <SkipLinks />
      <nav aria-label="Main navigation">{/* repeated on every page */}</nav>
      <MainContent>{children}</MainContent>
    </>
  );
}
```

`SkipLinks` takes no props and renders one link, "Skip to main content", hidden until it takes focus. `MainContent` is the page's `<main>` landmark and that link's target. It takes the props of `<main>`, and owns the two that make it a target: the `id` the link points at, and the `tabIndex={-1}` that lets it take focus without joining the tab order.

The host mounts `SkipLinks` once, ahead of its routes, and every page renders its content in a `MainContent` — its own, or the one `PageLayout` renders around its children. `PageLayout` does not render `SkipLinks`.

### LiveRegion
Provides [WCAG 4.1.3 Status Messages](https://www.w3.org/WAI/WCAG21/Understanding/status-messages.html):

```tsx
import { LiveRegionProvider } from '@semiont/react-ui';

<LiveRegionProvider>
  {children}
</LiveRegionProvider>
```

### SettingsPanel
Language-aware settings with live announcements. A locale change is announced through `useLanguageChangeAnnouncements` and emitted as `settings:locale-changed`; the host passes what react-ui cannot know:

```tsx
import { SettingsPanel, useHoverDelay, useTheme } from '@semiont/react-ui';

function Settings({ version, onOpenKeyboardHelp }: { version: string; onOpenKeyboardHelp: () => void }) {
  const { theme } = useTheme();
  const { hoverDelayMs } = useHoverDelay();
  return (
    <SettingsPanel
      theme={theme}
      locale={locale}
      hoverDelayMs={hoverDelayMs}
      version={version}
      sourceCodeUrl="https://github.com/The-AI-Alliance/semiont"
      onOpenKeyboardHelp={onOpenKeyboardHelp}
    />
  );
}
```

## Accessibility Hooks

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

// Resource loading
const { announceResourceLoading, announceResourceLoaded, announceResourceLoadError } =
  useResourceLoadingAnnouncements();

// Form operations
const { announceFormSubmitting, announceFormSuccess, announceFormError, announceFormValidationError } =
  useFormAnnouncements();

// Language changes
const { announceLanguageChanging, announceLanguageChanged } = useLanguageChangeAnnouncements();

// Document and annotation changes
const { announceAnnotationCreated, announceAnnotationDeleted, announceError } = useDocumentAnnouncements();
```

## Live Regions

Components announce state changes per [WCAG 4.1.3](https://www.w3.org/WAI/WCAG21/Understanding/status-messages.html):

- **Search** (`SearchModal`): searching, result counts, no results
- **Forms** (`ResourceComposePage`): submitting, saved, save failed
- **Resources** (`ResourceViewerPage`): loading, loaded
- **Drag & Drop** (`CollapsibleResourceNavigation`): pickup, keyboard moves, drop positions, can't-move-further
- **Language** (`SettingsPanel`): changing, changed

## Testing

### Automated Testing with jest-axe

A component's accessibility tests are a `.a11y.test.tsx` file beside it, using [jest-axe](https://github.com/nickcolley/jest-axe). `vitest.setup.ts` registers the `toHaveNoViolations` matcher, and `src/types/jest-axe.d.ts` types the package:

```tsx
import { render } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

it('should have no WCAG violations', async () => {
  const { container } = render(<SkipLinks />);
  const results = await axe(container);
  expect(results).toHaveNoViolations();
});
```

### CI/CD Integration

```yaml
# .github/workflows/accessibility-tests.yml
- name: Run accessibility tests
  run: npm run test:a11y --workspace=@semiont/react-ui

- name: Run Lighthouse CI
  run: lhci autorun
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

Content language per [WCAG 3.1.2](https://www.w3.org/WAI/WCAG21/Understanding/language-of-parts.html): the interface language belongs on the host's `<html lang>` (the Browser writes it, and `dir`, from its route's locale — see [its ACCESSIBILITY.md](../../../apps/browser/docs/ACCESSIBILITY.md#language-and-direction)), and resource content, whose language may differ, carries its own. `ResourceViewerPage` marks its document body this way, and `ResourceComposePage` its editor:
```tsx
import { getLanguage } from '@semiont/core';

<div lang={getLanguage(resource)}>{content}</div>
```

### Test Coverage

| Component | Status | Coverage |
|-----------|--------|----------|
| NavigationMenu | ✅ Complete | WCAG 2.1 AA |
| LiveRegion | ✅ Complete | WCAG 2.1 AA |
| SkipLinks, MainContent | ✅ Complete | WCAG 2.1 AA |

## References

- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
- [ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)
- [axe-core Rules](https://github.com/dequelabs/axe-core/blob/develop/doc/rule-descriptions.md)
- [Testing Library](https://testing-library.com/docs/queries/about#priority)
