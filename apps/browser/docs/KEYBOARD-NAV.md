# Keyboard Navigation — Implementation

How keyboard navigation is implemented in the Semiont frontend. The end-user-facing shortcut reference lives at **[../../../docs/browser/KEYBOARD-NAV.md](../../../docs/browser/KEYBOARD-NAV.md)**; this page covers the patterns and primitives a contributor needs.

For the broader accessibility implementation guide, see **[ACCESSIBILITY.md](ACCESSIBILITY.md)**.

## WCAG 2.1 AA criteria addressed by keyboard navigation

| Criterion | How it's met |
|---|---|
| **2.1.1 Keyboard Accessible** | Every interactive element is reachable and operable via keyboard. |
| **2.1.2 No Keyboard Trap** | Standard navigation keys move in and out of all components. |
| **2.4.1 Bypass Blocks** | `SkipLinks` component provides keyboard-accessible navigation bypass. |
| **2.4.3 Focus Order** | Tab order follows visual layout and content flow. |
| **2.4.7 Focus Visible** | Focus rings on all interactive elements. |
| **4.1.2 Name, Role, Value** | ARIA labels and semantic HTML throughout. |

## Architectural principles

1. **Progressive enhancement.** Start with semantic HTML; enhance with JS. Keyboard navigation works even if advanced features fail.
2. **Platform consistency.** `Cmd` on macOS, `Ctrl` on Windows/Linux; arrow keys for menu navigation; standard `Esc` to dismiss.
3. **Discoverability.** Every shortcut registers a description that the help modal (`?`) renders.
4. **Context awareness.** Single-letter shortcuts disable themselves when focus is inside an input field, so they don't fight with normal typing.
5. **Accessibility first.** Keyboard and screen reader users are primary, not retrofit.

## Core primitives

### `useKeyboardShortcuts`

Centralized keyboard event handling with platform detection and context-awareness:

```typescript
import { useKeyboardShortcuts } from '@semiont/react-ui';

useKeyboardShortcuts([
  {
    key: 'k',
    ctrlOrCmd: true,
    handler: () => openGlobalSearch(),
    description: 'Open global search',
  },
]);
```

Features:
- Platform-specific modifier resolution (`ctrlOrCmd` → `metaKey` on macOS, `ctrlKey` elsewhere)
- Context-aware activation (no fire when an `<input>` / `<textarea>` / contenteditable has focus, unless explicitly opted in)
- Modifier-key support
- `description` field consumed by the in-app shortcut help modal

### `useRovingTabIndex`

Arrow-key navigation for widget groups (toolbars, tab bars, entity-type grids, annotation lists):

```typescript
import { useRovingTabIndex } from '@semiont/react-ui';

useRovingTabIndex(itemCount, {
  orientation: 'horizontal',  // or 'vertical' or 'grid'
  loop: true,
});
```

Manages the `tabindex` attributes so only one element in the group is in the tab order at a time, and arrow keys move between them. Supports `Home` / `End` for first/last.

### `useLiveRegion`

Screen-reader announcements for dynamic content:

```typescript
import { useLiveRegion } from '@semiont/react-ui';

const { announce } = useLiveRegion();
announce('5 results found', 'polite');
announce('Validation failed', 'assertive');
```

Wraps a polite/assertive ARIA live region; `announce()` queues a message and clears it after a short delay so the same message can be re-announced. See [ACCESSIBILITY.md](ACCESSIBILITY.md#live-regions-for-dynamic-content) for usage guidance.

### `Headless UI Dialog` for modals

All modals use [Headless UI's `Dialog`](https://headlessui.com/react/dialog) rather than custom overlay code. This gives:
- Focus trap inside the open modal
- Focus restoration to the trigger element on close
- `Esc` to close
- Click-outside to close (configurable)
- Correct ARIA roles

If you find yourself writing focus-management code by hand, switch to `Dialog` instead.

## Navigation patterns

### Tab navigation

Sequential focus through page regions: skip links → header → main content → footer. Within each region, controls are grouped logically.

### Roving tabindex

Used for groups of single-selection items. Tab enters the group; arrow keys move within it; Tab leaves to the next group. Implemented via `useRovingTabIndex`.

### Modal focus trap

When a modal opens, focus moves into it and is trapped until close. On close, focus restores to the element that triggered the modal. Always via Headless UI `Dialog`; never hand-rolled.

### Skip links

`SkipLinks` (in `@semiont/react-ui`) renders visually-hidden-until-focused links that let keyboard users bypass repetitive navigation. The skip-link is the first focusable element on every page.

## Component checklist

Every interactive component should:

1. Use semantic HTML first (`<button>`, `<a>`, `<nav>`, `<input>`).
2. Add ARIA enhancement (`aria-label`, `aria-expanded`, `aria-pressed`, `aria-describedby`) where semantics aren't sufficient.
3. Have visible focus indicators (Tailwind: `focus:ring-2 focus:ring-cyan-500`).
4. Handle Enter and Space for any non-button click target:

```tsx
<div
  role="button"
  tabIndex={0}
  onClick={handleClick}
  onKeyDown={(e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    }
  }}
  aria-label="Delete annotation"
>
  <DeleteIcon aria-hidden="true" />
</div>
```

(Prefer `<button>` over `<div role="button">` whenever you can — but the pattern above is the fallback when the surrounding markup constrains you.)

## Testing

### Unit + integration

Component tests cover keyboard handlers and focus management. Use `@testing-library/user-event` to simulate keyboard input — never simulate `keydown` events by hand.

```tsx
import userEvent from '@testing-library/user-event';

const user = userEvent.setup();
await user.tab();        // moves focus to next element
await user.keyboard('{Enter}');  // activates
```

### Accessibility

`jest-axe` for component-level WCAG checks — see [ACCESSIBILITY.md § Testing](ACCESSIBILITY.md#testing).

### Manual

- Disconnect the mouse and complete a representative flow.
- Test with NVDA (Windows), VoiceOver (macOS), JAWS (Windows), Orca (Linux).
- Verify on Chrome 90+, Firefox 88+, Safari 14+, Edge 90+.

## Debugging

Enable per-event keyboard logging:

```javascript
window.addEventListener('keydown', (e) => {
  console.log(`Key: ${e.key}, Modifiers: ${e.ctrlKey}/${e.metaKey}/${e.shiftKey}, Target: ${e.target.tagName}`);
});
```

Common issues:

- **Focus disappears after action.** A handler removed the focused element from the DOM. Restore focus to a sensible neighbor before the removal, or use Headless UI components that handle this automatically.
- **Shortcut doesn't trigger.** Check focus location — single-letter shortcuts disable in inputs by design. Also check for conflict with browser shortcuts (`Cmd+T`, etc.).
- **Screen reader silent.** Verify the live region exists in the DOM and has the right `aria-live` attribute. The most common cause is announcing before the live region has mounted.

## See also

- **[../../../docs/browser/KEYBOARD-NAV.md](../../../docs/browser/KEYBOARD-NAV.md)** — user-facing shortcut reference.
- **[ACCESSIBILITY.md](ACCESSIBILITY.md)** — broader WCAG 2.1 AA implementation patterns.
- [WCAG 2.1 Quick Reference](https://www.w3.org/WAI/WCAG21/quickref/)
- [ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)
- [Headless UI documentation](https://headlessui.com/)
