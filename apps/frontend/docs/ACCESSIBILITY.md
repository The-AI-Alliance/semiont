# Accessibility — Implementation

How the Semiont frontend implements [WCAG 2.1 Level AA](https://www.w3.org/WAI/WCAG21/quickref/) — patterns, primitives, and how to keep new code conformant.

For the user-facing capability claim (what users see, how to verify it), see **[../../../docs/browser/ACCESSIBILITY.md](../../../docs/browser/ACCESSIBILITY.md)**. For the keyboard navigation architecture, see **[KEYBOARD-NAV.md](KEYBOARD-NAV.md)**.

## Compliance baseline

The frontend meets WCAG 2.1 AA via:

- **Keyboard Accessible (2.1.1):** all interactive elements reachable and operable via keyboard.
- **No Keyboard Trap (2.1.2):** standard navigation keys move in and out of every component (modals included).
- **Focus Visible (2.4.7):** focus rings on all interactive elements.
- **Focus Order (2.4.3):** logical tab order matching visual layout.
- **Bypass Blocks (2.4.1):** skip-link to main content, navigation, and search.
- **Page Titled (2.4.2):** descriptive page titles and heading hierarchy.
- **Name, Role, Value (4.1.2):** semantic HTML + ARIA where semantic HTML doesn't suffice.

## Patterns

### Language attribute

Per [WCAG 3.1.1 Language of Page](https://www.w3.org/WAI/WCAG21/Understanding/language-of-page.html), the document's `<html>` element carries the active locale:

```tsx
<html lang={locale}>
  <body>
    <SkipLinks />
    {children}
  </body>
</html>
```

The locale comes from the i18n provider (see [INTERNATIONALIZATION.md](INTERNATIONALIZATION.md)). `SkipLinks` is the visually-hidden-until-focused bypass-blocks component from `@semiont/react-ui`.

### Focus management on route change

When the route changes (resource navigation, modal close, panel transitions), focus restores to the main content region:

```tsx
useEffect(() => {
  const main = document.getElementById('main-content');
  main?.focus();
}, [pathname]);
```

For modals, [Headless UI's `Dialog`](https://headlessui.com/react/dialog) handles focus trap on open and restoration on close — use it for every overlay rather than hand-rolling focus management.

### Form input assistance

Per [WCAG 3.3 Input Assistance](https://www.w3.org/WAI/WCAG21/Understanding/input-assistance), errors are announced via `aria-invalid` + `role="alert"`, and required fields are marked `aria-required`:

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

### Live regions for dynamic content

`@semiont/react-ui` ships a `LiveRegion` provider and `useLiveRegion()` hook. Use it for any UI update that should be announced to screen readers:

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

All interactive components use the standard ring utility classes:

```tsx
<button className="focus:outline-none focus:ring-2 focus:ring-cyan-500">
```

The `focus:outline-none` + `focus:ring-2` pattern preserves the focus indicator while letting the design system control its appearance. **Never** drop the ring without providing an alternative visible indicator — that fails 2.4.7.

### Reduced motion

Animation classes are gated through Tailwind's `motion-reduce` variant:

```tsx
<div className="transition-all motion-reduce:transition-none">
```

For JS-driven animations, check `window.matchMedia('(prefers-reduced-motion: reduce)')` and disable.

## Component requirements checklist

When building or reviewing a UI component:

- [ ] Uses semantic HTML elements where possible (`<button>`, `<a>`, `<nav>`, `<main>`, `<section>` with headings).
- [ ] ARIA labels on icon-only buttons, including state (`aria-expanded`, `aria-pressed`, `aria-selected`).
- [ ] Keyboard handlers for non-button click targets (Enter + Space minimum).
- [ ] Visible focus indicator (don't strip without replacing).
- [ ] Live-region announcement for any change the user can't otherwise perceive.
- [ ] Loading and error states reachable to screen readers.
- [ ] No hover-only interactions; everything works on focus + keyboard.

## Testing

### Automated

[`jest-axe`](https://github.com/nickcolley/jest-axe) for component-level accessibility assertions. Add to any test that renders interactive UI:

```tsx
import { axe, toHaveNoViolations } from 'jest-axe';
expect.extend(toHaveNoViolations);

it('has no WCAG violations', async () => {
  const { container } = render(<Page />);
  const results = await axe(container);
  expect(results).toHaveNoViolations();
});
```

The CI pipeline runs accessibility tests on every PR via `.github/workflows/accessibility-tests.yml` — see [docs/development/TESTING.md](../../../docs/development/TESTING.md) for the testing-overview.

### Manual

- **Keyboard-only:** unplug the mouse, complete a representative flow (sign in, open a resource, create an annotation, sign out).
- **Screen reader:** at minimum, run NVDA (Windows) or VoiceOver (macOS) on the same flow.
- **Zoom:** browser zoom to 200%, verify no content lost or horizontal scroll.
- **High contrast:** OS-level high-contrast mode and verify text + UI remain readable.

### Tooling

- [axe DevTools](https://www.deque.com/axe/devtools/) — browser extension, surfaces violations in DevTools.
- [WAVE](https://wave.webaim.org/) — visual accessibility evaluation, useful for spot-checking heading order and ARIA roles.

## See also

- **[../../../docs/browser/ACCESSIBILITY.md](../../../docs/browser/ACCESSIBILITY.md)** — user-facing capability claim.
- **[KEYBOARD-NAV.md](KEYBOARD-NAV.md)** — keyboard navigation architecture, custom hooks, and shortcut implementation.
- [WCAG 2.1 Quick Reference](https://www.w3.org/WAI/WCAG21/quickref/)
- [ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)
- [Headless UI documentation](https://headlessui.com/)
