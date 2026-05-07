# Accessibility

The Semiont Browser meets [WCAG 2.1 Level AA](https://www.w3.org/WAI/WCAG21/quickref/). Every interactive element is reachable from the keyboard alone, every dynamic update is announced to screen readers, and every UI surface has been tested with assistive technology.

## What you get

- **Full keyboard navigation.** Every button, link, form field, modal, and annotation is reachable and operable from the keyboard. No mouse required. See **[KEYBOARD-NAV.md](KEYBOARD-NAV.md)** for the complete shortcut reference.
- **Screen-reader support.** Tested with **NVDA** (Windows), **VoiceOver** (macOS), **JAWS** (Windows), and **Orca** (Linux). ARIA roles and labels apply throughout; live regions announce dynamic changes (search-result counts, annotation creation, validation errors, async progress).
- **Visible focus indicators.** Every interactive element shows a clear focus ring when reached via keyboard.
- **Skip links.** Tab once on page load to jump past navigation directly to main content.
- **Reduced motion.** The browser respects the OS-level `prefers-reduced-motion` setting; transitions and animations are disabled when you've asked the system to reduce them.
- **High contrast.** Light, dark, and high-contrast color schemes; WCAG AA contrast ratios (4.5:1 text, 3:1 UI) verified across all schemes.
- **Zoom to 200%.** No content cut off, no horizontal scroll, no functional loss at 200% browser zoom.
- **Form errors that work for everyone.** Validation messages are announced via `aria-live` and visually associated with their inputs.

## Browser support

Chrome 90+, Firefox 88+, Safari 14+, Edge 90+ — all with full WCAG 2.1 AA support and screen-reader pass-through.

## Verifying it yourself

If you want to confirm any of these claims independently:

- **Keyboard test:** disconnect your mouse and complete an annotation flow (open a resource, select text, create a highlight, save it). Every step should be reachable.
- **Screen reader:** turn on VoiceOver / NVDA / Orca and navigate the same flow. The screen reader should announce each interactive element with its role, label, and state.
- **Zoom test:** set browser zoom to 200%. The interface should remain usable.
- **Reduced motion:** enable "Reduce motion" in your OS settings. Transitions should disappear.
- **High contrast:** enable your OS's high-contrast mode (or pick the high-contrast theme in Semiont's settings panel). Text and UI elements should remain readable with WCAG AA contrast ratios.

## Reporting an accessibility issue

Found something that doesn't work? File an issue and tag it `accessibility`. Include the assistive technology, browser, and the specific step that failed.

## See also

- **[KEYBOARD-NAV.md](KEYBOARD-NAV.md)** — keyboard shortcut reference.
- **[apps/frontend/docs/ACCESSIBILITY.md](../../apps/frontend/docs/ACCESSIBILITY.md)** — implementation guide for contributors (ARIA patterns, focus management, automated testing).
