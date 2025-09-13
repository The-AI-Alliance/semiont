# Rendering Architecture

## Overview

The Semiont frontend uses a sophisticated rendering pipeline to display documents with annotations (highlights and references). This document explains the architecture and the role of each component.

## Component Hierarchy

```
Document Page
└── AnnotationRenderer
    ├── MarkdownWithAnnotations (for markdown content)
    │   └── ReactMarkdown (converts markdown to HTML)
    └── Plain Text Renderer (for non-markdown content)
```

## Key Components

### AnnotationRenderer

**Location**: `/src/components/AnnotationRenderer.tsx`

**Role**: The orchestrator component that manages document rendering with annotations.

**Responsibilities**:
- Determines content type (markdown vs plain text)
- Manages text selection state for creating new annotations
- Segments text based on annotation positions
- Routes to appropriate renderer based on content type
- Provides selection UI (sparkle button) for creating annotations

**Key Features**:
- Separates selection UI from annotation rendering (clean separation of concerns)
- Uses `segmentTextWithAnnotations()` to split text into annotated and non-annotated segments
- Handles both left-click (navigation) and right-click (edit) on annotations

### MarkdownWithAnnotations

**Location**: Within `/src/components/AnnotationRenderer.tsx`

**Role**: Renders markdown as HTML and applies annotations as DOM overlays.

**How it works**:
1. Uses ReactMarkdown to convert markdown to HTML
2. Waits for HTML to render (100ms delay)
3. Walks through all text nodes in the rendered HTML
4. Maps annotation positions (which are in source markdown coordinates) to rendered text
5. Wraps annotated text portions in `<span>` elements with appropriate styling

**Key Challenge Solved**: 
Annotations are stored as character positions in the **source markdown text** (e.g., position 10-15), but need to be applied to the **rendered HTML text** where positions are different due to markdown syntax being converted to HTML tags.

**Example**:
```markdown
# Hello World
This is **bold** text.
```
- Source position 0-13: includes the `# ` 
- Rendered HTML: `<h1>Hello World</h1>` - the `# ` is gone
- MarkdownWithAnnotations handles this mapping by walking the rendered text nodes

### ReactMarkdown

**Location**: External library (`react-markdown`)

**Role**: Converts markdown text to React components/HTML elements.

**Features Used**:
- `remarkGfm`: GitHub Flavored Markdown support (tables, strikethrough, etc.)
- `remarkWikiLink`: Wiki-style links `[[Page Name]]`
- Custom component renderers for styling (headings, links, code blocks, etc.)

**Custom Renderers**:
- Headers (h1, h2, h3) with proper typography
- Links with special handling for wiki links
- Code blocks with syntax highlighting
- Lists with proper indentation

### CodeMirrorRenderer (Currently Unused)

**Location**: `/src/components/CodeMirrorRenderer.tsx`

**Role**: Alternative renderer using CodeMirror editor in read-only mode.

**Why it exists**: 
CodeMirror has built-in position mapping between source and rendered text, which could solve the position mapping challenge more elegantly.

**Why it's not used**:
- CodeMirror shows markdown with syntax highlighting, not rendered HTML
- Users expect to see formatted text (headers, bold, lists), not raw markdown
- Would show `# Title` instead of a large formatted title

**Potential Future Use**:
- Could be used for an "edit mode" where users see and edit raw markdown
- Could be adapted to render markdown while maintaining position mapping

## Position Mapping Challenge

### The Problem

Annotations store positions in source markdown:
```markdown
# Document Title
This is a paragraph with **bold** text.
```

If we highlight "bold" in the source, it's at positions 27-31.

But after rendering to HTML:
```html
<h1>Document Title</h1>
<p>This is a paragraph with <strong>bold</strong> text.</p>
```

The word "bold" is now at different positions in the rendered text because:
1. `# ` became `<h1>` tags
2. `**` became `<strong>` tags
3. Newlines became separate block elements

### Current Solution

MarkdownWithAnnotations solves this by:
1. Letting ReactMarkdown render the HTML first
2. Walking through rendered text nodes to rebuild position map
3. Finding where annotation positions map to in the rendered output
4. Applying annotations at the correct rendered positions

### Alternative Solutions Considered

1. **CodeMirror**: Has built-in position mapping but doesn't render HTML
2. **Unified/Remark AST**: Could track positions through the markdown AST transformation
3. **Server-side rendering**: Pre-calculate rendered positions on the backend

## Data Flow

1. **Document Load**:
   ```
   API → Document with content → Document Page component
   ```

2. **Selections Load**:
   ```
   API → Highlights + References → Map to Frontend format → Document Page state
   ```

3. **Rendering Pipeline**:
   ```
   Document content + Selections
   → AnnotationRenderer
   → segmentTextWithAnnotations()
   → MarkdownWithAnnotations
   → ReactMarkdown (HTML generation)
   → DOM manipulation (annotation overlay)
   → Final rendered output
   ```

4. **User Interaction**:
   ```
   User selects text
   → Browser Selection API
   → Calculate source positions
   → Show selection UI (sparkle)
   → Create annotation
   → Save to API
   → Reload selections
   → Re-render with new annotation
   ```

## API Integration

### Selection Creation

When creating a highlight:
```typescript
apiService.selections.saveAsHighlight({
  documentId,
  text: selectedText,
  position: { start: 10, end: 20 } // Source text positions
})
```

When creating a reference:
```typescript
// Step 1: Create selection
const selection = await apiService.selections.create({
  documentId,
  text: selectedText,
  position: { start: 10, end: 20 },
  type: 'reference'
});

// Step 2: Resolve to document
await apiService.selections.resolveToDocument({
  selectionId: selection.id,
  targetDocumentId: targetDoc.id,
  referenceType: 'mentions'
});
```

### Position Format

All positions in the API use the source text coordinate system:
- `start`: Character offset from beginning of source text
- `end`: Character offset of end position
- Includes all markdown syntax characters
- Zero-indexed

## Styling System

Annotations are styled using CSS classes from `/src/lib/annotation-styles.ts`:

- **Highlights**: Yellow background (`bg-yellow-200`)
- **References**: 
  - Purple for entity references
  - Blue gradient for document references
- **Hover states**: Darker shades
- **Dark mode**: Adjusted colors for dark backgrounds

## Performance Considerations

1. **DOM Walking**: MarkdownWithAnnotations walks the entire DOM tree - expensive for large documents
2. **Timeout Delay**: 100ms delay before applying annotations to ensure render completion
3. **Re-renders**: Any selection change triggers full re-render of annotations
4. **Memory**: Each annotation creates DOM event listeners

## Future Improvements

1. **Virtual Scrolling**: For documents with thousands of annotations
2. **Incremental Updates**: Only update changed annotations instead of full re-render
3. **Web Workers**: Move position calculation to background thread
4. **Caching**: Cache rendered HTML with annotations for faster navigation
5. **Unified Rendering**: Consider unified AST approach for cleaner position mapping

## Testing

The rendering system is tested through:
1. Property-based tests verifying axioms (see SELECTIONS.md)
2. Integration tests with real markdown documents
3. Visual regression tests for annotation styling
4. Performance benchmarks for large documents

## Debugging Tips

1. **Position Mismatches**: Add console logs in MarkdownWithAnnotations to see position mapping
2. **Missing Annotations**: Check if positions are in source or rendered coordinates
3. **Click Handlers**: Use React Developer Tools to inspect event handlers
4. **Performance**: Use Chrome DevTools Performance tab to profile rendering

## Related Documentation

- [SELECTIONS.md](./SELECTIONS.md) - Selection system axioms and testing
- [ADDING-LANGUAGE.md](./ADDING-LANGUAGE.md) - How to add new content types
- [PERFORMANCE.md](./PERFORMANCE.md) - Performance optimization strategies