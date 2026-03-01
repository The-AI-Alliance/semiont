# Rendering Architecture

## Overview

The `@semiont/react-ui` package provides **two rendering pipelines** for displaying documents with annotations (highlights, references, comments, assessments, tags):

- **AnnotateView** (curation mode): CodeMirror-based editor with decorations and widgets
- **BrowseView** (browse mode): ReactMarkdown with DOM Range overlay for annotations

Both support text, image (SVG), and PDF content via MIME-type routing.

## Dual Rendering Architecture

### AnnotateView (CodeMirror)

- **Use case**: Curation mode — creating/editing annotations
- **Renderer**: CodeMirror 6 editor via `CodeMirrorRenderer`
- **Styling**: Monospace font, source view with line numbers
- **Features**: Inline widgets (🔗, ❓, ✨), hover effects, event delegation, text selection for annotation creation
- **See**: [CODEMIRROR-INTEGRATION.md](./CODEMIRROR-INTEGRATION.md)

### BrowseView (ReactMarkdown + DOM Overlay)

- **Use case**: Browse mode — read-only document viewing
- **Renderer**: ReactMarkdown with remark-gfm, annotations applied as DOM Range overlays after paint
- **Styling**: Variable-width font, prose reading experience
- **Features**: Click-to-navigate, hover highlighting, annotation overlay via `annotation-overlay.ts`
- **See**: [ANNOTATION-OVERLAY.md](../../../ANNOTATION-OVERLAY.md)

## Component Hierarchy

```text
ResourceViewer
├── AnnotateView (curation mode)
│   ├── AnnotateToolbar (motivation/click/shape selection)
│   └── Content area (MIME-routed):
│       ├── CodeMirrorRenderer (text/*)
│       ├── PdfAnnotationCanvas (application/pdf)
│       └── SvgDrawingCanvas (image/*)
└── BrowseView (browse mode)
    ├── AnnotateToolbar (click action only)
    └── Content area (MIME-routed):
        ├── MemoizedMarkdown + DOM overlay (text/*)
        ├── PdfAnnotationCanvas (application/pdf)
        └── ImageViewer + SvgDrawingCanvas (image/*)
```

## Key Components

### AnnotateView

**Location**: `src/components/resource/AnnotateView.tsx`

**Responsibilities**:

- Routes to appropriate viewer based on MIME type category (`text`, `image`, `unsupported`)
- Manages text selection for annotation creation using CodeMirror's `posAtDOM()` API
- Emits `annotate:requested` events with dual selectors (`TextPositionSelector` + `TextQuoteSelector`)
- Subscribes to toolbar events and hover events via `useEventSubscriptions`
- Pre-computes text segments with fuzzy anchoring via `segmentTextWithAnnotations()`

**Fuzzy Anchoring**: Uses `findTextWithContext()` from `@semiont/api-client` with `ContentCache` for efficient batch processing. Falls back through: position hint → exact match → normalized match → case-insensitive → fuzzy.

### BrowseView

**Location**: `src/components/resource/BrowseView.tsx`

**Responsibilities**:

- Renders markdown via `MemoizedMarkdown` (memo'd to avoid re-renders on annotation changes)
- Applies annotations as DOM overlays after paint using `annotation-overlay.ts`
- Builds source→rendered position map, text node index, resolves annotation ranges, and applies highlights
- Handles hover via delegated `createHoverHandlers` with configurable delay
- Emits `navigation:click` and `attend:hover` events

**See**: [ANNOTATION-OVERLAY.md](../../../ANNOTATION-OVERLAY.md) for detailed implementation.

### CodeMirrorRenderer

**Location**: `src/components/CodeMirrorRenderer.tsx`

Used by **AnnotateView only**. Renders source markdown with CodeMirror 6.

**Key design decisions**:

- **Source positions = display positions**: No position mapping needed
- **Incremental decoration updates**: StateField + StateEffect system updates decorations without recreating the view
- **CRLF → LF conversion**: Binary search over pre-computed CRLF positions (O(log n) per segment)
- **Event delegation**: Single container-level listeners for annotation clicks, hovers, and widget interactions
- **Annotation ID index**: `Map<string, TextSegment>` for O(1) click lookups

**Props**:

- `content`, `segments`, `editable`, `sourceView`, `showLineNumbers`
- `hoveredAnnotationId`, `scrollToAnnotationId`, `newAnnotationIds`
- `enableWidgets`, `eventBus`, `getTargetDocumentName`, `generatingReferenceId`
- `hoverDelayMs` — configurable hover delay for accessibility

## Data Flow

### Rendering Pipeline

**AnnotateView (text)**:

```text
content + annotations
→ segmentTextWithAnnotations() (fuzzy anchoring with ContentCache)
→ CodeMirrorRenderer
→ convertSegmentPositions() (CRLF → LF binary search)
→ StateField with incremental decoration updates
→ Widget decorations (reference resolution indicators)
→ Delegated event handlers (click, hover, widget interactions)
```

**BrowseView (text)**:

```text
content + annotations
→ MemoizedMarkdown (renders once, memo'd)
→ DOM paint completes
→ buildSourceToRenderedMap() + buildTextNodeIndex()
→ toOverlayAnnotations() + resolveAnnotationRanges()
→ applyHighlights() (DOM Range overlay with data attributes)
→ Delegated event handlers (click, hover)
```

### Annotation Creation

```text
User selects text in AnnotateView
→ mouseup handler
→ CodeMirror posAtDOM() for accurate source positions
→ extractContext() for prefix/suffix
→ eventBus.get('annotate:requested').next({
    selector: [TextPositionSelector, TextQuoteSelector],
    motivation
  })
```

### Bi-directional Focusing

```text
History → Document:
  attend:hover event → hoveredAnnotationId prop
  → CodeMirrorRenderer scrolls to annotation + pulse animation

Document → History:
  mouseover delegation → attend:hover event
  → History panel scrolls to corresponding event
```

## Position Mapping

### The Problem

Annotations store positions in source markdown. Rendered HTML has different positions due to syntax characters (`#`, `**`, etc.) being consumed.

### Solutions

- **AnnotateView**: Displays source markdown directly — positions are 1:1. No mapping needed.
- **BrowseView**: Uses `buildSourceToRenderedMap()` to compute a monotonic source→rendered position map by walking the markdown AST. Annotations are applied at rendered positions via DOM Ranges.

### CRLF Handling

CodeMirror normalizes all line endings to LF. `convertSegmentPositions()` adjusts annotation positions from CRLF space to LF space using binary search over pre-computed CRLF positions.

## Performance

- **Incremental decorations**: View created once, decorations updated via transactions
- **ContentCache**: `normalizeText()` and `toLowerCase()` computed once per document, shared across all annotations
- **Position-hint fast path**: `findTextWithContext()` short-circuits in O(1) when `TextPositionSelector.start` points directly at the exact text
- **Binary search CRLF conversion**: O(log n) per segment instead of O(n)
- **Annotation ID index**: O(1) click lookups via `Map<string, TextSegment>`
- **Event delegation**: Container-level listeners instead of per-annotation/per-widget handlers
- **Memoized markdown**: BrowseView's `MemoizedMarkdown` only re-renders when content changes

## Testing

- Property-based tests verifying rendering axioms (see [ANNOTATION-RENDERING-PRINCIPLES.md](./ANNOTATION-RENDERING-PRINCIPLES.md))
- `CodeMirrorRenderer.test.tsx` — CRLF position conversion, segment building
- `annotation-overlay.test.ts` — source→rendered mapping, overlay application, hover/click behavior
- `BrowseView.test.tsx` — event delegation, annotation rendering, MIME routing
- `fuzzy-anchor.test.ts` — text matching, position hints, normalization

## Related Documentation

- [W3C-WEB-ANNOTATION.md](../../../specs/docs/W3C-WEB-ANNOTATION.md) - W3C Web Annotation implementation
- [ANNOTATIONS.md](./ANNOTATIONS.md) - Annotation UI/UX and workflows
- [CODEMIRROR-INTEGRATION.md](./CODEMIRROR-INTEGRATION.md) - AnnotateView rendering implementation
- [CODEMIRROR-WIDGETS.md](./CODEMIRROR-WIDGETS.md) - Inline widget system
- [ANNOTATION-OVERLAY.md](../../../ANNOTATION-OVERLAY.md) - BrowseView DOM overlay rendering
- [ANNOTATION-RENDERING-PRINCIPLES.md](./ANNOTATION-RENDERING-PRINCIPLES.md) - Rendering axioms and correctness properties
- [ARCHITECTURE.md](./ARCHITECTURE.md) - Overall react-ui architecture
