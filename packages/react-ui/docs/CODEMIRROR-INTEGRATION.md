# CodeMirror Integration (AnnotateView Only)

## Overview

`@semiont/react-ui` uses CodeMirror 6 for **AnnotateView** (curation mode) to render markdown documents with annotations. BrowseView uses a completely different approach (ReactMarkdown + DOM overlay) documented in [RENDERING-ARCHITECTURE.md](./RENDERING-ARCHITECTURE.md).

## Why CodeMirror?

Annotations are stored as offsets into the source markdown, counted in Unicode code points from its start. When markdown is rendered to HTML, the text an offset points into is no longer there (e.g., `# Title` becomes `<h1>Title</h1>`). CodeMirror displays the source text itself:

- Every character of the source is displayed, in order: no markdown syntax comes between an offset and what is shown
- An offset becomes a position in the editor's document by one conversion of count (see [Offsets and Document Positions](#offsets-and-document-positions))
- A selection is read back by the same conversion, so it is recorded where the reader made it

## CodeMirrorRenderer

**Location**: `src/components/CodeMirrorRenderer.tsx`

### Architecture

The component creates a CodeMirror instance once on mount and updates it incrementally:

1. **View lifecycle**: Created once, persists for component lifetime (recreated only when `hoverDelayMs` changes). Destroyed on unmount.
2. **Content updates**: Dispatched as transactions (preserves cursor position).
3. **Annotation decorations**: Updated via `StateField` + `StateEffect` — no view recreation.
4. **Widget decorations**: Separate `StateField` for reference resolution widgets.
5. **Event handling**: Container-level delegation for clicks, hovers, and widget interactions.

### Props

AnnotateView's text renderer (`TextAnnotateRenderer`, `src/components/resource/annotate-renderers.tsx`) mounts it along these lines:

```tsx
declare const segments: TextSegment[];          // segmentTextWithAnnotations(content, textOffsets(content), annotations)
declare const sparkleAnnotationIds: Set<string>;
declare const getTargetResourceName: (resourceId: string) => string | undefined;

<CodeMirrorRenderer
  content={content}
  segments={segments}
  editable={false}
  sparkleAnnotationIds={sparkleAnnotationIds}
  hoveredAnnotationId={hoveredAnnotationId}
  sourceView={true}
  showLineNumbers={false}
  hoverDelayMs={150}
  enableWidgets={true}
  session={session}
  getTargetResourceName={getTargetResourceName}
/>;
```

`content` and `hoverDelayMs` are required. The rest are optional: `onChange` and
`editable` for editing (Compose uses them), `scrollToAnnotationId`, and
`generatingReferenceId` (the reference whose widget shows ✨). Emissions go
through `session` — its client's `browse` and `beckon` namespaces.

### Incremental Decoration Updates

```typescript
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

// File-local in CodeMirrorRenderer.tsx
interface AnnotationUpdate {
  segments: TextSegment[];
  sparkleAnnotationIds?: Set<string>;
}
declare function buildAnnotationDecorations(segments: TextSegment[], sparkleAnnotationIds?: Set<string>): DecorationSet;

// Effect triggers decoration rebuild
const updateAnnotationsEffect = StateEffect.define<AnnotationUpdate>();

// StateField manages decorations — only rebuilds when effect is dispatched
const annotationDecorationsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, tr) {
    decorations = decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(updateAnnotationsEffect)) {
        decorations = buildAnnotationDecorations(
          effect.value.segments,
          effect.value.sparkleAnnotationIds
        );
      }
    }
    return decorations;
  },
  provide: field => EditorView.decorations.from(field)
});
```

### Anchor Strategy & Confidence

`segmentTextWithAnnotations()` anchors each annotation via `anchorAnnotation` (from `@semiont/core`), and each segment carries the `strategy` and `confidence` that placed it (see [Utilities.md](../../core/docs/Utilities.md#render-time-anchoring)). Anchoring is **verbatim-only**: it re-anchors on an exact `TextQuoteSelector` match (recovering positional drift) and otherwise renders at the stored `TextPositionSelector` offset, flagged. It never fuzzy-matches at render time — fuzzy reconciliation happens once, at write time, in `reconcileSelector`.

The decoration layer surfaces the classification:

- `getAnnotationDecorationMeta` adds an `annotation-low-confidence` class whenever `confidence !== 'high'`, and appends the strategy to the hover tooltip (e.g. `… (anchored: position-tiebreaker)`).
- `CodeMirrorRenderer` writes `data-anchor-strategy` and `data-anchor-confidence` onto the decoration's DOM attributes.
- `.annotation-low-confidence` (in `annotation/annotations.css`) draws a dotted underline, so operators can see at a glance which highlights were resolved by a tiebreaker or fell back to the stored offset rather than a clean match.

A clean `fast-path` / `unique-occurrence` anchor is silent; anything else is the visible signal of worker/renderer anchor drift.

### Offsets and Document Positions

A segment's `start` and `end`, like a `TextPositionSelector`'s, are offsets into the content: they count its Unicode code points, exactly as decoded. The editor's document counts differently in two ways:

- it is indexed in UTF-16 code units, where a character outside the Basic Multilingual Plane (an emoji, a mathematical letter, some CJK) is two;
- it holds every line break as one unit, whatever the content ends its lines with, where the content's CRLF is two code points.

`documentPositions(content, offsets)` (`src/lib/codemirror-logic.ts`) is the one place the two counts meet, in both directions. `offsets` is the content's `textOffsets(content)` from `@semiont/core`, made once for a content.

- `positionAt(offset)` is display: `convertSegmentPositions(segments, positions)` places each segment in the document before the decorations are built.
- `offsetAt(position)` is capture: `AnnotateView` takes each end of a selection from `posAtDOM()`'s position to an offset.

In the content `😀 𝑥 one\r\ntwo`, the word `two` is at:

| | start | end |
|---|---|---|
| offset into the content (code points) | 9 | 12 |
| position in the JavaScript string (UTF-16 code units) | 11 | 14 |
| position in the editor's document | 10 | 13 |

Each lookup is a binary search among the content's CRLFs and its characters outside the basic plane. A content with neither converts by identity.

### Event Delegation

All event handling uses container-level delegation — no per-annotation or per-widget listeners:

**Annotation clicks**: `click` handler on CodeMirror's DOM finds `[data-annotation-id]` via `closest()`, looks up the segment from `segmentsByIdRef` (O(1) Map), and emits `browse:click`.

**Annotation hovers**: `mouseover`/`mouseout` handlers use `createHoverHandlers` with configurable delay, calling `session.client.beckon.hover(id)` (`beckon:hover`).

**Widget interactions**: `click`, `mouseenter` (capture), `mouseleave` (capture) handlers find `.reference-preview-widget` via `closest()` and read data attributes for routing. See [CODEMIRROR-WIDGETS.md](./CODEMIRROR-WIDGETS.md).

### Scroll and Pulse

When `hoveredAnnotationId` changes, the component:

1. Finds the annotation element via `querySelector('[data-annotation-id="..."]')`
2. Finds the scroll container (`.semiont-annotate-view__content` or `.semiont-document-viewer__scrollable-body`)
3. Checks visibility within the container
4. Scrolls smoothly if not visible
5. Applies `annotation-pulse` CSS class after 100ms delay

## Integration with AnnotateView

**Location**: `src/components/resource/AnnotateView.tsx`

AnnotateView provides:

- **Text segmentation**: its text renderer, `TextAnnotateRenderer`, calls `segmentTextWithAnnotations()`, which anchors each annotation via `anchorAnnotation` (from `@semiont/core`) — verbatim-only, carrying a `strategy`/`confidence` onto each segment
- **Selection capture**: `EditorView.posAtDOM()` gives the position in the editor's document of each end of the DOM selection, and `documentPositions(...).offsetAt()` its offset into the content. The quote is the content's own text between the two offsets
- **Annotation creation**: `session.client.mark.request(...)` emits `mark:requested` with dual selectors (`TextPositionSelector` + `TextQuoteSelector` with prefix/suffix context)
- **MIME routing**: `defaultAnnotateRenderers` (overridable through the `renderers` prop) routes to `CodeMirrorRenderer` (text), `PdfAnnotationCanvas` (PDF), or `SvgDrawingCanvas` (image)

## Performance Optimizations

- **Binary search position conversion**: O(log n) per segment end, among the content's CRLFs and its characters outside the basic plane; both lists are built once for a content
- **Annotation ID index**: `Map<string, TextSegment>` for O(1) click lookups
- **Position-hint fast path**: `anchorAnnotation()` short-circuits when the content's text at the stored offset is `exact` — the stored offset already lands on the quote, so no occurrence search runs
- **Event delegation**: Container-level listeners replace per-annotation and per-widget handlers
- **Incremental decorations**: View created once, decorations updated via transactions

## Testing

- `packages/react-ui/src/lib/__tests__/codemirror-logic.test.ts` — segment placement in the editor's document, decoration and widget metadata
- `packages/react-ui/src/lib/__tests__/code-point-offsets.test.ts` — offsets against string and document positions: the offset table (`specs/src/text/offset-cases.json`) through the selection builder and the segmenter, and `documentPositions` both ways
- `packages/react-ui/src/components/resource/__tests__/AnnotateView.code-point-offsets.test.tsx` — with the real editor mounted: a selection recorded at its offsets, and a stored selector lighting its words, after characters outside the basic plane and in CRLF documents
- `packages/core/src/__tests__/anchor-annotation.test.ts` — render-time anchoring strategies and confidence (verbatim-only)
- `packages/react-ui/src/lib/__tests__/text-segmentation.test.ts` — strategy/confidence threading, low-confidence class, once-per-annotation warning
- `packages/react-ui/src/components/resource/__tests__/BrowseView.test.tsx` — event delegation integration

## Related Documentation

- [RENDERING-ARCHITECTURE.md](./RENDERING-ARCHITECTURE.md) - Dual rendering pipeline overview
- [CODEMIRROR-WIDGETS.md](./CODEMIRROR-WIDGETS.md) - Reference resolution widgets
- [ANNOTATION-RENDERING-PRINCIPLES.md](./ANNOTATION-RENDERING-PRINCIPLES.md) - Rendering axioms
- [W3C-WEB-ANNOTATION.md](../../../docs/protocol/W3C-WEB-ANNOTATION.md) - W3C annotation model
