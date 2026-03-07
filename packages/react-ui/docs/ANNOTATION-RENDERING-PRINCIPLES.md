# Annotation Rendering Principles

## Overview

This document defines the fundamental axioms and correctness properties that govern annotation rendering in Semiont. These principles ensure accurate, predictable, and maintainable annotation behavior across different rendering modes and document types.

## Fundamental Axioms

The annotation rendering system is built on nine fundamental axioms, verified through property-based testing:

### 1. POSITION PRESERVATION

Annotations must preserve the exact character positions from the source text, regardless of rendering transformations.

**Implications:**
- Character offsets are always relative to the original source text
- Markdown transformations don't affect position calculations
- Positions remain stable across re-renders

**Example:**
```typescript
const text = "# Title\n- dog\n- cat";
const annotation = { offset: 8, length: 3, text: "dog" };
// Position 8-11 always refers to "dog" in source, regardless of how markdown renders
```

### 2. NON-OVERLAPPING

Multiple annotations can exist but the renderer must handle overlapping gracefully.

**Strategy:**
- Skip overlapping annotations (first-come-first-served)
- Maintain clear visual boundaries
- Prevent annotation collision in the DOM

**Rationale:** Overlapping spans in HTML create ambiguous click targets and complex event handling. Skipping overlaps provides predictable behavior.

### 3. CONTENT INTEGRITY

The rendered text content must match the source content exactly.

**Requirements:**
- Annotations only add styling, never modify text
- All characters from source must appear in rendered output
- Text reconstruction from segments must equal original text

**Verification:**
```typescript
const segments = segmentTextWithAnnotations(text, annotations);
const reconstructed = segments.map(s => s.text).join('');
assert(reconstructed === text); // Must always be true
```

### 4. SELECTION INDEPENDENCE

User text selection must work independently of annotations.

**Guarantees:**
- Browser selection behavior is preserved
- Selecting text doesn't interfere with annotation rendering
- Copy/paste operations work on the underlying text

**Implementation:** Annotations use CSS styling and data attributes rather than nested DOM structures that break text selection.

### 5. MARKDOWN TRANSPARENCY

Markdown rendering must be transparent to position tracking.

**Principles:**
- Positions refer to source text, not rendered HTML
- Markdown syntax characters are included in position counts
- Annotations work across markdown boundaries

**Why CodeMirror:** This axiom drove the decision to use CodeMirror for AnnotateView. By showing markdown source with syntax highlighting, positions map 1:1 with the source text, eliminating complex coordinate transformations.

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

**Implementation:** Each annotation span has unique `data-annotation-id` attributes, and event handlers verify they're operating on the correct annotation.

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

## Property-Based Testing

The system uses [fast-check](https://github.com/dubzzz/fast-check) for property-based testing to verify axioms hold across a wide range of inputs.

### Testing Approach

```typescript
import fc from 'fast-check';

// Property: Content Integrity
fc.property(
  fc.string({ minLength: 0, maxLength: 1000 }),
  fc.array(annotationGenerator),
  (text, annotations) => {
    const segments = segmentTextWithAnnotations(text, annotations);
    const reconstructed = segments.map(s => s.text).join('');
    return reconstructed === text;
  }
);

// Property: Position Preservation
fc.property(
  fc.string(),
  fc.array(annotationGenerator),
  (text, annotations) => {
    const segments = segmentTextWithAnnotations(text, annotations);

    for (const annotation of annotations) {
      const annotatedText = text.slice(
        annotation.offset,
        annotation.offset + annotation.length
      );

      // Find corresponding segment
      const segment = segments.find(s =>
        s.annotation?.id === annotation.id
      );

      if (segment) {
        return segment.text === annotatedText;
      }
    }
    return true;
  }
);
```

### Test Coverage

Property-based tests verify:
1. Content integrity across random text and annotation combinations
2. Position preservation for valid and edge-case offsets
3. Non-overlapping handling (first annotation wins)
4. Incremental stability (adding/removing doesn't affect others)
5. Markdown transparency (positions match source regardless of rendering)

## Design Decisions Informed by Axioms

### Why CodeMirror for AnnotateView?

**Problem:** ReactMarkdown transforms `# Title` to `<h1>Title</h1>`, making source position 0 map to different display positions depending on HTML structure.

**Solution:** CodeMirror shows source text with syntax highlighting. Position 0 in source = position 0 in display.

**Tradeoff:** Less beautiful rendering, perfect accuracy. Users can switch to BrowseView for clean reading.

**Axiom Satisfied:** MARKDOWN TRANSPARENCY, POSITION PRESERVATION

### Why Skip Overlapping Annotations?

**Problem:** HTML spans can't cleanly overlap: `<span>hello <span>wo</span>rld</span>` creates ambiguous click targets.

**Solution:** First annotation wins, later overlapping annotations are skipped during segmentation.

**Tradeoff:** Some annotations might not render, but rendered ones are always clickable and correct.

**Axiom Satisfied:** NON-OVERLAPPING, INTERACTION ISOLATION

### Why Optimistic Updates?

**Problem:** Waiting for server confirmation creates laggy UX.

**Solution:** Update UI immediately, rollback on error.

**Tradeoff:** Possible temporary inconsistency, much better perceived performance.

**Axiom Satisfied:** REACTIVITY

## Related Documentation

### Implementation Details
- See `src/lib/annotation-registry.ts` - Annotation rendering logic
- See `src/components/resource/AnnotateView.tsx` - Main annotation UI

### Data Model & API
- [W3C-WEB-ANNOTATION.md](../../../specs/docs/W3C-WEB-ANNOTATION.md) - W3C annotation structure and full-stack implementation
- See `@semiont/api-client` package - API client and utilities

### Testing
- `src/lib/__tests__/annotation-rendering.test.tsx` - Property-based tests implementing these axioms
- `src/lib/__tests__/pdf-coordinates.test.ts` - Property-based tests for PDF coordinate transformations
