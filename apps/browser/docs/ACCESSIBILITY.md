# Accessibility — Implementation

How the Semiont Browser implements [WCAG 2.1 Level AA](https://www.w3.org/WAI/WCAG21/quickref/) — patterns, primitives, and how to keep new code conformant.

For the user-facing capability claim (what users see, how to verify it), see **[../../../docs/analyst/ACCESSIBILITY.md](../../../docs/analyst/ACCESSIBILITY.md)**. For the keyboard navigation architecture, see **[KEYBOARD-NAV.md](KEYBOARD-NAV.md)**.

## Compliance baseline

The Browser meets WCAG 2.1 AA via:

- **Keyboard Accessible (2.1.1):** all interactive elements reachable and operable via keyboard.
- **No Keyboard Trap (2.1.2):** standard navigation keys move in and out of every component (modals included).
- **Focus Visible (2.4.7):** focus rings on all interactive elements.
- **Focus Order (2.4.3):** logical tab order matching visual layout.
- **Bypass Blocks (2.4.1):** a skip link to the main content, first in the tab order on every route.
- **Page Titled (2.4.2):** descriptive page titles and heading hierarchy.
- **Language of Page (3.1.1):** `<html lang>` and `<html dir>` follow the route's locale.
- **Name, Role, Value (4.1.2):** semantic HTML + ARIA where semantic HTML doesn't suffice.

## Patterns

### Language and direction

[WCAG 3.1.1 Language of Page](https://www.w3.org/WAI/WCAG21/Understanding/language-of-page.html) requires the document's `<html>` element to carry the page language. `LocaleGuard` in `src/App.tsx` switches i18next to the route's `:locale` (see [INTERNATIONALIZATION.md](INTERNATIONALIZATION.md)), and `src/i18n/config.ts` writes every language i18next switches to onto `<html>`:

```ts
import i18n from 'i18next';

i18n.on('languageChanged', (language) => {
  document.documentElement.lang = language;
  document.documentElement.dir = i18n.dir(language);
});
```

`lang` names the language on screen: `languageChanged` fires once the locale's messages have loaded and i18next renders them. `i18n.dir` is i18next's own reading of a language's direction, so `ar`, `he` and `fa` set `dir="rtl"` and every other supported locale sets `dir="ltr"`. `apps/browser/index.html` declares `<html lang="en">`, which stands until the first locale loads.

`src/__tests__/document-language.test.tsx` routes the app through several locales and checks both attributes.

### Skip link

[WCAG 2.4.1 Bypass Blocks](https://www.w3.org/WAI/WCAG21/Understanding/bypass-blocks.html) asks for a way past content repeated on every page. `SkipLinks`, the visually-hidden-until-focused link from `@semiont/react-ui`, is mounted once, by the locale layout (`src/app/[locale]/layout.tsx`), ahead of every route. Its text is one of react-ui's translated strings, so it reads in the route's locale like the rest of the page. Its link lands on `MainContent`, react-ui's `<main>` landmark, and every page renders its content in one:

```tsx
<MainContent className="flex-1 p-6 flex flex-col">
  {children}
</MainContent>
```

The knowledge and moderate layouts render theirs beside the sidebar, the splash, sign-in callback and not-found pages render their own, and the auth error page gets one from react-ui's `PageLayout`. A new page or layout does the same; it does not mount a second `SkipLinks`.

`src/__tests__/skip-link-targets.test.tsx` renders every route in `App`'s route table and fails on a route whose skip link has no target, or that carries more than one `SkipLinks`. It also holds the link's text to the messages the Browser serves.

### Dark theme

`ThemeProvider` from `@semiont/react-ui` writes the resolved theme to `data-theme` on `<html>`. react-ui's styles key their dark rules off `[data-theme="dark"]`, and `tailwind.config.js` points Tailwind's `dark:` variant at the same attribute (`darkMode: ['selector', '[data-theme="dark"]']`). A `dark:` class in Browser markup therefore applies in exactly the theme react-ui's components render in: a `dark:` surface and the text on it change together, which [WCAG 1.4.3 Contrast](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html) depends on.

`src/__tests__/tailwind-dark-variant.test.tsx` compiles `src/app/globals.css` and checks that every `dark:` rule matches under `ThemeProvider`'s dark theme and none under its light theme.

### Focus management

For modals, [Headless UI's `Dialog`](https://headlessui.com/react/dialog) handles focus trap on open and restoration on close — use it for every overlay rather than hand-rolling focus management.

### Form input assistance

Per [WCAG 3.3 Input Assistance](https://www.w3.org/WAI/WCAG21/Understanding/input-assistance), an invalid field carries `aria-invalid` and points `aria-describedby` at its error, and the error carries `role="alert"` so it is announced — the pattern react-ui's `ConfigureGenerationStep` follows:

```tsx
function TitleField({ error }: { error?: string }) {
  return (
    <div className="semiont-form__field">
      <input
        className="semiont-input"
        required
        aria-invalid={!!error}
        aria-describedby={error ? 'title-error' : undefined}
      />
      {error && (
        <p id="title-error" className="semiont-form__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
```

### Live regions for dynamic content

`@semiont/react-ui` ships `LiveRegionProvider` (mounted in the Browser's `src/app/providers.tsx`) and the `useLiveRegion()` hook. Use it for any UI update that should be announced to screen readers:

- search result counts
- form validation outcomes
- success confirmations
- async-job progress and completion

```tsx
const { announce } = useLiveRegion();
announce('5 results found', 'polite');
```

`'polite'` for non-urgent updates; `'assertive'` only when the user truly needs to interrupt their current task.

### Focus indicators

`@semiont/react-ui` gives every interactive element a keyboard focus outline, in light and dark themes alike:

```css
/* packages/react-ui/src/styles/utilities/focus.css */
button:focus-visible,
a:focus-visible,
input:focus-visible,
textarea:focus-visible,
select:focus-visible,
[role="button"]:focus-visible,
[role="link"]:focus-visible,
[tabindex]:focus-visible {
  outline: 2px solid var(--semiont-color-primary-500);
  outline-offset: 2px;
}
```

**Never** remove that outline without providing an alternative visible indicator — that fails 2.4.7.

### Reduced motion

`packages/react-ui/src/styles/utilities/motion-overrides.css` cuts every animation and transition on the page to 0.01ms under `@media (prefers-reduced-motion: reduce)` — react-ui and Browser markup alike.

For JS-driven animations, check `window.matchMedia('(prefers-reduced-motion: reduce)')` and disable.

## Component requirements checklist

When building or reviewing a UI component:

- [ ] Uses semantic HTML elements where possible (`<button>`, `<a>`, `<nav>`, `<section>` with headings), and `MainContent` for a page's `<main>`.
- [ ] ARIA labels on icon-only buttons, including state (`aria-expanded`, `aria-pressed`, `aria-selected`).
- [ ] Keyboard handlers for non-button click targets (Enter + Space minimum).
- [ ] Visible focus indicator (don't strip without replacing).
- [ ] Live-region announcement for any change the user can't otherwise perceive.
- [ ] Loading and error states reachable to screen readers.
- [ ] No hover-only interactions; everything works on focus + keyboard.

## Testing

### Automated

Component-level [`jest-axe`](https://github.com/nickcolley/jest-axe) assertions live with the components, in `@semiont/react-ui`'s `*.a11y.test.tsx` files — see [react-ui ACCESSIBILITY.md § Testing](../../../docs/builder/react-ui/ACCESSIBILITY.md#testing) for the pattern. The Browser has no `jest-axe` dependency of its own.

The CI pipeline runs accessibility tests on every PR via `.github/workflows/accessibility-tests.yml` — react-ui's axe tests, the Browser's test suite, and a Lighthouse accessibility audit with a score threshold of 90. See [docs/contributor/TESTING.md](../../../docs/contributor/TESTING.md) for the testing-overview.

### Manual

- **Keyboard-only:** unplug the mouse, complete a representative flow (sign in, open a resource, create an annotation, sign out).
- **Screen reader:** at minimum, run NVDA (Windows) or VoiceOver (macOS) on the same flow.
- **Zoom:** browser zoom to 200%, verify no content lost or horizontal scroll.
- **High contrast:** OS-level high-contrast mode and verify text + UI remain readable.

### Tooling

- [axe DevTools](https://www.deque.com/axe/devtools/) — browser extension, surfaces violations in DevTools.
- [WAVE](https://wave.webaim.org/) — visual accessibility evaluation, useful for spot-checking heading order and ARIA roles.

## See also

- **[../../../docs/analyst/ACCESSIBILITY.md](../../../docs/analyst/ACCESSIBILITY.md)** — user-facing capability claim.
- **[KEYBOARD-NAV.md](KEYBOARD-NAV.md)** — keyboard navigation architecture, custom hooks, and shortcut implementation.
- [WCAG 2.1 Quick Reference](https://www.w3.org/WAI/WCAG21/quickref/)
- [ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)
- [Headless UI documentation](https://headlessui.com/)
