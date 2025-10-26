# CodeMirror Integration (AnnotateView Only)

## Overview

The Semiont frontend uses CodeMirror 6 for **AnnotateView** (curation mode) to render markdown documents with annotations. This document explains why we chose CodeMirror for annotation editing, how it's integrated, and future improvements.

**Important**: This document describes CodeMirror integration for **AnnotateView only**. BrowseView uses a completely different rendering approach (ReactMarkdown) documented in [REACT-MARKDOWN.md](./REACT-MARKDOWN.md).

## Why CodeMirror?

### The Position Mapping Problem

The fundamental challenge in our annotation system is that:
1. Annotations are stored as character positions in the **source markdown text**
2. Users expect to see **formatted markdown** (headers, bold, lists)
3. When markdown is rendered to HTML, positions change dramatically

Example:
```markdown
# Title
This is **bold** text.
```

- In source: "Title" is at positions 2-7 (after `# `)
- In rendered HTML: "Title" would be at positions 0-5 (no `# `)

### Why CodeMirror Solves This

CodeMirror displays the source text directly with syntax highlighting:
- Source positions = Display positions (perfect 1:1 mapping)
- Annotations work without any position transformation
- No complex mapping logic needed
- 100% accurate annotation placement

## Current Implementation

### CodeMirrorRenderer Component

**Location**: `/src/components/CodeMirrorRenderer.tsx`

**Key Features**:
1. Read-only markdown editor (configurable via `editable` prop)
2. Syntax highlighting for markdown
3. **Incremental decoration updates** (no view recreation)
4. Event handlers for annotation interactions (click, right-click, hover)
5. Bi-directional focusing with History panel
6. Line numbers in source view mode
7. Scroll and pulse animations for annotation highlighting

### Architecture: Incremental Updates

The component uses **CodeMirror's state management system** to update decorations incrementally without destroying and recreating the editor view:

```typescript
// Effect to trigger decoration updates
const updateAnnotationsEffect = StateEffect.define<AnnotationUpdate>();

// State field manages decorations incrementally
const annotationDecorationsField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, tr) {
    // Map existing decorations through document changes
    decorations = decorations.map(tr.changes);

    // Rebuild only when effect is dispatched
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

**Performance Benefits**:
- ✅ View created once on mount, persists for lifetime
- ✅ Decorations update via transactions, not recreation
- ✅ No flicker or scroll position loss
- ✅ Faster updates (~10x improvement measured)
- ✅ Lower memory usage

### Component Props

```typescript
interface Props {
  content: string;
  segments: TextSegment[];
  onAnnotationClick?: (annotation: AnnotationSelection) => void;
  onAnnotationRightClick?: (annotation: AnnotationSelection, x: number, y: number) => void;
  onAnnotationHover?: (annotationId: string | null) => void;
  onTextSelect?: (text: string, position: { start: number; end: number }) => void;
  editable?: boolean;
  newAnnotationIds?: Set<string>;
  hoveredAnnotationId?: string | null;
  scrollToAnnotationId?: string | null;
  sourceView?: boolean; // If true, show line numbers and raw source
}
```

### How Annotations Work

```typescript
// Annotations are applied as decorations at source positions
function buildAnnotationDecorations(
  segments: TextSegment[],
  newAnnotationIds?: Set<string>
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();

  for (const segment of annotatedSegments) {
    const decoration = Decoration.mark({
      class: annotationStyles.getAnnotationStyle(segment.annotation),
      attributes: {
        'data-annotation-id': segment.annotation.id,
        'title': 'Right-click for options'
      }
    });

    // Direct source position usage - no transformation needed!
    builder.add(segment.start, segment.end, decoration);
  }

  return builder.finish();
}

// Update decorations without recreating view
view.dispatch({
  effects: updateAnnotationsEffect.of({ segments, newAnnotationIds })
});
```

### Hover Detection

The component uses `mousemove` event (not `mouseenter`/`mouseleave`) to detect annotation hovers:

```typescript
EditorView.domEventHandlers({
  mousemove: (event, view) => {
    if (!onAnnotationHover) return false;

    const target = event.target as HTMLElement;
    const annotationElement = target.closest('[data-annotation-id]');
    const annotationId = annotationElement?.getAttribute('data-annotation-id');

    // Track last hovered to avoid redundant calls
    const lastHovered = (view.dom as any).__lastHoveredAnnotation;
    if (annotationId !== lastHovered) {
      (view.dom as any).__lastHoveredAnnotation = annotationId || null;
      onAnnotationHover(annotationId || null);
    }

    return false;
  }
})
```

**Why mousemove instead of mouseenter/mouseleave?**
- CodeMirror's managed DOM structure makes mouseenter/mouseleave unreliable
- mousemove fires on the actual annotation elements, not the container
- Tracking previous hover prevents redundant callback invocations

### Scroll and Pulse Effects

When `hoveredAnnotationId` changes, the component scrolls to the annotation and applies a pulse animation:

```typescript
useEffect(() => {
  if (!viewRef.current || !hoveredAnnotationId) return undefined;

  const segment = segments.find(s => s.annotation?.id === hoveredAnnotationId);
  if (!segment) return undefined;

  const view = viewRef.current;

  // Scroll first
  view.dispatch({
    effects: EditorView.scrollIntoView(segment.start, {
      y: 'nearest',
      yMargin: 50
    })
  });

  // Add pulse effect after delay to ensure element is visible
  const timeoutId = setTimeout(() => {
    const element = view.contentDOM.querySelector(
      `[data-annotation-id="${hoveredAnnotationId}"]`
    ) as HTMLElement;

    if (element) {
      element.classList.add('annotation-pulse');
    }
  }, 100);

  return () => {
    clearTimeout(timeoutId);
    const element = view.contentDOM.querySelector(
      `[data-annotation-id="${hoveredAnnotationId}"]`
    ) as HTMLElement;
    if (element) {
      element.classList.remove('annotation-pulse');
    }
  };
}, [hoveredAnnotationId, segments]);
```

### Component Lifecycle

```typescript
// 1. Initialize view once
useEffect(() => {
  const view = new EditorView({ state, parent: container });
  viewRef.current = view;
  return () => view.destroy();
}, []); // Empty deps - only run once

// 2. Update content via transaction
useEffect(() => {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: newContent }
  });
}, [content]);

// 3. Update annotations via effect
useEffect(() => {
  view.dispatch({
    effects: updateAnnotationsEffect.of({ segments, newAnnotationIds })
  });
}, [segments, newAnnotationIds]);
```

### Current Display Modes

**Default Mode** (sourceView=false):
- Raw markdown syntax with syntax highlighting (e.g., `# Title`, `**bold**`, `- list item`)
- Accurate annotations at exact source positions
- Custom preview extension available for enhanced formatting

**Source View Mode** (sourceView=true):
- Line numbers displayed on the left
- Raw markdown source
- Useful for technical editing and debugging
- Enabled via `sourceView` prop

**Implementation**:
```typescript
const extensions = [
  markdown(),
  lineNumbers(),
  EditorView.editable.of(editable),
  // ... other extensions
];
```

### Features

#### Decoration-Based Formatting
- Hide markdown syntax characters (`#`, `*`, `-`, etc.)
- Apply CSS styling (larger headers, bold/italic text)
- Maintain source positions

#### Widget Replacement
- Replace syntax with visual elements (bullets for lists)
- Create actual HTML elements for complex structures
- Still preserve position mapping

### Implementation Example

```typescript
// Hide # characters and style header text
case 'ATXHeading1': {
  const hashEnd = text.indexOf(' ') + 1;
  
  // Hide the # and space
  builder.add(from, from + hashEnd, hideDecoration);
  
  // Apply header styling to the text
  builder.add(from + hashEnd, to, headerDecoration(1));
  break;
}
```

## Integration with Production Components

### AnnotateView

**Location**: `/src/components/document/AnnotateView.tsx`

Uses CodeMirrorRenderer for curation mode with:
- Text selection handling for creating annotations
- Position calculation using CodeMirror's `posAtDOM()` API
- Sparkle UI for annotation creation
- Hover state management for bi-directional focusing

**Position Calculation**:
```typescript
const cmContainer = container.querySelector('.codemirror-renderer');
const view = (cmContainer as any)?.__cmView;
const start = view.posAtDOM(range.startContainer, range.startOffset);
const end = start + text.length;
```

**Why this approach?**
- CodeMirror's `posAtDOM()` accurately converts DOM positions to source positions
- No manual text measurement or newline collapsing issues
- Works correctly with CodeMirror's managed DOM structure

### BrowseView

**Location**: `/src/components/document/BrowseView.tsx`

**Note**: BrowseView does **NOT** use CodeMirrorRenderer. It uses ReactMarkdown instead for a clean, prose-style reading experience. See [REACT-MARKDOWN.md](./REACT-MARKDOWN.md) for details.

## Comparison with Previous Approaches

### AnnotationRenderer (Deleted)

**What it was** (403 lines, removed):
- Orchestrator component managing rendering
- Handled segmentation and routing to renderers
- Added complexity to component hierarchy

**Why removed**:
- AnnotateView and BrowseView can use CodeMirrorRenderer directly
- Simplified component hierarchy
- Better performance without extra layer
- Cleaner separation of concerns

### ReactMarkdown Approach (Now Used in BrowseView)

**What it does**:
- Converts markdown to HTML for clean reading
- Applies annotations via custom rehype plugin
- Used in BrowseView for prose-style display

**Note**: See [REACT-MARKDOWN.md](./REACT-MARKDOWN.md) for details on BrowseView's ReactMarkdown implementation.

### CodeMirror Approach (Current - AnnotateView)

**What it does**:
- Shows source markdown with highlighting
- Applies decorations at source positions via incremental StateField updates
- No position mapping needed
- Stores EditorView on container for position calculation access

**Benefits**:
- 100% accurate annotations
- No delays or DOM hacks
- ~10x performance improvement with incremental updates
- Clean, maintainable code
- Performant with large documents
- Bi-directional Document ↔ History focusing

## Future Improvements

### Short Term
1. Improve CSS styling for markdown syntax highlighting
2. Performance optimization for very large documents
3. Better keyboard shortcuts for annotation workflows

### Medium Term
1. Improve widget interactions (better tooltips, previews)
2. Add support for more annotation types
3. Enhanced bi-directional focusing between Document and History

### Long Term
1. Collaborative editing support with real-time annotations
2. Advanced annotation features (threading, replies)
3. Real-time position synchronization across users

## Configuration

### Current Extensions
```typescript
const state = EditorState.create({
  doc: content,
  extensions: [
    markdown(),           // Parse markdown syntax
    lineNumbers(),        // Line numbers (conditional)
    EditorView.editable.of(editable),  // Editable mode
    EditorView.lineWrapping,  // Line wrapping
    annotationDecorationsField,  // Annotation decorations
    enableWidgets ? widgetDecorationsField : [],  // Widgets
    // Event handlers...
  ]
});
```

## Testing

### Position Accuracy Tests
Located in `/src/components/__tests__/AnnotationRenderer.test.tsx`

Tests verify:
- Annotations appear at correct positions
- Text content is preserved exactly
- Position mapping is accurate
- Overlapping annotations are handled correctly

### Property-Based Testing
Uses fast-check to verify axioms:
- Position preservation
- Content integrity
- Non-overlapping handling
- Incremental stability

## Trade-offs

### Current Trade-offs
- **Visual Polish**: Shows raw markdown syntax
- **User Experience**: Not ideal for reading
- **Position Accuracy**: Perfect annotation placement
- **Reliability**: No complex mapping logic

### Why We Accept These Trade-offs
1. Accuracy is critical for annotations
2. Position mapping complexity was unsustainable
3. Future improvements can address visual issues
4. Foundation must be solid before adding complexity

## Migration Path

### From ReactMarkdown to CodeMirror
1. ✅ Replace MarkdownWithAnnotations with CodeMirrorRenderer
2. ✅ Update AnnotationRenderer to use CodeMirror for markdown
3. ✅ Remove ReactMarkdown dependencies
4. ✅ Test annotation accuracy

### To Improved Formatting
1. ⏳ Activate custom preview extension
2. ⏳ Test position mapping with decorations
3. ⏳ Add user toggle for source/preview modes
4. ⏳ Optimize performance for large documents

## Conclusion

CodeMirror provides a solid foundation for our annotation system by eliminating the position mapping problem entirely. While the current display isn't ideal for reading, it ensures 100% accurate annotation placement. The custom preview extension provides a clear path to better formatting without sacrificing accuracy.

The key insight: **It's better to have accurate annotations with less polish than beautiful rendering with broken annotations.**

## Related Documentation

- [W3C-WEB-ANNOTATION.md](../../../specs/docs/W3C-WEB-ANNOTATION.md) - Complete W3C implementation across all layers
- [ANNOTATIONS.md](./ANNOTATIONS.md) - Frontend UI patterns and components
- [ANNOTATION-RENDERING-PRINCIPLES.md](./ANNOTATION-RENDERING-PRINCIPLES.md) - Rendering axioms and correctness properties
- [RENDERING-ARCHITECTURE.md](./RENDERING-ARCHITECTURE.md) - Document rendering pipeline