# CodeMirror Integration (AnnotateView Only)

## Overview

`@semiont/react-ui` uses CodeMirror 6 for **AnnotateView** (curation mode) to render markdown documents with annotations. BrowseView uses a completely different approach (ReactMarkdown + DOM overlay) documented in [ANNOTATION-OVERLAY.md](../../../ANNOTATION-OVERLAY.md).

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

- **Text segmentation**: `segmentTextWithAnnotations()` uses fuzzy anchoring (`findTextWithContext` from `@semiont/api-client`) with pre-computed `ContentCache` for batch efficiency
- **Position calculation**: `CodeMirror.posAtDOM()` converts DOM selection to source positions
- **Annotation creation**: Emits `mark:requested` with dual selectors (`TextPositionSelector` + `TextQuoteSelector` with prefix/suffix context)
- **MIME routing**: Routes to `CodeMirrorRenderer` (text), `PdfAnnotationCanvas` (PDF), or `SvgDrawingCanvas` (image)

## Performance Optimizations

- **Binary search CRLF conversion**: O(log n) per segment (was O(n) with `.filter()`)
- **Annotation ID index**: `Map<string, TextSegment>` for O(1) click lookups (was O(n) with `.find()`)
- **ContentCache**: Pre-compute `normalizeText()` and `toLowerCase()` once per document
- **Position-hint fast path**: `findTextWithContext()` short-circuits when `TextPositionSelector.start` is exact
- **Event delegation**: Container-level listeners replace per-annotation and per-widget handlers
- **Incremental decorations**: View created once, decorations updated via transactions (~10x improvement)

## Testing

- `apps/frontend/src/components/__tests__/CodeMirrorRenderer.test.tsx` — CRLF position conversion, segment building
- `packages/api-client/src/utils/__tests__/fuzzy-anchor.test.ts` — fuzzy anchoring, position hints, normalization
- `packages/react-ui/src/components/resource/__tests__/BrowseView.test.tsx` — event delegation integration

## Related Documentation

- [RENDERING-ARCHITECTURE.md](./RENDERING-ARCHITECTURE.md) - Dual rendering pipeline overview
- [CODEMIRROR-WIDGETS.md](./CODEMIRROR-WIDGETS.md) - Reference resolution widgets
- [ANNOTATION-OVERLAY.md](../../../ANNOTATION-OVERLAY.md) - BrowseView rendering (not CodeMirror)
- [ANNOTATION-RENDERING-PRINCIPLES.md](./ANNOTATION-RENDERING-PRINCIPLES.md) - Rendering axioms
- [W3C-WEB-ANNOTATION.md](../../../specs/docs/W3C-WEB-ANNOTATION.md) - W3C annotation model
