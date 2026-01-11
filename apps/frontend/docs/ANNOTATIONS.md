# Annotations & References Architecture

## Overview

The Semiont annotation system enables users to mark up documents with highlights, comments, assessments, and references, creating a rich knowledge graph. Built on the [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/), annotations are standards-compliant objects with motivations following the W3C specification.

This document describes the frontend UI patterns, component architecture, user workflows, and the annotation registry system. For the complete W3C implementation across all backend components (API, Event Store, and Graph Database), see [W3C-WEB-ANNOTATION.md](../../../specs/docs/W3C-WEB-ANNOTATION.md).

## Supported Annotation Types

The W3C Web Annotation Data Model defines 13 standard motivations (`assessing`, `bookmarking`, `classifying`, `commenting`, `describing`, `editing`, `highlighting`, `identifying`, `linking`, `moderating`, `questioning`, `replying`, `tagging`). The `@semiont/api-client` package provides the complete type as `components['schemas']['Motivation']`.

Currently, Semiont frontend **implements 4 of these motivations**:

| W3C Motivation | Internal Type | Description | Visual Style |
|----------------|---------------|-------------|--------------|
| `highlighting` | `highlight` | Mark text for attention | Yellow background with sparkle |
| `commenting` | `comment` | Add a comment about the text | Dashed outline, opens Comments Panel |
| `assessing` | `assessment` | Provide evaluation or assessment | Red underline |
| `linking` | `reference` | Link to another resource | Gradient cyan-to-blue with link icon |

All annotation types are centrally managed through the **Annotation Registry** system (see [Annotation Registry](#annotation-registry) below).

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
7. **Server Sync** → Background API call persisted to Event Store (with materialized views) and Graph Database
8. **Confirmation** → Animation complete, W3C-compliant annotation persisted across all backend components

For complete architecture details on how annotations flow through the backend data storage components, see [W3C-WEB-ANNOTATION.md](../../../specs/docs/W3C-WEB-ANNOTATION.md).

## Annotation Registry

### Purpose

The Annotation Registry is provided by `@semiont/react-ui` and is a centralized system that provides a **single source of truth** for all annotation type metadata. This eliminates hard-coded lists scattered across the codebase and makes it trivial to add new W3C annotation motivations.

**Implementation**: [`@semiont/react-ui/src/lib/annotation-registry.ts`](../../../packages/react-ui/src/lib/annotation-registry.ts)

### Design Philosophy

The registry follows these core principles:
- **Clean, direct, and ruthless**: No backward compatibility layers or aliasing
- **Single source of truth**: All annotation metadata in one place
- **Type safety**: TypeScript ensures all metadata fields are provided
- **Extensibility**: Adding new motivations requires editing only 1 file

### Registry Structure

Each annotation type is defined with comprehensive metadata:

```typescript
export interface AnnotationTypeMetadata {
  // W3C specification
  motivation: Motivation;           // W3C motivation from api-client
  internalType: string;             // Internal identifier (e.g., 'comment')

  // Display
  displayName: string;              // User-facing name
  description: string;              // User-facing description

  // Visual styling
  className: string;                // Tailwind classes for rendering
  iconEmoji?: string;               // Optional emoji icon

  // Behavior flags
  isClickable: boolean;             // Can user click this annotation?
  hasHoverInteraction: boolean;     // Should hover trigger visual feedback?
  hasSidePanel: boolean;            // Opens side panel (e.g., Comments Panel)?

  // Type detection
  matchesAnnotation: (annotation: Annotation) => boolean;

  // Accessibility
  announceOnCreate: string;         // Screen reader announcement
}
```

### Current Implementation

The registry defines metadata for all 4 supported annotation types:

```typescript
export const ANNOTATION_TYPES: Record<string, AnnotationTypeMetadata> = {
  highlight: {
    motivation: 'highlighting',
    internalType: 'highlight',
    displayName: 'Highlight',
    description: 'Mark text for attention',
    className: 'rounded px-0.5 cursor-pointer transition-all duration-200 bg-yellow-200 hover:bg-yellow-300 text-gray-900 dark:bg-yellow-900/50 dark:hover:bg-yellow-900/60 dark:text-white dark:outline dark:outline-2 dark:outline-dashed dark:outline-yellow-500/60 dark:outline-offset-1',
    iconEmoji: '🖍️',
    isClickable: true,
    hasHoverInteraction: true,
    hasSidePanel: false,
    matchesAnnotation: (ann) => isHighlight(ann),
    announceOnCreate: 'Highlight created'
  },

  comment: {
    motivation: 'commenting',
    internalType: 'comment',
    hasSidePanel: true,  // Opens Comments Panel
    // ... other metadata
  },

  assessment: {
    motivation: 'assessing',
    internalType: 'assessment',
    // ... other metadata
  },

  reference: {
    motivation: 'linking',
    internalType: 'reference',
    // ... other metadata
  }
};
```

### Helper Functions

The registry provides utility functions for working with annotations:

```typescript
// Get all metadata for an annotation
getAnnotationTypeMetadata(annotation: Annotation): AnnotationTypeMetadata | null

// Get just the className
getAnnotationClassName(annotation: Annotation): string

// Get internal type string ('highlight', 'comment', etc.)
getAnnotationInternalType(annotation: Annotation): string

// Group annotations by type
groupAnnotationsByType(annotations: Annotation[]): Record<string, Annotation[]>
```

### Usage Examples

#### Rendering Annotations

Before the registry, className logic was duplicated in multiple places:

```typescript
// OLD: Hard-coded styling logic (appeared in 3+ files)
let className: string;
if (annotation.motivation === 'commenting') {
  className = 'rounded px-0.5 cursor-pointer transition-all duration-200 hover:bg-gray-100 dark:hover:bg-gray-800 outline outline-2 outline-dashed outline-gray-900 dark:outline-gray-100 outline-offset-1';
} else if (annotation.motivation === 'assessing') {
  className = 'red-underline cursor-pointer transition-all duration-200 hover:opacity-80';
} else if (isReference(annotation)) {
  className = 'rounded px-0.5 cursor-pointer transition-all duration-200 bg-gradient-to-r from-cyan-200 to-blue-200 hover:from-cyan-300 hover:to-blue-300 text-gray-900 dark:from-blue-900/50 dark:to-cyan-900/50 dark:hover:from-blue-900/60 dark:hover:to-cyan-900/60 dark:text-white dark:outline dark:outline-2 dark:outline-dashed dark:outline-cyan-500/60 dark:outline-offset-1';
} else {
  className = 'rounded px-0.5 cursor-pointer transition-all duration-200 bg-yellow-200 hover:bg-yellow-300 text-gray-900 dark:bg-yellow-900/50 dark:hover:bg-yellow-900/60 dark:text-white dark:outline dark:outline-2 dark:outline-dashed dark:outline-yellow-500/60 dark:outline-offset-1';
}
```

Now it's a single line:

```typescript
// NEW: Single line using registry
const className = getAnnotationClassName(annotation);
```

#### Routing Hover Events

Before the registry, hover detection had hard-coded motivation checks:

```typescript
// OLD: Hard-coded motivation check
const handleAnnotationHover = (annotationId: string | null) => {
  if (annotationId) {
    const annotation = annotationMap.get(annotationId);
    if (annotation?.motivation === 'commenting') {
      onCommentHover(annotationId);
      return;
    }
  }
  onAnnotationHover(annotationId);
};
```

Now it uses metadata flags:

```typescript
// NEW: Uses registry metadata
const handleAnnotationHover = (annotationId: string | null) => {
  if (annotationId) {
    const annotation = annotationMap.get(annotationId);
    const metadata = annotation ? getAnnotationTypeMetadata(annotation) : null;

    // Route to side panel if annotation type has one
    if (metadata?.hasSidePanel && onCommentHover) {
      onCommentHover(annotationId);
      return;
    }
  }
  onAnnotationHover(annotationId);
};
```

#### Filtering Annotations

Before the registry:

```typescript
// OLD: Manual filtering (4 separate filter calls)
const highlights = annotations.filter((a: Annotation) => a.motivation === 'highlighting');
const references = annotations.filter((a: Annotation) => a.motivation === 'linking');
const assessments = annotations.filter((a: Annotation) => a.motivation === 'assessing');
const comments = annotations.filter((a: Annotation) => a.motivation === 'commenting');
```

After the registry:

```typescript
// NEW: Single function call
const groups = groupAnnotationsByType(annotations);
const highlights = groups.highlight || [];
const references = groups.reference || [];
const assessments = groups.assessment || [];
const comments = groups.comment || [];
```

#### Accessibility Announcements

Before the registry, announcements only supported 2 types:

```typescript
// OLD: Hard-coded type string
const announceAnnotationCreated = (type: 'highlight' | 'reference') => {
  announce(`${type === 'highlight' ? 'Highlight' : 'Reference'} created`, 'polite');
};
```

Now it supports all types automatically:

```typescript
// NEW: Uses registry metadata
const announceAnnotationCreated = (annotation: Annotation) => {
  const metadata = getAnnotationTypeMetadata(annotation);
  const message = metadata?.announceOnCreate ?? 'Annotation created';
  announce(message, 'polite');
};
```

### Adding New Annotation Types

To add a new W3C motivation (e.g., `tagging`), edit **only** [`@semiont/react-ui/src/lib/annotation-registry.ts`](../../../packages/react-ui/src/lib/annotation-registry.ts):

```typescript
export const ANNOTATORS: Record<string, Annotator> = {
  // ... existing types ...

  tag: {
    motivation: 'tagging',
    displayName: 'Tag',
    description: 'Add semantic tags to content',
    className: 'rounded px-0.5 cursor-pointer transition-all duration-200 bg-green-200 hover:bg-green-300 text-gray-900 dark:bg-green-900/50',
    iconEmoji: '🏷️',
    isClickable: true,
    hasHoverInteraction: true,
    hasSidePanel: true,  // If tags have a side panel
    matchesAnnotation: (ann) => ann.motivation === 'tagging'
  }
};
```

That's it! All styling, filtering, hover behavior, click handling, and accessibility work automatically.

### Files Using the Registry

The registry is imported and used in `@semiont/react-ui` components:

- [`@semiont/react-ui/src/lib/rehype-render-annotations.ts`](../../../packages/react-ui/src/lib/rehype-render-annotations.ts) - Markdown rendering
- [`@semiont/react-ui/src/components/CodeMirrorRenderer.tsx`](../../../packages/react-ui/src/components/CodeMirrorRenderer.tsx) - Code editor rendering
- [`@semiont/react-ui/src/components/resource/BrowseView.tsx`](../../../packages/react-ui/src/components/resource/BrowseView.tsx) - Browse mode rendering
- [`@semiont/react-ui/src/components/resource/AnnotateView.tsx`](../../../packages/react-ui/src/components/resource/AnnotateView.tsx) - Annotate mode rendering
- [`@semiont/react-ui/src/components/resource/ResourceViewer.tsx`](../../../packages/react-ui/src/components/resource/ResourceViewer.tsx) - Click handlers

And in the frontend app:
- [src/app/[locale]/know/resource/[id]/page.tsx](../src/app/%5Blocale%5D/know/resource/%5Bid%5D/page.tsx) - Annotation filtering and detection handlers

### Benefits

1. **Extensibility**: Add new annotation types by editing 1 file instead of 7+
2. **Maintainability**: Single source of truth for annotation metadata
3. **Consistency**: All components use the same styling/behavior logic
4. **Type Safety**: TypeScript ensures all metadata fields are provided
5. **Documentation**: Registry serves as living documentation of supported types
6. **Testing**: Easier to test annotation behavior in isolation

### Implementation History

The registry was implemented in October 2025 as part of a comprehensive refactoring to eliminate hard-coded annotation lists throughout the codebase.

**Key changes:**
- Created centralized registry with all annotation metadata
- Removed ~70 lines of duplicate className logic
- Updated 7+ files to use registry functions
- Deleted legacy `annotation-styles.ts` file
- Removed debug console.logs and implemented TODOs

The refactoring followed a clean, direct approach with no backward compatibility layers - all call sites were updated directly to use the registry functions.

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

## W3C Annotation Data Model

### Schema

Semiont uses the full [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/). All annotations follow the W3C specification:

```typescript
// From @semiont/api-client
type Annotation = components['schemas']['Annotation'];
type Motivation = components['schemas']['Motivation'];

// W3C Annotation structure (simplified)
interface W3CAnnotation {
  '@context': 'http://www.w3.org/ns/anno.jsonld';
  type: 'Annotation';
  id: string;                    // URI of the annotation
  motivation: Motivation;        // W3C motivation (e.g., 'highlighting', 'commenting')

  // Target: What is being annotated
  target: {
    source: string;              // URI of the document
    selector: {
      type: 'TextQuoteSelector';
      exact: string;             // The exact text being annotated
      prefix?: string;           // Text before (for disambiguation)
      suffix?: string;           // Text after (for disambiguation)
    };
  };

  // Body: The annotation content (array)
  body: Array<
    | {
        type: 'TextualBody';
        value: string;           // Comment text, assessment content, etc.
        purpose?: string;        // 'commenting', 'assessing', etc.
      }
    | {
        type: 'SpecificResource';
        source: string;          // URI of referenced document
        purpose: 'linking';      // For references
      }
  >;

  creator?: {
    id: string;
    name?: string;
  };
  created?: string;              // ISO 8601 timestamp
  modified?: string;             // ISO 8601 timestamp
}
```

### Frontend-Specific Types

The frontend uses a simplified `PreparedAnnotation` type for rendering in remark/rehype:

```typescript
// src/lib/remark-annotations.ts
export interface PreparedAnnotation {
  id: string;
  exact: string;    // The annotated text
  offset: number;   // Character offset in document
  length: number;   // Length of annotation
  type: string;     // Internal type from registry ('highlight', 'comment', etc.)
  source: string | null;  // Referenced document URI (for references)
}
```

This lightweight format is created by `remark-annotations.ts` from the full W3C annotations for efficient rendering.

## Conclusion

The Semiont annotation system provides a powerful yet intuitive way to create structured knowledge from documents. By focusing on user experience, accessibility, and performance, we've created a system that scales from simple highlighting to complex knowledge graph construction.

The modular architecture ensures maintainability and extensibility, while the progressive enhancement approach ensures the system remains usable across different contexts and capabilities.

## Related Documentation

### React UI Library
- [`@semiont/react-ui/docs/ANNOTATIONS.md`](../../../packages/react-ui/docs/ANNOTATIONS.md) - Complete annotation system documentation with Provider Pattern architecture
- [`@semiont/react-ui/src/lib/annotation-registry.ts`](../../../packages/react-ui/src/lib/annotation-registry.ts) - Source code for the Annotation Registry

### W3C Web Annotation Implementation
- [W3C-WEB-ANNOTATION.md](../../../specs/docs/W3C-WEB-ANNOTATION.md) - Complete W3C implementation across all components (UI, API, Event Store, Graph)

### Frontend Documentation
- [CODEMIRROR-INTEGRATION.md](./CODEMIRROR-INTEGRATION.md) - Document rendering and editor implementation
- [ANNOTATION-RENDERING-PRINCIPLES.md](./ANNOTATION-RENDERING-PRINCIPLES.md) - Rendering axioms and correctness properties
- [RENDERING-ARCHITECTURE.md](./RENDERING-ARCHITECTURE.md) - Document rendering pipeline
- [REACT-MARKDOWN.md](./REACT-MARKDOWN.md) - Markdown rendering with remark/rehype

### System Documentation
- [ARCHITECTURE.md](../../../docs/ARCHITECTURE.md) - Overall system architecture
- [DATABASE.md](../../backend/docs/DATABASE.md) - PostgreSQL for user accounts and job queue
- [Graph Package](../../../packages/graph/) - Graph database implementations (Neo4j, Neptune, JanusGraph)