# Selections System

## Overview

The selections system allows users to create, view, and manage text selections within documents. There are two primary types of selections:

1. **Highlights** - Simple text selections for marking important content
2. **References** - Selections that link to other documents or entities

### Types of Selections

#### Highlights (Yellow)
- Simple text selections for marking important content
- Rendered with a yellow background
- No linking functionality
- Created without any `resolvedDocumentId` field in the database

#### References
References can have different visual styles based on their properties:

##### Entity References (Purple)
- References that have entity types (e.g., "Person", "Concept", "Titan")
- Rendered with a purple background
- Can be either:
  - **Stub references**: `resolvedDocumentId: null` - clicking opens modal to create document
  - **Resolved references**: `resolvedDocumentId: "doc_id"` - clicking navigates to document
- The purple color indicates the presence of entity type metadata

##### Document References (Blue Gradient)
- References without entity types
- Rendered with a blue gradient background
- Can be either:
  - **Stub references**: `resolvedDocumentId: null` - clicking opens modal to create document
  - **Resolved references**: `resolvedDocumentId: "doc_id"` - clicking navigates to document
- The blue color indicates a plain document reference without entity metadata

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
4. **Choose Type**: 
   - **Highlight**: Creates a simple yellow highlight
   - **Reference**: Opens options to:
     - Create a stub reference (no target document)
     - Link to an existing document
     - Specify entity types and reference types
5. **Save**: The selection is saved and persists across page loads

### Managing Selections

- **View**: Selections are visually indicated with colored backgrounds:
  - Yellow for highlights
  - Purple for references with entity types
  - Blue gradient for references without entity types
- **Navigate**: 
  - **Resolved references**: Click to navigate directly to the linked document
  - **Stub references**: Click to open a modal offering to create the document
- **Edit**: Right-click on a selection to:
  - Convert between highlight and reference
  - Update reference target
  - Delete the selection
- **Delete**: Right-click and choose "Delete" from the context menu

### Stub Reference Modal

When clicking on a stub reference (purple), a modal appears with:
- The selected text as the proposed document name
- Entity types associated with the reference
- Reference type (e.g., "mentions", "defines")
- Options to:
  - **Create Document**: Navigate to the compose view to create the document
  - **Stay Here**: Close the modal and remain on the current page

## Technical Implementation

### Database Structure

The critical distinction between selection types is based on the `resolvedDocumentId` field:

```typescript
// Highlight - no resolvedDocumentId field
{
  id: "sel_abc123",
  documentId: "doc_xyz",
  selectionType: "text_span",
  selectionData: { offset: 10, length: 5, text: "hello" }
  // NO resolvedDocumentId field
}

// Stub Reference - resolvedDocumentId is null
{
  id: "sel_def456", 
  documentId: "doc_xyz",
  selectionType: "text_span",
  selectionData: { offset: 20, length: 7, text: "Ouranos" },
  resolvedDocumentId: null,  // Explicitly null
  entityTypes: ["Titan"],
  referenceTags: ["mentions"]
}

// Resolved Reference - resolvedDocumentId has a value
{
  id: "sel_ghi789",
  documentId: "doc_xyz", 
  selectionType: "text_span",
  selectionData: { offset: 30, length: 10, text: "Prometheus" },
  resolvedDocumentId: "doc_target123",  // Points to actual document
  entityTypes: ["Titan"],
  referenceTags: ["mentions"]
}
```

**Important**: The distinction is based on field presence, not just value:
- Highlights: Field not present (`!('resolvedDocumentId' in selection)`)
- References: Field present (`'resolvedDocumentId' in selection`)
  - Stub: Value is `null`
  - Resolved: Value is a document ID string

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

1. **Perfect Position Mapping**: Source positions match display positions exactly
2. **Native Markdown Support**: Built-in markdown mode with syntax highlighting
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
  
  // Add decoration at SOURCE positions
  builder.add(segment.start, segment.end, decoration);
}
```

Key points:
- Decorations are applied using **source text positions**
- CodeMirror displays markdown with syntax highlighting (shows raw markdown)
- Click and context menu handlers are attached via CodeMirror's event system
- The editor is configured as read-only for viewing documents

#### Custom Markdown Preview Extension

We've created a custom CodeMirror extension (`codemirror-markdown-preview.ts`) that can:
- Hide markdown syntax characters using decorations
- Apply CSS styling to make headers larger, text bold/italic, etc.
- Replace certain elements with widgets (e.g., bullets for lists)
- Maintain perfect position mapping for annotations

#### Current Display Mode

The system currently shows markdown syntax with highlighting. While not ideal for reading, this approach:
- Guarantees accurate annotation positioning
- Avoids the complex position mapping issues of HTML rendering
- Provides a stable foundation for the annotation system

#### Position Mapping Example

For markdown content like:
```markdown
# Title
- dog
- cat
```

- **Source positions**: Characters include all markdown syntax (`#`, `-`, spaces)
- **Display**: Shows the exact source text with syntax highlighting
- **Annotation at position 8-11**: Highlights "dog" including the exact characters at those positions

This approach completely avoids the position mapping problem by not transforming the text at all.

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

### Selection Management
- `POST /api/selections` - Create a new selection (highlight or reference)
  - Body includes `resolvedDocumentId` field to distinguish type:
    - Omit field for highlights
    - `null` for stub references
    - Document ID string for resolved references
- `GET /api/selections/:id` - Get a specific selection
- `PATCH /api/selections/:id` - Update a selection
- `DELETE /api/selections/:id` - Delete a selection

### Document Selections
- `GET /api/documents/:id/highlights` - Get all highlights for a document
- `GET /api/documents/:id/references` - Get all references for a document  
- `GET /api/documents/:id/referenced-by` - Get incoming references from other documents
  - Returns selections from other documents that reference this document
  - Includes source document names for display

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