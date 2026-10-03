# CodeMirror Widgets (AnnotateView Only)

## Overview

Inline widgets enhance the **AnnotateView** curation experience by adding interactive visual indicators next to annotations. BrowseView does not use widgets — see [RENDERING-ARCHITECTURE.md](./RENDERING-ARCHITECTURE.md).

The widget system provides one type:

- **ReferenceResolutionWidget** — Shows resolution status next to reference annotations (🔗 resolved, ❓ stub, ✨ generating)

## Implementation

### Files

- **Widget class**: `src/lib/codemirror-widgets.ts`
- **Delegated handlers**: `src/lib/codemirror-handlers.ts`
- **Widget placement**: `src/lib/codemirror-logic.ts` (`computeWidgetDecorations`)
- **Integration**: `src/components/CodeMirrorRenderer.tsx`
- **Consumer**: `src/components/resource/AnnotateView.tsx`

### Event Delegation

Widgets use **no per-widget event listeners**. Instead:

1. `ReferenceResolutionWidget.toDOM()` sets data attributes on the container element
2. `CodeMirrorRenderer` handles all events via container-level delegation

Data attributes set by widgets:

- `data-widget-annotation-id` — annotation ID
- `data-widget-motivation` — annotation motivation
- `data-widget-resolved` — `"true"` or `"false"`
- `data-widget-body-source` — referenced document ID (if resolved)
- `data-widget-target-name` — referenced document name (if known)
- `data-widget-generating` — `"true"` when document is being generated

### ReferenceResolutionWidget

**States**:

1. **Resolved (🔗)**: Has a referenced document
   - Click: Emits `browse:resource-open` (via `browse.openResource(...)`)
   - Hover: Shows tooltip with target document name via `showWidgetPreview()`

2. **Generating (✨)**: Document is being created
   - Pulsing yellow circle animation
   - Disabled (no click handler)

3. **Stub/Unresolved (❓)**: No target document
   - Click: Emits `browse:click` event to open resolution UI

**Constructor** — the annotation, then the optional target name and generating flag:

```typescript
new ReferenceResolutionWidget(annotation);                    // resolved or stub, read off the annotation
new ReferenceResolutionWidget(annotation, 'Albert Einstein'); // resolved, with the name for its tooltip
new ReferenceResolutionWidget(annotation, undefined, true);   // generating
```

A resolved annotation shows 🔗 whatever its generating flag; the generating
state applies to an unresolved one.

**Widget equality** (`eq()`): two widgets are equal when their annotation ids,
their annotations' body sources (`getBodySource`), their target names and their
generating flags all match — so CodeMirror redraws a widget exactly when one of
those changes.

### Tooltip Functions

Two standalone functions handle tooltip display (called from delegated handlers in CodeMirrorRenderer):

```typescript
declare const container: HTMLElement; // a widget's .reference-preview-widget element

showWidgetPreview(container, 'Albert Einstein'); // show tooltip above widget
hideWidgetPreview(container);                    // remove tooltip
```

## Delegated Event Handlers

Three handlers in `src/lib/codemirror-handlers.ts` manage widget interactions; `CodeMirrorRenderer`'s delegated listeners call them and act on what they return:

**`handleWidgetClick`**: Finds `.reference-preview-widget` via `closest()`; a generating widget is not handled. If resolved with a body source, the result is a navigation, emitted as `browse:resource-open`. Otherwise it is a `browse:click`.

**`handleWidgetMouseEnter`** (capture phase): Sets indicator opacity to 1. If resolved with a target name, the renderer calls `showWidgetPreview()`.

**`handleWidgetMouseLeave`** (capture phase): Resets indicator opacity to 0.6. If resolved, the renderer calls `hideWidgetPreview()`.

## Widget Decoration Building

`buildWidgetDecorations` (file-local in `CodeMirrorRenderer.tsx`) turns the
text segments, the id of the reference being generated, and the renderer's
`getTargetResourceName` lookup into a `DecorationSet`:

- `computeWidgetDecorations` filters to reference-annotation segments and sorts them by end position
- Creates `ReferenceResolutionWidget` for each reference annotation
- Places widget at segment end with `side: 1` (appears after annotation text)
- Uses separate `StateField` (`widgetDecorationsField`) from annotation decorations, mounted only when the renderer's `enableWidgets` is set

## Styling

All widget styles are inline — no external CSS dependencies:

- Resolved/stub indicators: 10px font, 0.6 opacity (1.0 on hover)
- Generating state: Pulsing yellow circle with sparkle
- Dark mode: Checked via `document.documentElement.classList.contains('dark')`
- Tooltips: Absolute positioned, dark background, `fadeIn` animation

## Related Documentation

- [CODEMIRROR-INTEGRATION.md](./CODEMIRROR-INTEGRATION.md) - CodeMirror integration and event delegation
- [RENDERING-ARCHITECTURE.md](./RENDERING-ARCHITECTURE.md) - Dual rendering architecture
- [ANNOTATIONS.md](./ANNOTATIONS.md) - Annotation UI/UX and workflows
