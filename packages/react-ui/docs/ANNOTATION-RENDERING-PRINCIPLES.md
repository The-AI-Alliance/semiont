# Annotation Rendering Principles

## Overview

This document defines the fundamental axioms and correctness properties that govern annotation rendering in Semiont. These principles ensure accurate, predictable, and maintainable annotation behavior across different rendering modes and document types.

## Fundamental Axioms

The annotation rendering system is built on ten fundamental axioms, verified by the tests listed under [Testing](#testing):

### 1. POSITION PRESERVATION

Annotations must keep their exact place in the source text, regardless of rendering transformations.

**Implications:**
- An offset is always into the original source text, and counts its Unicode code points from the start: a character outside the Basic Multilingual Plane is one, and a CRLF is two
- Markdown transformations don't affect position calculations
- Positions remain stable across re-renders

**Example:**
```typescript
const text = "# Title\n- dog\n- cat";
const annotation = { offset: 10, length: 3, text: "dog" };
// Offsets 10 to 13 are always "dog" in the source, regardless of how markdown renders
```

### 2. NON-OVERLAPPING

Multiple annotations can exist but the renderer must handle overlapping gracefully.

**Strategy:**
- AnnotateView (CodeMirror): skip overlapping annotations (first-come-first-served)
- BrowseView (overlay): nest overlapping spans per region, the later annotation innermost
- Maintain clear visual boundaries
- Prevent annotation collision in the DOM

**Rationale:** Overlapping CodeMirror marks create ambiguous click targets and complex event handling, so segmentation skips overlaps for predictable behavior. The BrowseView overlay works in positions of the rendered text against the pristine text nodes, so its overlap geometry is exact and every annotation renders.

### 3. CONTENT INTEGRITY

The rendered text content must match the source content exactly.

**Requirements:**
- Annotations only add styling, never modify text
- All characters from source must appear in rendered output
- Text reconstruction from segments must equal original text

**Verification:** the segments `segmentTextWithAnnotations(content, offsets, annotations)` returns (in `src/lib/text-segmentation.ts`) cover the content exactly:
```typescript
declare const segments: TextSegment[];
expect(segments.map((s) => s.exact).join('')).toBe(content); // Must always be true
```

### 4. SELECTION INDEPENDENCE

User text selection must work independently of annotations.

**Guarantees:**
- Browser selection behavior is preserved
- Selecting text doesn't interfere with annotation rendering
- Copy/paste operations work on the underlying text

**Implementation:** Annotations are spans carrying CSS classes and `data-annotation-*` attributes around the unchanged text, so selection and copy see the underlying text.

### 5. MARKDOWN TRANSPARENCY

Markdown rendering must be transparent to position tracking.

**Principles:**
- Positions refer to source text, not rendered HTML
- An offset counts markdown syntax characters, as it counts every character of the source
- Annotations work across markdown boundaries

**Why CodeMirror:** This axiom drove the decision to use CodeMirror for AnnotateView. By showing markdown source with syntax highlighting, every character an offset counts is displayed, in order. What is left is a conversion of count and not of content: the editor's document is indexed in UTF-16 code units and holds a line break as one unit, and `documentPositions()` converts between its positions and offsets.

### 6. INCREMENTAL STABILITY

Adding/removing one annotation should not affect the rendering of other non-overlapping annotations.

**Properties:**
- Each annotation is independent
- Changes are localized to affected regions
- No cascade effects on unrelated annotations

**Performance Benefit:** This enables efficient re-rendering when annotations change.

### 7. INTERACTION ISOLATION

Click/hover on annotations should not trigger on the wrong annotation or affect other annotations.

**Requirements:**
- Event handlers are properly scoped
- Click targets are precise
- No event bubbling issues

**Implementation:** Each annotation span carries its annotation's `data-annotation-id` (an annotation cut by node boundaries yields sibling spans sharing it), and event handlers verify they're operating on the correct annotation.

### 8. REACTIVITY

When annotations are added or removed, the rendering must update to reflect the current state immediately.

**Behavior:**
- Deletions are reflected in real-time
- Additions appear without refresh
- State changes trigger proper re-renders
- Old annotations are cleaned up before applying new ones

**React Integration:** Annotation arrays are part of React state, triggering re-renders when mutations occur.

### 9. MARKDOWN FIDELITY

Markdown elements must render as their semantic HTML equivalents with proper styling.

**Requirements:**
- Headers render as h1, h2, h3 with appropriate sizes
- Lists render as ul/ol with proper structure
- Code blocks have syntax highlighting
- All markdown features are preserved

**Dual-Mode Rendering:**
- **AnnotateView (CodeMirror):** Shows source with syntax highlighting - perfect position mapping
- **BrowseView (ReactMarkdown):** Shows rendered HTML - optimal reading experience

### 10. VERBATIM RENDER-TIME ANCHORING

The renderer trusts the stored selector and re-anchors only on a verbatim quote match. It never fuzzy-matches at render time.

**Rationale:** The event log is the system of record. An annotation's `TextPositionSelector` and `TextQuoteSelector` are written to agree — `reconcile` finds the span, and `annotationOfSpan` refuses one whose text from offset `start` to offset `end` is not `exact`, at write time. The only legitimate render-time discrepancy is *positional drift*: content shifted above the span after the annotation was written, so the offset is stale but the exact text still exists byte-identical. Re-anchoring to that verbatim match is the W3C-intended use of `TextQuoteSelector`, and is safe because it demands identical text — no judgment call.

**What the renderer does** (`anchorAnnotation` in `@semiont/core`):
- `fast-path` — the stored offset already lands on `exact`.
- `unique-occurrence` / `context-disambiguated` / `position-tiebreaker` — `exact` is found verbatim; prefix/suffix and (for repeated text) position pick the occurrence.
- `position-fallback` — `exact` is not found verbatim; render at the stored offset and flag low-confidence.

**What it does not do:** fuzzy / normalized / Levenshtein recovery. A non-verbatim mismatch means the content representation diverged or the record is wrong — both upstream concerns, fixed at the source (canonical content, or re-running detection), not papered over at render. Fuzzy matching lives only at write time in `reconcile`.

**Affordance:** every anchor carries a `strategy` and `confidence`. Anything below `confidence: 'high'` gets the `.annotation-low-confidence` class (dotted underline), a hover tooltip naming the strategy, and a one-shot `console.warn`, so corpus-wide anchor drift surfaces instead of staying invisible.

## Testing

The segmentation axioms are pinned by unit tests in `src/lib/__tests__/text-segmentation.test.ts`:

1. Content integrity: empty content, content with no annotations, and an annotation spanning the whole document each yield segments covering the content
2. Position preservation: single, leading, and multiple non-overlapping annotations land on their offsets
3. Non-overlapping: an overlapping annotation is skipped and the earlier one kept
4. Invalid and zero-length positions are filtered out
5. Verbatim re-anchoring: a stale `TextPositionSelector` re-anchors through the `TextQuoteSelector`, and annotated segments carry their anchor `strategy` and `confidence`
6. Low confidence: the `annotation-low-confidence` class and the strategy tooltip, and one degraded-anchor warning per annotation

What an offset counts is pinned by `src/lib/__tests__/code-point-offsets.test.ts`, which runs the offset table (`specs/src/text/offset-cases.json`) through the selection builder and the segmenter, and by `src/components/resource/__tests__/AnnotateView.code-point-offsets.test.tsx` and `BrowseView.code-point-offsets.test.tsx`, which mount the real editor and the real markdown renderer: a selection is recorded at its offsets, and a stored selector lights exactly its words, after characters outside the basic plane, in CRLF documents, and across markdown syntax.

The BrowseView overlay is covered by `src/lib/__tests__/annotation-overlay.test.ts`: the source→rendered position map across markdown syntax, the per-type CSS class, nested spans for overlapping annotations (later annotation innermost), one mutation per annotated text node, and a clean restore of the original text.

Property-based tests ([fast-check](https://github.com/dubzzz/fast-check)) cover the PDF coordinate transformations in `src/lib/__tests__/pdf-coordinates.test.ts` and the per-page rectangles in `src/components/pdf-annotation/__tests__/rects-for-page.test.ts`.

## Design Decisions Informed by Axioms

### Why CodeMirror for AnnotateView?

**Problem:** ReactMarkdown transforms `# Title` to `<h1>Title</h1>`, making source position 0 map to different display positions depending on HTML structure.

**Solution:** CodeMirror shows source text with syntax highlighting. Position 0 in source = position 0 in display.

**Tradeoff:** Less beautiful rendering, perfect accuracy. Users can switch to BrowseView for clean reading.

**Axiom Satisfied:** MARKDOWN TRANSPARENCY, POSITION PRESERVATION

### Why Skip Overlapping Annotations in AnnotateView?

**Problem:** Overlapping CodeMirror marks, like `<span>hello <span>wo</span>rld</span>`, create ambiguous click targets.

**Solution:** First annotation wins, later overlapping annotations are skipped during segmentation. BrowseView's overlay nests overlapping spans instead, so every annotation renders there.

**Tradeoff:** Some annotations might not render in AnnotateView, but rendered ones are always clickable and correct.

**Axiom Satisfied:** NON-OVERLAPPING, INTERACTION ISOLATION

## Related Documentation

### Implementation Details
- See `src/lib/text-segmentation.ts` - AnnotateView's text segmentation
- See `src/lib/annotation-overlay.ts` - BrowseView's annotation overlay
- See `src/lib/annotation-registry.ts` - Per-motivation class names
- See `src/components/resource/AnnotateView.tsx` - Main annotation UI

### Data Model & API
- [W3C-WEB-ANNOTATION.md](../../../docs/protocol/W3C-WEB-ANNOTATION.md) - W3C annotation structure and full-stack implementation
- See `@semiont/sdk` package - API client and utilities

### Testing
- `src/lib/__tests__/text-segmentation.test.ts` - Segmentation axioms
- `src/lib/__tests__/annotation-overlay.test.ts` - Overlay geometry
- `src/lib/__tests__/pdf-coordinates.test.ts` - Property-based tests for PDF coordinate transformations
