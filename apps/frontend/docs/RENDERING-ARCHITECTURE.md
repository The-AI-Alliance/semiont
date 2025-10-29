# Rendering Architecture

> **⚠️ Note:** Code examples in this document use the old `apiService.*` pattern. The current architecture uses React Query hooks (`api.*`). See [ARCHITECTURE.md](./ARCHITECTURE.md) and [AUTHENTICATION.md](./AUTHENTICATION.md) for current patterns.

## Overview

The Semiont frontend uses **two different rendering pipelines** to display documents with annotations (highlights and references), depending on the mode:

- **AnnotateView** (curation mode): CodeMirror-based editor with decorations and widgets
- **BrowseView** (browse mode): ReactMarkdown-based prose renderer

This document explains the architecture and the role of each component.

## Dual Rendering Architecture

We maintain **two separate rendering systems** with different purposes:

### AnnotateView (CodeMirror)
- **Use case**: Curation mode - creating/editing annotations
- **Renderer**: CodeMirror 6 editor
- **Styling**: Monospace font, gradient backgrounds, editor-like appearance
- **Features**: Inline widgets (🔗, ❓, ✨), hover effects, right-click menus
- **See**: [CODEMIRROR-INTEGRATION.md](./CODEMIRROR-INTEGRATION.md)

### BrowseView (ReactMarkdown)
- **Use case**: Browse mode - read-only document viewing
- **Renderer**: react-markdown with remark/rehype plugins
- **Styling**: Variable-width font, text colors, document-like appearance
- **Features**: Simple click-to-navigate, clean reading experience
- **See**: [REACT-MARKDOWN.md](./REACT-MARKDOWN.md)

## Component Hierarchy

```
Document Page (/know/document/[id]/page.tsx)
├── Main Content Area
│   ├── AnnotateView (curation mode)
│   │   └── CodeMirrorRenderer
│   │       └── CodeMirror 6 with markdown mode + decorations + widgets
│   └── BrowseView (browse mode)
│       └── ReactMarkdown
│           └── remark-gfm → remarkAnnotations → rehypeRenderAnnotations
├── Right Panel (conditionally visible)
│   ├── Progress Display Area (top)
│   │   ├── GenerationProgressWidget
│   │   └── DetectionProgressWidget
│   ├── History Panel (append-only event log)
│   │   └── AnnotationHistory component
│   ├── Stats Panel (document metadata)
│   │   ├── Document statistics
│   │   └── Referenced By section
│   └── Detect Panel (reference detection UI)
└── Toolbar (far right, vertically aligned icons)
    ├── Detect References button (🔵)
    ├── History button (📒)
    └── Statistics button (ℹ️)
```

## Key Components

### AnnotateView

**Location**: `/src/components/resource/AnnotateView.tsx`

**Role**: Production component for curation mode, handling document editing and annotation creation.

**Responsibilities**:
- Renders document content via CodeMirrorRenderer
- Manages text selection state for creating new annotations
- Provides selection UI (sparkle button) for creating highlights/references
- Handles manual annotation position calculation using CodeMirror's `posAtDOM()` API
- Manages hover state for Document ↔ History synchronization

**Key Features**:
- Uses CodeMirrorRenderer for efficient incremental updates
- Accurate position calculation via CodeMirror's DOM API (not manual text measurement)
- Sparkle animation for newly created annotations
- Bi-directional focusing with History panel (hover to pulse and scroll)

### BrowseView

**Location**: `/src/components/resource/BrowseView.tsx`

**Role**: Production component for browse mode (read-only document viewing).

**Renderer**: ReactMarkdown with remark/rehype plugins (NOT CodeMirror)

**Responsibilities**:
- Renders markdown content with prose styling (variable-width font)
- Displays annotations as colored text:
  - Highlights: Yellow background
  - Resolved references: Blue text
  - Stub references: Red text
- Handles annotation clicks for navigation
- Provides clean, document-like reading experience

**See**: [REACT-MARKDOWN.md](./REACT-MARKDOWN.md) for detailed implementation

### CodeMirrorRenderer (AnnotateView Renderer)

**Location**: `/src/components/CodeMirrorRenderer.tsx`

**Role**: Core rendering component for **AnnotateView only** that displays markdown content with annotations using CodeMirror 6.

**Note**: BrowseView does NOT use this component - it uses ReactMarkdown instead.

**Why CodeMirror**:
- **Perfect position mapping**: Source positions ARE display positions
- **No transformation needed**: Annotations work directly with source text
- **Incremental decoration updates**: StateField system updates decorations without recreating view
- **Built-in decoration system**: Efficiently highlights text without DOM manipulation
- **Reliable and performant**: Handles large documents well (~10x faster than previous approach)

**Props**:
- `content: string` - Document source text
- `segments: TextSegment[]` - Pre-computed annotation segments
- `onAnnotationClick?: (annotation) => void` - Left-click handler
- `onAnnotationRightClick?: (annotation, x, y) => void` - Right-click handler
- `onAnnotationHover?: (annotationId | null) => void` - Hover handler for bi-directional focusing
- `onTextSelect?: (text, position) => void` - Text selection handler
- `hoveredAnnotationId?: string | null` - Annotation to pulse and scroll to
- `scrollToAnnotationId?: string | null` - Annotation to scroll to without pulse
- `newAnnotationIds?: Set<string>` - Recently created annotations for sparkle animation
- `sourceView?: boolean` - If true, shows line numbers and raw source
- `editable?: boolean` - If true, allows editing (default: false)

**How it works**:
1. Creates a CodeMirror instance once on mount (persists for component lifetime)
2. Uses StateField + Effects for incremental decoration updates (no view recreation)
3. Applies decoration marks at source positions for annotations
4. Handles click, right-click, and mousemove events on annotations
5. Scrolls and pulses annotations on hover from History panel

**Display Modes**:
- **Default**: Markdown syntax with highlighting (e.g., `# Title`, `**bold**`)
- **Source View**: Raw source with line numbers (enabled via `sourceView` prop)

**Incremental Updates**:
- View created once, decorations updated via transactions
- ~10x performance improvement vs recreation approach
- No flicker or scroll position loss
- Lower memory usage

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

### AnnotationHistory

**Location**: `/src/components/resource/AnnotationHistory.tsx`

**Role**: Displays append-only event log for document changes (highlights, references, metadata updates).

**Responsibilities**:
- Shows chronological event stream from SSE
- Scrolls to and pulses events when annotations are hovered in document
- Provides hover handlers to trigger document pulsing and scrolling
- Groups events by type with visual indicators (emojis)

**Key Features**:
- Bi-directional focusing with document (History ↔ Document)
- Real-time updates via SSE
- Event-specific styling and icons
- Scroll synchronization with document annotations

### Deleted Components

**AnnotationRenderer** (deleted, 403 lines):
- Previously orchestrated document rendering
- Replaced by AnnotateView and BrowseView directly using CodeMirrorRenderer
- Removed to simplify component hierarchy and improve performance

**MarkdownWithAnnotations** (deprecated and removed):
- Position mapping between source markdown and rendered HTML was unreliable
- Required hacky DOM walking after ReactMarkdown rendered
- 100ms delay needed for rendering
- Replaced by CodeMirrorRenderer's direct source rendering

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

For users who need better visual formatting during curation, future work could explore custom CodeMirror extensions to hide markdown syntax while maintaining position accuracy. Currently, users can switch to BrowseView for clean prose-style reading.

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

   **AnnotateView (Curation Mode)**:
   ```
   Document content + Annotations
   → segmentTextWithAnnotations()
   → CodeMirrorRenderer
   → CodeMirror StateField with incremental decoration updates
   → Decorations applied at source positions
   → Final rendered output (syntax-highlighted markdown with widgets)
   ```

   **BrowseView (Browse Mode)**:
   ```
   Document content + Annotations
   → ReactMarkdown
   → remark-gfm → remarkAnnotations → rehypeRenderAnnotations
   → Final rendered output (prose-style HTML with colored annotations)
   ```

4. **User Interaction - Manual Annotation Creation**:
   ```
   User selects text in AnnotateView
   → Browser Selection API
   → Calculate source positions using CodeMirror's posAtDOM() API
   → Show selection UI (sparkle)
   → User clicks to create annotation
   → Save to API
   → Invalidate queries
   → React Query refetches data
   → CodeMirrorRenderer updates decorations incrementally
   ```

5. **Bi-directional Document ↔ History Focusing**:
   ```
   History → Document:
   User hovers event in History panel
   → handleEventHover(annotationId)
   → setHoveredAnnotationId(annotationId)
   → CodeMirrorRenderer scrolls to annotation
   → Pulse animation applied

   Document → History:
   User hovers annotation in document
   → mousemove event in CodeMirrorRenderer
   → onAnnotationHover(annotationId)
   → AnnotationHistory scrolls to event
   → Background pulse on event
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
1. Property-based tests verifying axioms (see [ANNOTATION-RENDERING-PRINCIPLES.md](./ANNOTATION-RENDERING-PRINCIPLES.md))
2. Integration tests with real markdown documents
3. Visual regression tests for annotation styling
4. Performance benchmarks for large documents

## Debugging Tips

1. **Position Mismatches**: Add console logs in MarkdownWithAnnotations to see position mapping
2. **Missing Annotations**: Check if positions are in source or rendered coordinates
3. **Click Handlers**: Use React Developer Tools to inspect event handlers
4. **Performance**: Use Chrome DevTools Performance tab to profile rendering

## Related Documentation

- [W3C-WEB-ANNOTATION.md](../../../specs/docs/W3C-WEB-ANNOTATION.md) - Complete W3C implementation across all layers
- [ANNOTATIONS.md](./ANNOTATIONS.md) - Annotation UI/UX and workflows
- [CODEMIRROR-INTEGRATION.md](./CODEMIRROR-INTEGRATION.md) - AnnotateView rendering implementation
- [REACT-MARKDOWN.md](./REACT-MARKDOWN.md) - BrowseView rendering implementation
- [ANNOTATION-RENDERING-PRINCIPLES.md](./ANNOTATION-RENDERING-PRINCIPLES.md) - Rendering axioms and correctness properties
- [ARCHITECTURE.md](./ARCHITECTURE.md) - Overall frontend architecture
- [ADDING-LANGUAGE.md](./ADDING-LANGUAGE.md) - How to add new content types
- [PERFORMANCE.md](./PERFORMANCE.md) - Performance optimization strategies