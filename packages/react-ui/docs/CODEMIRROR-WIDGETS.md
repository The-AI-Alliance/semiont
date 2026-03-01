# CodeMirror Widgets (AnnotateView Only)

## Overview

Inline widgets enhance the **AnnotateView** curation experience by adding interactive visual indicators next to annotations. BrowseView does not use widgets — see [ANNOTATION-OVERLAY.md](../../../ANNOTATION-OVERLAY.md).

The widget system currently provides one type:

- **ReferenceResolutionWidget** — Shows resolution status next to reference annotations (🔗 resolved, ❓ stub, ✨ generating)

## Implementation

### Files

- **Widget class**: `src/lib/codemirror-widgets.ts`
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
   - Click: Emits `navigation:reference-navigate` event
   - Hover: Shows tooltip with target document name via `showWidgetPreview()`

2. **Generating (✨)**: Document is being created
   - Pulsing yellow circle animation
   - Disabled (no click handler)

3. **Stub/Unresolved (❓)**: No target document
   - Click: Emits `navigation:click` event to open resolution UI

**Constructor** (3 parameters — no eventBus):

```typescript
new ReferenceResolutionWidget(annotation, targetDocumentName?, isGenerating?)
```

**Widget equality** (`eq()` method):

```typescript
eq(other: ReferenceResolutionWidget) {
  return other.annotation.id === this.annotation.id &&
         getBodySource(other.annotation.body) === getBodySource(this.annotation.body) &&
         other.targetDocumentName === this.targetDocumentName &&
         other.isGenerating === this.isGenerating;
}
```

### Tooltip Functions

Two standalone functions handle tooltip display (called from delegated handlers in CodeMirrorRenderer):

```typescript
// Show tooltip above widget
showWidgetPreview(container: HTMLElement, documentName: string): void

// Remove tooltip
hideWidgetPreview(container: HTMLElement): void
```

## Delegated Event Handlers

In `CodeMirrorRenderer.tsx`, three handlers manage widget interactions:

**`handleWidgetClick`**: Finds `.reference-preview-widget` via `closest()`. If resolved with a body source, emits `navigation:reference-navigate`. Otherwise emits `navigation:click`.

**`handleWidgetMouseEnter`** (capture phase): Sets indicator opacity to 1. If resolved with a target name, calls `showWidgetPreview()`.

**`handleWidgetMouseLeave`** (capture phase): Resets indicator opacity to 0.6. If resolved, calls `hideWidgetPreview()`.

## Widget Decoration Building

```typescript
function buildWidgetDecorations(
  content: string,
  segments: TextSegment[],
  generatingReferenceId: string | null | undefined,
  getTargetDocumentName?: (documentId: string) => string | undefined
): DecorationSet
```

- Filters to annotated segments, sorts by end position
- Creates `ReferenceResolutionWidget` for each reference annotation
- Places widget at segment end with `side: 1` (appears after annotation text)
- Uses separate `StateField` (`widgetDecorationsField`) from annotation decorations

## Styling

All widget styles are inline — no external CSS dependencies:

- Resolved/stub indicators: 10px font, 0.6 opacity (1.0 on hover)
- Generating state: Pulsing yellow circle with sparkle
- Dark mode: Checked via `document.documentElement.classList.contains('dark')`
- Tooltips: Absolute positioned, dark background, `fadeIn` animation

## Related Documentation

- [CODEMIRROR-INTEGRATION.md](./CODEMIRROR-INTEGRATION.md) - CodeMirror integration and event delegation
- [RENDERING-ARCHITECTURE.md](./RENDERING-ARCHITECTURE.md) - Dual rendering architecture
- [ANNOTATION-OVERLAY.md](../../../ANNOTATION-OVERLAY.md) - BrowseView rendering (no widgets)
- [ANNOTATIONS.md](./ANNOTATIONS.md) - Annotation UI/UX and workflows
