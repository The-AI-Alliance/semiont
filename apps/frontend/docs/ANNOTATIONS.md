# Annotations & References Architecture

## Overview

The Semiont annotation system enables users to mark up documents with highlights and references, creating a rich knowledge graph. Built on the [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/), annotations are standards-compliant objects with multi-body arrays supporting entity type tags and document linking.

This document describes the frontend UI patterns, component architecture, and user workflows. For the complete W3C implementation across all layers (API, event store, projection, and graph database), see [W3C-WEB-ANNOTATION.md](../../../specs/docs/W3C-WEB-ANNOTATION.md).

## Core Principles

### 1. Progressive Enhancement
- **Basic functionality first**: Text selection and highlighting work without complex UI
- **Enhanced features on demand**: References and entity linking available through progressive disclosure
- **Graceful degradation**: System remains usable even if advanced features fail

### 2. Contextual Intelligence
- **Smart defaults**: System suggests appropriate annotation types based on context
- **Minimal cognitive load**: Users shouldn't need to think about the mechanics
- **Inline workflows**: Actions happen where the user is looking, not in distant UI

### 3. Accessibility First
- **Keyboard navigation**: All annotation features accessible without mouse
- **Screen reader support**: Proper ARIA labels and live regions
- **Visual feedback**: Clear focus indicators and state changes

### 4. Performance & Responsiveness
- **Instant feedback**: Visual confirmation of actions without waiting for server
- **Optimistic updates**: UI updates immediately, with graceful rollback on error
- **Lightweight components**: Minimal DOM manipulation and re-renders

### 5. Standards Compliance
- **W3C Web Annotation Data Model**: All annotations follow the W3C specification
- **Multi-body arrays**: Support for entity type tags (`TextualBody` with `purpose: "tagging"`) and document links (`SpecificResource` with `purpose: "linking"`)
- **JSON-LD export**: W3C-compliant serialization for semantic web integration
- **Interoperability**: Standards-based approach enables data portability and tool integration

## Architecture

### Component Hierarchy

```
ResourceViewer (Container)
├── AnnotateView / BrowseView (Display Layer)
│   ├── Text Segments with Annotations
│   └── Selection Detection & Sparkle UI
├── AnnotationPopup (Interaction Layer)
│   ├── CreateAnnotationPopup
│   ├── HighlightPopup
│   ├── StubReferencePopup
│   └── ResolvedReferencePopup
└── DocumentAnnotationsContext (State Layer)
    ├── Annotation CRUD Operations
    ├── Optimistic Updates
    └── Server Synchronization
```

### Data Flow

1. **User Selection** → Text selection in AnnotateView
2. **Visual Feedback** → Sparkle UI appears with dashed border
3. **Action Trigger** → Click sparkle or keyboard shortcut
4. **Popup Display** → Contextual popup based on selection state
5. **User Decision** → Choose annotation type and properties
6. **Optimistic Update** → Immediate UI update with sparkle animation
7. **Server Sync** → Background API call to Layer 1 (API), persisted to Layer 2 (Event Store), Layer 3 (Projection), and Layer 4 (Graph Database)
8. **Confirmation** → Animation complete, W3C-compliant annotation persisted across all layers

For complete architecture details on how annotations flow through the event-sourced backend layers, see [W3C-WEB-ANNOTATION.md](../../../specs/docs/W3C-WEB-ANNOTATION.md).

## Component Design

### AnnotateView
**Purpose**: Renders document content with interactive annotations

**Key Features**:
- Segments text into annotated and non-annotated parts
- Handles text selection with visual feedback (dashed border + sparkle)
- Manages focus state for keyboard navigation
- Provides click and right-click handlers for annotations

**Implementation Details**:
```typescript
// Text segmentation algorithm
1. Sort annotations by offset
2. Split text at annotation boundaries
3. Render segments with appropriate styling
4. Apply sparkle animation to new annotations
```

### AnnotationPopup System
**Purpose**: Modular popup system for annotation operations

**Component Breakdown**:
- **CreateAnnotationPopup**: Initial selection, no existing annotation (creates W3C annotation with entity type tags)
- **HighlightPopup**: Existing highlight, can convert to reference (annotation with empty body array)
- **StubReferencePopup**: Unresolved reference with entity types (`TextualBody` with `purpose: "tagging"`), can link to document, includes JSON-LD export button
- **ResolvedReferencePopup**: Linked reference with entity types + document link (`SpecificResource` with `purpose: "linking"`), can edit or unlink, includes JSON-LD export button

**Shared Features**:
- Headless UI Dialog for accessibility
- Consistent visual design with glass morphism
- Keyboard navigation and focus management
- Escape key and click-outside dismissal

### DocumentAnnotationsContext
**Purpose**: Centralized state management for annotations

**Responsibilities**:
- Maintain local annotation state
- Handle CRUD operations with optimistic updates
- Track newly created annotations for sparkle animation
- Synchronize with backend API
- Provide hooks for components to access annotation data

## User Workflows

### Creating a Highlight
1. Select text in document
2. See sparkle appear (or press 'H' key)
3. Click sparkle → creates highlight immediately
4. Yellow background with sparkle animation confirms creation

### Creating a Reference
1. Select text in document
2. Press 'R' key (or click sparkle → click Reference)
3. Choose entity type (optional)
4. Enter reference details or search for document
5. Reference created with appropriate styling

### Converting Between Types
1. Click existing annotation
2. Popup shows current state
3. Choose "Convert to Reference" or "Convert to Highlight"
4. Annotation updates in place with animation

### Keyboard Workflows
- **H**: Quick highlight from selection
- **R**: Quick reference from selection
- **Delete**: Remove focused annotation
- **Tab/Shift-Tab**: Navigate through annotations
- **Enter/Space**: Activate focused annotation

## Visual Design System

### Color Coding
```css
/* Highlights */
background: rgb(254, 240, 138)  /* Yellow */

/* References by Type */
Stub Reference: rgb(243, 232, 255)      /* Light Purple */
Resolved Reference: rgb(219, 234, 254)  /* Light Blue */
Entity Reference: rgb(209, 250, 229)    /* Light Green */
```

### Interaction States
- **Hover**: Slight darkening, cursor pointer
- **Focus**: Cyan ring with offset
- **Active**: Sparkle animation on creation
- **Selection**: Dashed yellow border with pulse

### Animation System
```css
/* Sparkle animation for new annotations */
@keyframes sparkle {
  0%, 100% { opacity: 0; transform: scale(0) rotate(0deg); }
  50% { opacity: 1; transform: scale(1) rotate(180deg); }
}

/* Pulse animation for selection */
@keyframes pulse {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 1; }
}
```

## Accessibility Features

### WCAG 2.1 Level AA Compliance
- **Color Contrast**: All text meets minimum contrast ratios
- **Keyboard Access**: Full functionality without mouse
- **Focus Management**: Clear focus indicators and logical tab order
- **Screen Reader Support**: Proper ARIA labels and live regions
- **Error Handling**: Clear error messages with proper announcement

### ARIA Implementation
```html
<!-- Annotation with ARIA -->
<span
  role="button"
  tabIndex={0}
  aria-label="Highlight: [text content]"
  aria-describedby="annotation-tooltip"
>

<!-- Live Region for Updates -->
<div role="status" aria-live="polite">
  Highlight created
</div>
```

## Performance Optimizations

### Rendering Strategy
- **Memoization**: DocumentCard and annotation components use React.memo
- **Segment Caching**: Text segmentation only recalculates on annotation changes
- **Virtual Focus**: Only focused annotation has tabIndex={0}

### State Management
- **Optimistic Updates**: UI updates before server confirmation
- **Debounced Search**: 300ms delay on document search
- **Selective Re-renders**: Context updates only affected components

### Bundle Size
- **Code Splitting**: Annotation popups loaded on demand
- **Tree Shaking**: Unused Headless UI components excluded
- **Minimal Dependencies**: Lightweight implementation without heavy libraries

## API Integration

### Endpoints
```typescript
// Annotation CRUD
POST   /api/documents/{id}/annotations
GET    /api/documents/{id}/annotations
PUT    /api/annotations/{id}
DELETE /api/annotations/{id}

// Reference Resolution
GET    /api/documents/search
GET    /api/entity-types
POST   /api/annotations/{id}/resolve
```

### Error Handling
- **Network Failures**: Optimistic updates rollback with toast notification
- **Validation Errors**: Inline error messages in popups
- **Permission Errors**: Clear messaging about access restrictions
- **Conflict Resolution**: Last-write-wins with user notification

## Testing Strategy

### Unit Tests
- Text segmentation algorithm
- Annotation CRUD operations
- Keyboard shortcut handlers
- ARIA attribute generation

### Integration Tests
- Popup workflows end-to-end
- Keyboard navigation sequences
- Focus management scenarios
- API synchronization

### Accessibility Tests
- Screen reader compatibility
- Keyboard-only navigation
- Color contrast validation
- Focus trap verification

## Future Enhancements

### Planned Features
- **Collaborative Annotations**: Real-time multi-user editing
- **Annotation Threading**: Comments and discussions on annotations
- **Smart Suggestions**: AI-powered entity recognition
- **Bulk Operations**: Select multiple annotations for batch actions
- **Version History**: Track annotation changes over time

### Technical Improvements
- **WebSocket Sync**: Real-time updates without polling
- **Offline Support**: Service worker for offline annotation
- **Advanced Search**: Search within annotations
- **Export/Import**: Annotation portability between documents

## Migration & Compatibility

### Legacy Support
The system maintains backward compatibility with existing annotation data while providing enhanced UI features. Old annotations are automatically upgraded to the new schema on first load.

### Data Schema
```typescript
interface Annotation {
  id: string;
  type: 'highlight' | 'reference';
  selectionData: {
    text: string;
    offset: number;
    length: number;
  };
  // Reference-specific fields
  entityType?: string;
  referenceType?: string;
  resolvedDocumentId?: string;
  provisional?: boolean;
}
```

## Conclusion

The Semiont annotation system provides a powerful yet intuitive way to create structured knowledge from documents. By focusing on user experience, accessibility, and performance, we've created a system that scales from simple highlighting to complex knowledge graph construction.

The modular architecture ensures maintainability and extensibility, while the progressive enhancement approach ensures the system remains usable across different contexts and capabilities.

## Related Documentation

### W3C Web Annotation Implementation
- [W3C-WEB-ANNOTATION.md](../../../specs/docs/W3C-WEB-ANNOTATION.md) - Complete W3C implementation across all layers (UI, API, Event Store, Projection, Graph)

### Frontend Documentation
- [CODEMIRROR-INTEGRATION.md](./CODEMIRROR-INTEGRATION.md) - Document rendering and editor implementation
- [ANNOTATION-RENDERING-PRINCIPLES.md](./ANNOTATION-RENDERING-PRINCIPLES.md) - Rendering axioms and correctness properties
- [RENDERING-ARCHITECTURE.md](./RENDERING-ARCHITECTURE.md) - Document rendering pipeline

### System Documentation
- [ARCHITECTURE.md](../../../docs/ARCHITECTURE.md) - Overall system architecture
- [DATABASE.md](../../../docs/services/DATABASE.md) - PostgreSQL event store and projection layers
- [GRAPH.md](../../../docs/services/GRAPH.md) - Graph database implementations (Neo4j, Neptune, JanusGraph)