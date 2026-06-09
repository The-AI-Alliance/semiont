# CodeMirror Integration (AnnotateView Only)

## Overview

`@semiont/react-ui` uses CodeMirror 6 for **AnnotateView** (curation mode) to render markdown documents with annotations. BrowseView uses a completely different approach (ReactMarkdown + DOM overlay) documented in [RENDERING-ARCHITECTURE.md](./RENDERING-ARCHITECTURE.md).

## Why CodeMirror?

Annotations are stored as character positions in source markdown. When markdown is rendered to HTML, positions change (e.g., `# Title` becomes `<h1>Title</h1>`). CodeMirror solves this by displaying the source text directly:

- Source positions = display positions (perfect 1:1 mapping)
- No position transformation needed
- 100% accurate annotation placement

## CodeMirrorRenderer

**Location**: `src/components/CodeMirrorRenderer.tsx`

### Architecture

The component creates a CodeMirror instance once on mount and updates it incrementally:

1. **View lifecycle**: Created once, persists for component lifetime. Destroyed on unmount.
2. **Content updates**: Dispatched as transactions (preserves cursor position).
3. **Annotation decorations**: Updated via `StateField` + `StateEffect` — no view recreation.
4. **Widget decorations**: Separate `StateField` for reference resolution widgets.
5. **Event handling**: Container-level delegation for clicks, hovers, and widget interactions.

### Props

```typescript
interface Props {
  content: string;
  segments?: TextSegment[];
  onTextSelect?: (exact: string, position: { start: number; end: number }) => void;
  onChange?: (content: string) => void;
  editable?: boolean;
  newAnnotationIds?: Set<string>;
  hoveredAnnotationId?: string | null;
  scrollToAnnotationId?: string | null;
  sourceView?: boolean;
  showLineNumbers?: boolean;
  enableWidgets?: boolean;
  eventBus?: EventBus;
  getTargetDocumentName?: (documentId: string) => string | undefined;
  generatingReferenceId?: string | null;
  hoverDelayMs: number;
}
```

### Incremental Decoration Updates

```typescript
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
          effect.value.newAnnotationIds
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

### CRLF Position Conversion

CodeMirror normalizes all line endings to LF. Annotations store positions in original content (which may have CRLF). `convertSegmentPositions()` adjusts using binary search:

```typescript
function convertSegmentPositions(segments: TextSegment[], content: string): TextSegment[] {
  if (!content.includes('\r\n')) return segments;

  // Find all CRLF positions (sorted by construction)
  const crlfPositions: number[] = [];
  for (let i = 0; i < content.length - 1; i++) {
    if (content[i] === '\r' && content[i + 1] === '\n') {
      crlfPositions.push(i);
    }
  }

  // Binary search: count CRLFs before position in O(log n)
  const convertPosition = (pos: number): number => {
    let lo = 0;
    let hi = crlfPositions.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (crlfPositions[mid]! < pos) lo = mid + 1;
      else hi = mid;
    }
    return pos - lo;
  };

  return segments.map(seg => ({
    ...seg,
    start: convertPosition(seg.start),
    end: convertPosition(seg.end)
  }));
}
```

### Event Delegation

All event handling uses container-level delegation — no per-annotation or per-widget listeners:

**Annotation clicks**: `click` handler on CodeMirror's DOM finds `[data-annotation-id]` via `closest()`, looks up the segment from `segmentsByIdRef` (O(1) Map), and emits `browse:click`.

**Annotation hovers**: `mouseover`/`mouseout` handlers use `createHoverHandlers` with configurable delay, emitting `beckon:hover`.

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

- **Text segmentation**: `segmentTextWithAnnotations()` anchors each annotation via `anchorAnnotation` (from `@semiont/core`) — verbatim-only, carrying a `strategy`/`confidence` onto each segment
- **Position calculation**: `CodeMirror.posAtDOM()` converts DOM selection to source positions
- **Annotation creation**: Emits `mark:requested` with dual selectors (`TextPositionSelector` + `TextQuoteSelector` with prefix/suffix context)
- **MIME routing**: Routes to `CodeMirrorRenderer` (text), `PdfAnnotationCanvas` (PDF), or `SvgDrawingCanvas` (image)

## Performance Optimizations

- **Binary search CRLF conversion**: O(log n) per segment (was O(n) with `.filter()`)
- **Annotation ID index**: `Map<string, TextSegment>` for O(1) click lookups (was O(n) with `.find()`)
- **Position-hint fast path**: `anchorAnnotation()` short-circuits when `content.substring(start, start + exact.length) === exact` — the stored offset already lands on the quote, so no occurrence search runs
- **Event delegation**: Container-level listeners replace per-annotation and per-widget handlers
- **Incremental decorations**: View created once, decorations updated via transactions (~10x improvement)

## Testing

- `apps/frontend/src/components/__tests__/CodeMirrorRenderer.test.tsx` — CRLF position conversion, segment building
- `packages/core/src/__tests__/anchor-annotation.test.ts` — render-time anchoring strategies and confidence (verbatim-only)
- `packages/react-ui/src/lib/__tests__/text-segmentation.test.ts` — strategy/confidence threading, low-confidence class, once-per-annotation warning
- `packages/react-ui/src/components/resource/__tests__/BrowseView.test.tsx` — event delegation integration

## Related Documentation

- [RENDERING-ARCHITECTURE.md](./RENDERING-ARCHITECTURE.md) - Dual rendering pipeline overview
- [CODEMIRROR-WIDGETS.md](./CODEMIRROR-WIDGETS.md) - Reference resolution widgets
- [ANNOTATION-RENDERING-PRINCIPLES.md](./ANNOTATION-RENDERING-PRINCIPLES.md) - Rendering axioms
- [W3C-WEB-ANNOTATION.md](../../../docs/protocol/W3C-WEB-ANNOTATION.md) - W3C annotation model
