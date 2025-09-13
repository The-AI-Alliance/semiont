# Selections System

## Overview

The selections system allows users to create, view, and manage text selections within documents. There are two types of selections:

1. **Highlights** - Simple text selections for marking important content
2. **References** - Selections that can link to other documents or entities

## Axioms for Annotation Rendering

The annotation rendering system is built on the following fundamental axioms, verified through property-based testing:

### 1. POSITION PRESERVATION
Annotations must preserve the exact character positions from the source text, regardless of rendering transformations. This means:
- Character offsets are always relative to the original source text
- Markdown transformations don't affect position calculations
- Positions remain stable across re-renders

### 2. NON-OVERLAPPING
Multiple annotations can exist but the renderer must handle overlapping gracefully by:
- Skipping overlapping annotations (first-come-first-served)
- Maintaining clear visual boundaries
- Preventing annotation collision in the DOM

### 3. CONTENT INTEGRITY
The rendered text content must match the source content exactly:
- Annotations only add styling, never modify text
- All characters from source must appear in rendered output
- Text reconstruction from segments must equal original text

### 4. SELECTION INDEPENDENCE
User text selection must work independently of annotations:
- Browser selection behavior is preserved
- Selecting text doesn't interfere with annotation rendering
- Copy/paste operations work on the underlying text

### 5. MARKDOWN TRANSPARENCY
Markdown rendering must be transparent to position tracking:
- Positions refer to source text, not rendered HTML
- Markdown syntax characters are included in position counts
- Annotations work across markdown boundaries

### 6. INCREMENTAL STABILITY
Adding/removing one annotation should not affect the rendering of other non-overlapping annotations:
- Each annotation is independent
- Changes are localized to affected regions
- No cascade effects on unrelated annotations

### 7. INTERACTION ISOLATION
Click/hover on annotations should not trigger on the wrong annotation or affect other annotations:
- Event handlers are properly scoped
- Click targets are precise
- No event bubbling issues

### 8. REACTIVITY
When annotations are added or removed, the rendering must update to reflect the current state immediately:
- Deletions are reflected in real-time
- Additions appear without refresh
- State changes trigger proper re-renders
- Old annotations are cleaned up before applying new ones

### 9. MARKDOWN FIDELITY
Markdown elements must render as their semantic HTML equivalents with proper styling:
- Headers render as h1, h2, h3 with appropriate sizes
- Lists render as ul/ol with proper structure
- Code blocks have syntax highlighting
- All markdown features are preserved

## User Interaction Flow

### Creating a Selection

1. **Select Text**: Click and drag to select text in the document
2. **Visual Feedback**: A sparkle (✨) appears next to the selection with a dashed outline
3. **Create Annotation**: 
   - Click the sparkle, OR
   - Right-click the selection
4. **Choose Type**: Select whether to create a highlight or reference
5. **Save**: The selection is saved and persists across page loads

### Managing Selections

- **View**: Selections are visually indicated with colored backgrounds:
  - Yellow for highlights
  - Purple for entity references  
  - Blue gradient for document references
- **Navigate**: Click on a reference to navigate to the linked document
- **Delete**: Right-click on a selection and choose "Delete" from the context menu

## Technical Implementation

### Component Architecture

```typescript
AnnotationRenderer
├── segmentTextWithAnnotations() // Pure function for text segmentation
├── SegmentRenderer             // Renders individual text segments  
├── MarkdownWithAnnotations     // Handles markdown rendering with annotations
│   └── ReactMarkdown          // Converts markdown to HTML
└── SelectionOverlay            // Manages text selection UI
```

### Data Flow

1. **Input**: Raw text content + array of selections
2. **Processing**: Text is segmented based on annotation positions
3. **Rendering**: 
   - For markdown: CodeMirror renders with decorations at source positions
   - For plain text: Segments rendered directly with appropriate styling
4. **Interaction**: Event handlers attached for clicks and selection

### CodeMirror Integration

As of the latest implementation, we use CodeMirror for markdown rendering to solve the position mapping challenge:

#### Why CodeMirror?

1. **Automatic Position Mapping**: CodeMirror handles the complex mapping between source markdown positions and rendered display positions
2. **Native Markdown Support**: Built-in markdown mode understands markdown syntax
3. **Decoration System**: Efficiently applies highlights without modifying the source text
4. **Performance**: Optimized for large documents with virtual scrolling capabilities

#### How It Works

```typescript
// CodeMirrorRenderer.tsx
const builder = new RangeSetBuilder<Decoration>();

for (const segment of annotatedSegments) {
  const decoration = Decoration.mark({
    class: annotationStyles.getAnnotationStyle(segment.annotation),
    attributes: {
      'data-annotation-id': segment.annotation.id,
      // ... other attributes
    }
  });
  
  // Add decoration at SOURCE positions - CodeMirror handles the mapping!
  builder.add(segment.start, segment.end, decoration);
}
```

Key points:
- Decorations are applied using **source text positions**
- CodeMirror automatically handles the transformation when rendering markdown
- Click and context menu handlers are attached via CodeMirror's event system
- The editor is configured as read-only for viewing documents

#### Position Mapping Example

For markdown content like:
```markdown
- dog
- cat
- horse
```

- **Source positions**: Characters 0-17 including markdown syntax
- **Rendered display**: List items without the `- ` prefixes
- **Annotation at source position 2-5**: Correctly highlights "dog" in the rendered list

This solves the fundamental challenge of markdown position tracking that was identified in AXIOM 5.

### Testing Strategy

The system uses property-based testing with fast-check to verify axioms:

```typescript
// Example: Position Preservation Test
fc.property(
  textGenerator,
  annotationsGenerator,
  (text, annotations) => {
    const segments = applyAnnotationsToText(text, annotations);
    const reconstructed = segments.map(s => s.text).join('');
    expect(reconstructed).toBe(text);
  }
)
```

## API Endpoints

- `GET /api/documents/:id/highlights` - Get all highlights for a document
- `GET /api/documents/:id/references` - Get all references for a document
- `POST /api/selections` - Create a new selection
- `DELETE /api/selections/:id` - Delete a selection
- `PATCH /api/selections/:id` - Update a selection

## Configuration

The selection system can be configured through environment variables:

- `SELECTION_MAX_LENGTH` - Maximum characters in a selection (default: 5000)
- `SELECTION_COLORS` - Custom colors for different selection types

## Known Limitations

1. Annotations don't persist through document edits (positions become invalid)
2. Overlapping annotations are skipped rather than layered
3. ~~Position tracking in complex markdown~~ - **SOLVED with CodeMirror integration**

## Future Enhancements

- [ ] Support for overlapping annotations with layering
- [ ] Collaborative selections (see other users' highlights)
- [ ] Smart position adjustment when document is edited
- [ ] Selection categories and tagging
- [ ] Export selections to various formats