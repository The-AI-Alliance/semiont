# Annotations & References Architecture

## Overview

The Semiont annotation system enables users to mark up documents with highlights, comments, assessments, tags, and references, creating a rich knowledge graph. Built on the [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/), annotations are standards-compliant objects with motivations following the W3C specification.

This document describes the Browser UI patterns, component architecture, user workflows, and the annotation registry system. For the complete W3C implementation across all gateway components (API, Event Store, and Graph Database), see [W3C-WEB-ANNOTATION.md](../../../docs/protocol/W3C-WEB-ANNOTATION.md).

## Supported Annotation Types

The W3C Web Annotation vocabulary defines 13 motivations (`assessing`, `bookmarking`, `classifying`, `commenting`, `describing`, `editing`, `highlighting`, `identifying`, `linking`, `moderating`, `questioning`, `replying`, `tagging`). Semiont **supports five of them**: the spec's `Motivation` schema enumerates exactly those five, and `@semiont/core` generates the type (re-exported by `@semiont/sdk` as `Motivation`).

| W3C Motivation | Annotator Key | Description | Class | Visual Style |
|----------------|---------------|-------------|-------|--------------|
| `highlighting` | `highlight` | Mark text for attention | `annotation-highlight` | Tinted background |
| `commenting` | `comment` | Add a comment about the text | `annotation-comment` | Dashed outline |
| `assessing` | `assessment` | Provide evaluation or assessment | `annotation-assessment` | Wavy underline |
| `linking` | `reference` | Link to another resource | `annotation-reference` | Tinted background |
| `tagging` | `tag` | Structural role annotation | `annotation-tag` | Tinted background |

All annotation types are centrally managed through the **Annotation Registry** system (see [Annotation Registry](#annotation-registry) below).

## Core Principles

### 1. Progressive Enhancement
- **Basic functionality first**: Text selection and highlighting work without complex UI
- **Enhanced features on demand**: References and entity linking available through progressive disclosure
- **Graceful degradation**: System remains usable even if advanced features fail

### 2. Accessibility First
- **Keyboard navigation**: All annotation features accessible without mouse
- **Screen reader support**: Proper ARIA labels and live regions
- **Visual feedback**: Clear focus indicators and state changes

### 3. Performance & Responsiveness
- **Markdown renders once**: BrowseView paints annotations as an overlay, so an annotation change rebuilds only the annotated text nodes
- **Lightweight components**: Minimal DOM manipulation and re-renders

### 4. Standards Compliance
- **W3C Web Annotation Data Model**: All annotations follow the W3C specification
- **Multi-body arrays**: Support for entity type tags (`TextualBody` with `purpose: "tagging"`) and document links (`SpecificResource` with `purpose: "linking"`)
- **JSON-LD view**: W3C-compliant serialization for semantic web integration
- **Interoperability**: Standards-based approach enables data portability and tool integration

## Architecture

### Component Hierarchy

All of these come from `@semiont/react-ui`; the Browser's resource page renders `ResourceViewerPage`.

```text
ResourceViewerPage (page shell; composes the resource-viewer page state unit)
├── ResourceViewer (bring-your-own-session viewer)
│   ├── BrowseView — rendered content, annotations painted as an overlay
│   ├── AnnotateView — text selection, image and PDF shape drawing
│   │   (both carry the AnnotateToolbar)
│   └── PopupContainer — JsonLdView, or the delete confirmation
└── UnifiedAnnotationsPanel — statistics plus one tab per annotator
    └── HighlightPanel / ReferencesPanel / AssessmentPanel / CommentsPanel / TaggingPanel
        └── HighlightEntry / ReferenceEntry / AssessmentEntry / CommentEntry / TagEntry
```

### Data Flow

1. **Selection** → In annotate mode, with a motivation picked in the AnnotateToolbar, the user selects text (or draws a shape on an image or PDF)
2. **Request** → AnnotateView builds a `TextPositionSelector` + `TextQuoteSelector` pair and calls `session.client.mark.request(...)`, emitting `mark:requested`
3. **Pending** → The mark state unit holds the pending annotation; ResourceViewerPage opens the annotations panel
4. **Compose** → The motivation's panel shows a composer for the pending annotation; a highlight needs none and is submitted at once
5. **Submit** → The panel calls `session.client.mark.submit(...)`; the mark state unit calls `client.mark.annotation(...)`, which resolves once the gateway confirms, and clears the pending annotation
6. **Refresh** → The gateway persists the annotation to the Event Store (with materialized views) and Graph Database; the resulting `mark:added` refreshes the SDK's `browse.annotations` live query, the views re-render, and the created annotation sparkles

For complete architecture details on how annotations flow through the gateway data storage components, see [W3C-WEB-ANNOTATION.md](../../../docs/protocol/W3C-WEB-ANNOTATION.md).

## Annotation Registry

### Purpose

The Annotation Registry is provided by `@semiont/react-ui` and is a centralized system that provides a **single source of truth** for all annotation type metadata. This eliminates hard-coded lists scattered across the codebase.

**Implementation**: [`@semiont/react-ui/src/lib/annotation-registry.ts`](../../../packages/react-ui/src/lib/annotation-registry.ts)

### Design Philosophy

The registry follows these core principles:
- **Clean, direct, and ruthless**: No backward compatibility layers or aliasing
- **Single source of truth**: All annotation metadata in one place
- **Type safety**: TypeScript ensures all metadata fields are provided

### Registry Structure

Each annotation type is an `Annotator`:

```typescript
const {
  // W3C specification
  motivation,          // 'highlighting'
  internalType,        // 'highlight'

  // Display
  displayName,         // 'Highlight'

  // Visual styling
  className,           // 'annotation-highlight'
  iconEmoji,           // optional emoji icon

  // Type detection: (annotation: Annotation) => boolean
  matchesAnnotation,

  // Accessibility: screen reader announcement
  announceOnCreate,    // 'Highlight created'
}: Annotator = ANNOTATORS.highlight;
```

### Current Implementation

`ANNOTATORS` holds one annotator per supported motivation, keyed `highlight`, `comment`, `assessment`, `reference` and `tag` (the `AnnotatorKey` type). It is checked with `satisfies Record<string, Annotator>`, so every entry provides every field and keeps its literal type.

### Lookups

```typescript
// The annotator an annotation belongs to: each annotator answers for itself
const annotator = Object.values(ANNOTATORS).find((a) => a.matchesAnnotation(annotation));

// The registry key for a W3C motivation ('linking' → 'reference')
const key: AnnotatorKey | undefined = annotatorKeyForMotivation(annotation.motivation);
```

### Usage

#### Rendering Annotations

AnnotateView's CodeMirror decorations take the class from the annotation's annotator:

```typescript
const className =
  Object.values(ANNOTATORS).find((a) => a.matchesAnnotation(annotation))?.className ?? 'annotation-highlight';
```

BrowseView's overlay records each annotation's `internalType` and wraps its text in an `annotation-<type>` span.

#### Routing Clicks

When an annotation is clicked, `ResourceViewer` finds its annotator. If it has one and the toolbar's click action is `detail`, the viewer asks the host to open the annotations panel at that annotation; the shell state unit turns the motivation into the panel's tab with `annotatorKeyForMotivation`.

#### Grouping Annotations

`UnifiedAnnotationsPanel` takes the registry as its `annotators` prop and groups what it is given by each annotator's `internalType`:

```typescript
const groups: Record<string, Annotation[]> = {};
for (const ann of annotations) {
  const annotator = Object.values(ANNOTATORS).find((a) => a.matchesAnnotation(ann));
  if (annotator) (groups[annotator.internalType] ??= []).push(ann);
}
```

#### Accessibility Announcements

`useDocumentAnnouncements` announces each type's own `announceOnCreate`:

```typescript
const { announceAnnotationCreated } = useDocumentAnnouncements(ANNOTATORS);

announceAnnotationCreated(annotation); // 'Highlight created', 'Comment created', …
```

### Adding New Annotation Types

The registry holds every per-motivation fact, but supporting another motivation takes more than a registry entry. It touches:

- `specs/src/components/schemas/Motivation.json` — the `Motivation` enum must admit it (then regenerate the types in `@semiont/core`), and a type guard in `@semiont/core` recognizes it
- [`@semiont/react-ui/src/lib/annotation-registry.ts`](../../../packages/react-ui/src/lib/annotation-registry.ts) — its annotator
- `packages/react-ui/src/types/annotation-props.ts` and `packages/react-ui/src/lib/annotation-groups.ts` — `AnnotationsCollection` and the grouping that fills it have one bucket per motivation
- `packages/react-ui/src/components/resource/panels/UnifiedAnnotationsPanel.tsx` — its tab, and a panel for it
- `packages/react-ui/src/styles/motivations/` — the stylesheet for its `annotation-<type>` class

### Files Using the Registry

The registry is imported and used in `@semiont/react-ui`:

- [`@semiont/react-ui/src/lib/annotation-overlay.ts`](../../../packages/react-ui/src/lib/annotation-overlay.ts) - Annotation overlay (BrowseView)
- [`@semiont/react-ui/src/lib/codemirror-logic.ts`](../../../packages/react-ui/src/lib/codemirror-logic.ts) - CodeMirror decoration classes
- [`@semiont/react-ui/src/components/resource/BrowseView.tsx`](../../../packages/react-ui/src/components/resource/BrowseView.tsx) - Browse mode rendering
- [`@semiont/react-ui/src/components/resource/AnnotateView.tsx`](../../../packages/react-ui/src/components/resource/AnnotateView.tsx) - Annotate mode rendering
- [`@semiont/react-ui/src/components/resource/ResourceViewer.tsx`](../../../packages/react-ui/src/components/resource/ResourceViewer.tsx) - Click handlers
- [`@semiont/react-ui/src/components/resource/panels/UnifiedAnnotationsPanel.tsx`](../../../packages/react-ui/src/components/resource/panels/UnifiedAnnotationsPanel.tsx) - Grouping and tabs
- [`@semiont/react-ui/src/state/shell-state-unit.ts`](../../../packages/react-ui/src/state/shell-state-unit.ts) - Motivation → panel tab

### Benefits

1. **Maintainability**: Single source of truth for annotation metadata
2. **Consistency**: All components use the same styling/behavior logic
3. **Type Safety**: TypeScript ensures all metadata fields are provided
4. **Documentation**: Registry serves as living documentation of supported types
5. **Testing**: Easier to test annotation behavior in isolation

## Component Design

### AnnotateView
**Purpose**: Renders document content with interactive annotations

**Key Features**:
- Segments text into annotated and non-annotated parts, rendered by CodeMirror
- Turns a text selection into a `TextPositionSelector` + `TextQuoteSelector` pair and requests an annotation with the toolbar's motivation (`mark:requested`)
- Draws shapes on images (`SvgDrawingCanvas`) and PDFs
- Emits `browse:click` for a click on an annotation and `beckon:hover` for a hover

**Implementation Details**:
```text
segmentTextWithAnnotations(content, annotations)   — lib/text-segmentation.ts
1. Anchor each annotation: the stored position, re-anchored on a verbatim quote match
2. Drop anchors outside the content or empty; sort by start
3. Skip an annotation that overlaps an earlier one
4. Emit plain and annotated segments covering the whole content
```

### Click Actions
**Purpose**: The AnnotateToolbar's click action decides what clicking an annotation does

- **detail**: Opens the annotations panel at the annotation
- **follow**: Navigates to a resolved reference's target resource
- **jsonld**: Shows the annotation's JSON-LD in `JsonLdView`
- **deleting**: Asks for confirmation, then deletes (annotate mode only)

### ResourceAnnotationsContext
**Purpose**: UI state for the annotations on screen; the annotations themselves come from the SDK's live queries

**Responsibilities**:
- Track recently created or resolved annotations for the sparkle animation (`sparkleAnnotationIds`, `triggerSparkleAnimation`, `clearSparkle`)
- Create annotations of any motivation (`markAnnotation`)

## User Workflows

### Creating an Annotation
1. Switch to annotate mode and pick a motivation in the AnnotateToolbar
2. Select text in the document (or draw a shape on an image or PDF)
3. The annotations panel opens on that motivation's composer; a highlight is created at once
4. Fill in the composer (a reference takes optional entity types) and create it
5. The created annotation appears with its motivation's styling and sparkles

### Resolving a Reference
1. In annotate mode, click the ❓ icon on an unresolved reference's panel entry
2. The reference wizard opens (`bind:initiate`) to link it to a resource
3. A resolved reference's 🔗 icon opens its target; its unlink control removes the link

## Visual Design System

Each motivation's styles live in `packages/react-ui/src/styles/motivations/` (`motivation-highlight.css`, `motivation-comment.css`, …) as its `annotation-<type>` class, with dark-theme variants.

### Interaction States
- **Hover**: Each annotation class has its own hover style
- **Active**: `annotation-sparkle` on recently created or resolved annotations
- **Low confidence**: `annotation-low-confidence` on an annotation anchored below high confidence (dotted underline, with a tooltip naming the anchoring strategy)

## Accessibility Features

### Live Regions
`LiveRegionProvider` renders a polite (`role="status"`) and an assertive (`role="alert"`) live region; `useLiveRegion().announce(message, priority)` writes to them, and `useDocumentAnnouncements` builds the annotation announcements on it.

## Performance Optimizations

### Rendering Strategy
- **Markdown renders once**: BrowseView caches the rendered markdown; an annotation change touches only the overlay spans, with no markdown re-parse and no AST walk
- **One mutation per text node**: The overlay rebuilds each annotated text node once, off-DOM, in offset space, so overlapping annotations cost no extra DOM mutations

### State Management
- **Live queries**: Annotation lists are SDK live queries; the SDK refreshes them off `mark:added`, `mark:removed` and `mark:body-updated`, so components make no refetch calls

## SDK Integration

The Browser never calls the HTTP API directly; every annotation operation goes through `@semiont/sdk`:

```typescript
// Create: resolves once the gateway confirms
const { annotationId: created } = await session.client.mark.annotation({
  motivation: 'highlighting',
  target: { source: rId, selector: { type: 'TextQuoteSelector', exact: 'Hello World' } },
});

// Delete
await session.client.mark.delete(rId, created);

// Read: a live query the SDK keeps fresh
const annotations$ = session.client.browse.annotations(rId);

// Resolve a reference: add a link to its body
await session.client.bind.body(rId, aId, [
  { op: 'add', item: { type: 'SpecificResource', source: resourceId, purpose: 'linking' } },
]);

// Entity types for reference composers
const entityTypes$ = session.client.browse.entityTypes();
```

### Error Handling
- **Confirmed writes**: `mark.annotation`, `mark.delete` and `bind.body` await the gateway's reply and reject on failure
- **Outcome toasts**: `useOutcomeToasts` surfaces failed creates, deletes and body updates on the resource page

## Testing

- `packages/react-ui/src/lib/__tests__/annotation-registry.test.ts` - The registry
- `packages/react-ui/src/lib/__tests__/text-segmentation.test.ts` - Text segmentation
- `packages/react-ui/src/lib/__tests__/annotation-overlay.test.ts` - The BrowseView overlay

## W3C Annotation Data Model

### Schema

Semiont uses the full [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/). The `Annotation` type (from `@semiont/core`, re-exported by `@semiont/sdk`) is generated from the spec:

```typescript
const reference: Annotation = {
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  type: 'Annotation',
  id: annotationId,
  motivation: 'linking',
  created: '2025-01-03T12:00:00Z',

  // Target: What is being annotated
  target: {
    source: rId,
    selector: [
      { type: 'TextPositionSelector', start: 120, end: 132 },
      { type: 'TextQuoteSelector', exact: 'Ada Lovelace', prefix: 'by ', suffix: ' in' },
    ],
  },

  // Body: the annotation content (optional; a highlight has none)
  body: [
    { type: 'TextualBody', value: 'Person', purpose: 'tagging' },
    { type: 'SpecificResource', source: resourceId, purpose: 'linking' },
  ],
};
```

`creator`, `generator` and `wasAttributedTo` are derived by the knowledge base at write time, never supplied by the emitter.

### Browser-Specific Types

BrowseView paints from a lightweight `OverlayAnnotation`, created by `toOverlayAnnotations()` from the full W3C annotations for efficient DOM rendering:

```typescript
for (const { id, exact, offset, length, type, source } of toOverlayAnnotations(annotations)) {
  // exact: the annotated text
  // offset, length: the span in the markdown source
  // type: internal type from the registry ('highlight', 'comment', …)
  // source: the resource a SpecificResource body links to, else null
}
```

## Conclusion

The Semiont annotation system provides a powerful yet intuitive way to create structured knowledge from documents. By focusing on user experience, accessibility, and performance, we've created a system that scales from simple highlighting to complex knowledge graph construction.

The modular architecture ensures maintainability and extensibility, while the progressive enhancement approach ensures the system remains usable across different contexts and capabilities.

## Related Documentation

### React UI Library
- [`docs/builder/react-ui/ANNOTATIONS.md`](../../../docs/builder/react-ui/ANNOTATIONS.md) - Complete annotation system documentation with Provider Pattern architecture
- [`@semiont/react-ui/docs/ANNOTATION-CLICK.md`](../../../packages/react-ui/docs/ANNOTATION-CLICK.md) - Click and hover coordination
- [`@semiont/react-ui/src/lib/annotation-registry.ts`](../../../packages/react-ui/src/lib/annotation-registry.ts) - Source code for the Annotation Registry

### W3C Web Annotation Implementation
- [W3C-WEB-ANNOTATION.md](../../../docs/protocol/W3C-WEB-ANNOTATION.md) - Complete W3C implementation across all components (UI, API, Event Store, Graph)

### Browser Documentation
- [CODEMIRROR-INTEGRATION.md](../../../packages/react-ui/docs/CODEMIRROR-INTEGRATION.md) - Document rendering and editor implementation
- [ANNOTATION-RENDERING-PRINCIPLES.md](../../../packages/react-ui/docs/ANNOTATION-RENDERING-PRINCIPLES.md) - Rendering axioms and correctness properties
- [RENDERING-ARCHITECTURE.md](../../../packages/react-ui/docs/RENDERING-ARCHITECTURE.md) - Document rendering pipeline

### System Documentation
- [Architecture](../../../docs/architecture/README.md) - Overall system architecture
- [Graph Package](../../../packages/graph/) - Graph database implementations (Neo4j, Neptune, JanusGraph)
