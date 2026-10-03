# Keyboard Navigation — Implementation

How keyboard navigation is implemented in the Semiont Browser. The end-user-facing shortcut reference lives at **[../../../docs/browser/KEYBOARD-NAV.md](../../../docs/browser/KEYBOARD-NAV.md)**; this page covers the patterns and primitives a contributor needs.

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
3. **Discoverability.** `?` opens `KeyboardShortcutsHelpModal`, which lists the shortcuts by group.
4. **Context awareness.** Shortcuts don't fire while focus is inside an input field, so they don't fight with normal typing.
5. **Accessibility first.** Keyboard and screen reader users are primary, not retrofit.

## Core primitives

### `useKeyboardShortcuts`

Centralized keyboard event handling with platform detection and context-awareness:

```typescript
import { useKeyboardShortcuts } from '@semiont/react-ui';

const [isSearchOpen, setIsSearchOpen] = useState(false);

useKeyboardShortcuts([
  {
    key: 'k',
    ctrlOrCmd: true,
    handler: () => setIsSearchOpen(true),
    description: 'Open global search',
  },
]);
```

Features:
- Platform-specific modifier resolution (`ctrlOrCmd` → `metaKey` on macOS, `ctrlKey` elsewhere)
- Context-aware activation (no fire while an `<input>`, `<textarea>`, or contenteditable element has focus)
- `shift` and `alt` modifiers, matched exactly — a shortcut without `shift` doesn't fire while Shift is held
- `enabled: false` switches a shortcut off without unregistering it
- A matched shortcut calls `preventDefault()` and `stopPropagation()` before its handler runs

The Browser's `KeyboardShortcutsProvider` registers the global set: `Cmd/Ctrl+K` and `/` open search, `Cmd/Ctrl+N` opens compose, `?` opens the help modal, and a double `Esc` (`useDoubleKeyPress`) closes the search and help modals.

### `useRovingTabIndex`

Arrow-key navigation for widget groups — on the discover page, the entity-type filter row and the resource grid:

```tsx
import { useRovingTabIndex } from '@semiont/react-ui';

const entityTypes = ['Person', 'Organization', 'Location'];
const roving = useRovingTabIndex<HTMLDivElement>(entityTypes.length, {
  orientation: 'horizontal',  // or 'vertical', or 'grid' with `cols`
  loop: true,
});

<div ref={roving.containerRef} onKeyDown={roving.handleKeyDown}>
  {entityTypes.map((type) => <button key={type}>{type}</button>)}
</div>
```

Manages the `tabindex` attributes of the buttons, `[role="button"]` and `[tabindex]` elements inside `containerRef` so only one is in the tab order at a time, and arrow keys move between them. Supports `Home` / `End` for first/last; `focusItem(index)` moves focus programmatically.

### `useLiveRegion`

Screen-reader announcements for dynamic content:

```typescript
import { useLiveRegion } from '@semiont/react-ui';

const { announce } = useLiveRegion();
announce('5 results found', 'polite');
announce('Validation failed', 'assertive');
```

Wraps a polite/assertive ARIA live region; `announce()` sets the region's message and clears it after a second so the same message can be re-announced. See [ACCESSIBILITY.md](ACCESSIBILITY.md#live-regions-for-dynamic-content) for usage guidance.

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

`SkipLinks` (in `@semiont/react-ui`) renders visually-hidden-until-focused links to `#main-content`, `#main-navigation` and `#search` that let keyboard users bypass repetitive navigation. The locale layout mounts it ahead of every route, so the skip-link is the first focusable element on every page. Layouts supply the targets: `LeftSidebar` carries `id="main-navigation"`, and `PageLayout`'s `<main>` carries `id="main-content"`.

## Component checklist

Every interactive component should:

1. Use semantic HTML first (`<button>`, `<a>`, `<nav>`, `<input>`).
2. Add ARIA enhancement (`aria-label`, `aria-expanded`, `aria-pressed`, `aria-describedby`) where semantics aren't sufficient.
3. Have visible focus indicators — react-ui's `utilities/focus.css` gives buttons, links, form controls, `[role="button"]` and `[tabindex]` a `:focus-visible` outline; don't strip it.
4. Handle Enter and Space for any non-button click target:

```tsx
import { TrashIcon } from '@heroicons/react/24/outline';

function DeleteAnnotationControl({ onDelete }: { onDelete: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onDelete}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onDelete();
        }
      }}
      aria-label="Delete annotation"
    >
      <TrashIcon aria-hidden="true" />
    </div>
  );
}
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
- **Shortcut doesn't trigger.** Check focus location — shortcuts don't fire in inputs by design. Also check for conflict with browser shortcuts (`Cmd+T`, etc.).
- **Screen reader silent.** Verify the live region exists in the DOM and has the right `aria-live` attribute. The most common cause is announcing before the live region has mounted.

## See also

- **[../../../docs/browser/KEYBOARD-NAV.md](../../../docs/browser/KEYBOARD-NAV.md)** — user-facing shortcut reference.
- **[ACCESSIBILITY.md](ACCESSIBILITY.md)** — broader WCAG 2.1 AA implementation patterns.
- [WCAG 2.1 Quick Reference](https://www.w3.org/WAI/WCAG21/quickref/)
- [ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)
- [Headless UI documentation](https://headlessui.com/)
