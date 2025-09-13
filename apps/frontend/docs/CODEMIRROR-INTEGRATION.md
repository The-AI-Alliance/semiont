# CodeMirror Integration

## Overview

The Semiont frontend uses CodeMirror 6 as its primary text renderer for markdown documents. This document explains why we chose CodeMirror, how it's integrated, and future improvements.

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
1. Read-only markdown editor
2. Syntax highlighting for markdown
3. Decoration system for annotations
4. Event handlers for annotation interactions

### How Annotations Work

```typescript
// Annotations are applied as decorations at source positions
const builder = new RangeSetBuilder<Decoration>();

for (const segment of annotatedSegments) {
  const decoration = Decoration.mark({
    class: annotationStyles.getAnnotationStyle(segment.annotation),
    attributes: {
      'data-annotation-id': segment.annotation.id
    }
  });
  
  // Direct source position usage - no transformation needed!
  builder.add(segment.start, segment.end, decoration);
}
```

### Current Display Mode

Users currently see:
- Raw markdown syntax (e.g., `# Title`, `**bold**`, `- list item`)
- Syntax highlighting (different colors for different markdown elements)
- Accurate annotations at exact source positions

## Custom Markdown Preview Extension

### Location
`/src/lib/codemirror-markdown-preview.ts`

### Purpose
Transform markdown display for better readability while maintaining position accuracy.

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

## Comparison with Previous Approaches

### ReactMarkdown Approach (Removed)

**What it did**:
- Converted markdown to HTML
- Walked DOM to apply annotations
- Required complex position mapping

**Problems**:
- Position mapping was unreliable
- Required 100ms delays
- DOM manipulation was fragile
- Overlapping annotations were difficult

### CodeMirror Approach (Current)

**What it does**:
- Shows source markdown with highlighting
- Applies decorations at source positions
- No position mapping needed

**Benefits**:
- 100% accurate annotations
- No delays or DOM hacks
- Clean, maintainable code
- Performant with large documents

## Future Improvements

### Short Term
1. Activate the custom preview extension for better formatting
2. Add toggle between source and preview modes
3. Improve CSS styling for markdown elements

### Medium Term
1. Implement proper widget replacements for complex elements
2. Add support for tables and other GFM features
3. Create position mapping for true WYSIWYG editing

### Long Term
1. Full WYSIWYG markdown editing
2. Collaborative editing support
3. Real-time position synchronization

## Configuration

### Current Extensions
```typescript
const state = EditorState.create({
  doc: content,
  extensions: [
    markdown(),           // Parse markdown syntax
    markdownPreview(),    // Custom preview extension (optional)
    oneDark,             // Dark theme (conditional)
    EditorView.editable.of(false),  // Read-only mode
    EditorView.decorations.of(decorations),  // Annotations
    // Event handlers...
  ]
});
```

### CSS Styling
Styles are defined in `/src/app/globals.css`:
- `.md-header-*` - Header formatting
- `.md-bold`, `.md-italic` - Text emphasis
- `.md-code` - Code styling
- `.md-link` - Link appearance
- `.md-list-*` - List formatting

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