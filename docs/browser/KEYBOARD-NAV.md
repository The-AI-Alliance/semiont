# Keyboard Navigation

Every interaction in the Semiont Browser is reachable from the keyboard. This page is the shortcut reference; for the implementation patterns behind it, see [apps/frontend/docs/KEYBOARD-NAV.md](../../apps/frontend/docs/KEYBOARD-NAV.md).

Press **`?`** at any time to bring up an in-app shortcut help modal.

## Application navigation

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl + K` | Open global search |
| `Cmd/Ctrl + N` | New document |
| `/` | Focus search (when not in an input field) |
| `?` | Show keyboard-shortcut help |
| `Esc Esc` | Close all open modals and overlays |

## Document interaction

| Shortcut | Action |
|---|---|
| `H` | Create highlight from selected text |
| `R` | Create reference from selected text |
| `Tab` | Move focus to next annotation |
| `Shift + Tab` | Move focus to previous annotation |
| `Delete` | Remove the selected annotation |

## Modals and popups

| Shortcut | Action |
|---|---|
| `Tab` / `Shift + Tab` | Cycle through controls |
| `Enter` / `Space` | Activate the focused control |
| `Arrow keys` | Move between options in a group |
| `Esc` | Close the active modal |

## Discovery and conventions

- **Platform-aware modifiers.** Use `Cmd` on macOS; `Ctrl` on Windows and Linux. The browser detects the platform and adjusts.
- **Context awareness.** Single-letter shortcuts (`H`, `R`, `/`) only fire when focus is *outside* a text input, so they don't fight with normal typing.
- **No mouse required.** Every interaction documented elsewhere in the browser docs has a keyboard path. If you find one that doesn't, please file an accessibility issue.

## See also

- **[ACCESSIBILITY.md](ACCESSIBILITY.md)** — the broader WCAG 2.1 AA capability claim (screen-reader support, focus indicators, reduced motion, etc.).
- **[apps/frontend/docs/KEYBOARD-NAV.md](../../apps/frontend/docs/KEYBOARD-NAV.md)** — implementation: the `useKeyboardShortcuts` hook, `useRovingTabIndex`, focus-management patterns, testing strategy.
