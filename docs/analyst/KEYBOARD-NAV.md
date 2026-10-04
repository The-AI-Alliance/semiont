# Keyboard Navigation

Every interaction in the Semiont Browser is reachable from the keyboard. This page is the shortcut reference; for the implementation patterns behind it, see [apps/browser/docs/KEYBOARD-NAV.md](../../apps/browser/docs/KEYBOARD-NAV.md).

Press **`?`** at any time to bring up an in-app shortcut help modal.

## Application navigation

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl + K` | Open global search |
| `Cmd/Ctrl + N` | New document |
| `/` | Focus search (when not in an input field) |
| `?` | Show keyboard-shortcut help |
| `Esc Esc` | Close all open modals and overlays |

## Sidebar tabs

| Shortcut | Action |
|---|---|
| `Space` | Pick up the focused resource tab, and drop it again |
| `↑` / `↓` | Move the tab you picked up |
| `Alt + ↑` / `Alt + ↓` | Move the focused tab without picking it up |
| `Esc` | Cancel the move |

## Lists and grids

| Shortcut | Action |
|---|---|
| `←` / `→` | Move between entity type filters |
| Arrow keys | Move around the resource grid |
| `Home` / `End` | Jump to the first or last item |

## Search

| Shortcut | Action |
|---|---|
| `↑` / `↓` | Move between results |
| `Enter` | Open the selected result |
| `Esc` | Close search |

## Modals and popups

| Shortcut | Action |
|---|---|
| `Tab` / `Shift + Tab` | Cycle through controls |
| `Enter` / `Space` | Activate the focused control |
| `Arrow keys` | Move between options in a group |
| `Esc` | Close the active modal |

## Discovery and conventions

- **Platform-aware modifiers.** Use `Cmd` on macOS; `Ctrl` on Windows and Linux. The browser detects the platform and adjusts.
- **Context awareness.** The single-key shortcuts (`/`, `?`) only fire when focus is *outside* a text input, so they don't fight with normal typing.
- **No mouse required.** Every interaction documented elsewhere in the browser docs has a keyboard path. If you find one that doesn't, please file an accessibility issue.

## See also

- **[ACCESSIBILITY.md](ACCESSIBILITY.md)** — the broader WCAG 2.1 AA capability claim (screen-reader support, focus indicators, reduced motion, etc.).
- **[apps/browser/docs/KEYBOARD-NAV.md](../../apps/browser/docs/KEYBOARD-NAV.md)** — implementation: the `useKeyboardShortcuts` hook, `useRovingTabIndex`, focus-management patterns, testing strategy.
