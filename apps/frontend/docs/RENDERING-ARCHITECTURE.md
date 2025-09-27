# Rendering Architecture

## Overview

The Semiont frontend uses a sophisticated rendering pipeline to display documents with annotations (highlights and references). This document explains the architecture and the role of each component.

## Component Hierarchy

```
Document Page (/know/document/[id]/page.tsx)
├── Main Content Area
│   └── AnnotationRenderer
│       ├── CodeMirrorRenderer (for markdown content)
│       │   └── CodeMirror with markdown mode
│       └── Plain Text Renderer (for non-markdown content)
└── Right Sidebar
    ├── Progress Display Area (top)
    │   ├── GenerationProgressWidget
    │   └── DetectionProgressWidget
    └── Document Information (below progress)
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

### CodeMirrorRenderer (Primary Renderer)

**Location**: `/src/components/CodeMirrorRenderer.tsx`

**Role**: Renders markdown content with annotations using CodeMirror editor in read-only mode.

**Why CodeMirror**:
- **Perfect position mapping**: Source positions ARE display positions
- **No transformation needed**: Annotations work directly with source text
- **Built-in decoration system**: Efficiently highlights text without DOM manipulation
- **Reliable and performant**: Handles large documents well

**How it works**:
1. Creates a CodeMirror instance with markdown syntax highlighting
2. Applies decoration marks at source positions for annotations
3. Handles click and right-click events on annotations
4. Configured as read-only for viewing

**Current Display**:
- Shows markdown syntax with highlighting (e.g., `# Title`, `**bold**`)
- Not ideal for reading but ensures accurate annotation positioning
- Custom extension available for preview-like formatting

### Custom Markdown Preview Extension

**Location**: `/src/lib/codemirror-markdown-preview.ts`

**Role**: Custom CodeMirror 6 extension to format markdown for reading while maintaining positions.

**Features**:
- Hides markdown syntax characters using decorations
- Applies CSS styling (larger headers, bold/italic text)
- Can replace elements with widgets (e.g., bullets for lists)
- Maintains perfect position mapping

**Implementation Approaches**:
1. **Decoration-based**: Hide syntax, apply CSS classes
2. **Widget-based**: Replace ranges with custom HTML elements
3. **Hybrid**: Combine both for optimal results

## Progress Display System

The document page features a progress display area at the top of the right sidebar for showing real-time progress of long-running operations.

### Architecture

**Location**: Top of right sidebar in `/app/know/document/[id]/page.tsx`

**Components**:
- `GenerationProgressWidget`: Shows document generation progress
- `DetectionProgressWidget`: Shows entity detection progress

### How It Works

1. **Initiation**: User triggers an operation (e.g., "Generate Document" from AnnotationPopup)
2. **SSE Connection**: Hook establishes Server-Sent Events connection to backend
3. **Progress Updates**: Backend sends real-time updates via SSE
4. **Widget Display**: Progress widget appears in right sidebar
5. **Completion**: Widget shows success/error and auto-dismisses (or allows manual dismiss)

### GenerationProgressWidget

**Location**: `/src/components/GenerationProgressWidget.tsx`
**Hook**: `/src/hooks/useGenerationProgress.ts`

**Features**:
- Real-time progress bar with percentage
- Status messages for each generation phase
- Sparkle animation during generation
- Auto-dismiss after 5 seconds on success
- Manual dismiss button for errors
- Link to view generated document

**SSE Events**:
```typescript
{
  status: 'started' | 'fetching' | 'generating' | 'creating' | 'complete' | 'error',
  referenceId: string,
  documentName?: string,
  documentId?: string,  // Available when complete
  percentage: number,
  message?: string
}
```

### DetectionProgressWidget

**Location**: `/src/components/DetectionProgressWidget.tsx`
**Hook**: `/src/hooks/useDetectionProgress.ts`

**Features**:
- Shows entity type being detected
- Real-time counter of detections found
- Progress indication
- Error handling

### Design Decisions

**Why Right Sidebar Top?**
- Prominent but non-blocking location
- Doesn't interfere with document reading/editing
- Consistent location for all progress indicators
- Easy to dismiss or ignore

**Why SSE Instead of WebSockets?**
- Simpler unidirectional flow (server → client)
- Built-in reconnection
- Lower overhead for progress updates
- No need for bidirectional communication

**Auto-dismiss Behavior**:
- Success: Auto-dismiss after 5 seconds (user can see completion)
- Error: Requires manual dismiss (user must acknowledge error)
- In-progress: No auto-dismiss (shows until operation completes)

### Integration with AnnotationPopup

When user clicks "Generate Document" in AnnotationPopup:
1. Popup calls `onGenerateDocument` callback
2. Document page starts SSE connection via `useGenerationProgress`
3. Progress widget appears in sidebar
4. Popup closes immediately (no waiting)
5. User can continue working while generation happens

### Styling

Progress widgets use:
- Blue color scheme (matching reference annotations)
- Subtle animations (sparkle for generation)
- Border highlights for visibility
- Responsive design for different viewport sizes

### MarkdownWithAnnotations (Deprecated)

**Status**: Previously used but removed due to position mapping complexity

**Why it was removed**:
- Position mapping between source markdown and rendered HTML was unreliable
- Required hacky DOM walking after ReactMarkdown rendered
- 100ms delay needed for rendering
- Complex and error-prone

**What it did**:
1. Used ReactMarkdown to convert markdown to HTML
2. Walked DOM tree to rebuild position map
3. Applied annotations by wrapping text in spans
4. Handled the source→rendered position transformation

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

CodeMirrorRenderer avoids the problem entirely by:
1. Displaying the source markdown text directly
2. Using CodeMirror's decoration system for annotations
3. Applying decorations at source positions (no mapping needed)
4. Showing syntax highlighting instead of rendered HTML

This approach trades visual polish for accuracy and reliability.

### Previous Solutions Attempted

1. **ReactMarkdown with DOM walking**: Too complex, unreliable position mapping
2. **MarkdownWithAnnotations**: Required hacky delays and DOM manipulation
3. **Server-side position mapping**: Would add complexity to the backend

### Future Improvements

The custom markdown preview extension (`codemirror-markdown-preview.ts`) provides a path to better visual formatting while maintaining position accuracy by using CodeMirror's decoration system to hide syntax and style content.

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
   → CodeMirrorRenderer
   → CodeMirror with markdown mode
   → Decorations applied at source positions
   → Final rendered output (syntax-highlighted markdown)
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