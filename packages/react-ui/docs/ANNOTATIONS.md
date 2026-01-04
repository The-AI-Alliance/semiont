# Annotations

> **Note:** This documentation is minimal. The annotation system is undergoing active development and comprehensive documentation will be added in a future update.

## Overview

`@semiont/react-ui` provides a rich annotation system for semantic markup of resources. The system supports:

- Web Annotation Data Model compliance
- Multiple annotation types (highlights, comments, tags, references, assessments)
- Image annotations with SVG drawing
- Entity detection and linking
- JSON-LD representation
- Annotation history and collaboration

## Components

### Annotation Toolbars

- `AnnotateToolbar` - Main annotation interface

### Annotation Panels

- `HighlightPanel` - Highlight annotations
- `CommentsPanel` - Comment annotations
- `TaggingPanel` - Tag management
- `ReferencesPanel` - Reference annotations
- `AssessmentPanel` - Assessment/rating annotations
- `JsonLdPanel` - JSON-LD view
- `UnifiedAnnotationsPanel` - All annotations in one view

### Detection & Generation

- `DetectSection` - Entity detection interface
- AI-powered entity suggestions
- Bulk annotation operations

### Image Annotations

- `AnnotationOverlay` - Image annotation layer
- `SvgDrawingCanvas` - SVG drawing tools

## API Hooks

See [API-INTEGRATION.md](API-INTEGRATION.md#useannotations) for annotation API usage.

```tsx
import { useAnnotations } from '@semiont/react-ui';

const annotations = useAnnotations();
const { data } = annotations.create.useMutation();
```

## Core Libraries

### Annotation Registry

```typescript
import { registerAnnotationType, getAnnotationType } from '@semiont/react-ui';

// Register custom annotation types
registerAnnotationType({
  type: 'MyCustomType',
  component: MyCustomAnnotationComponent,
  // ... configuration
});
```

### Remark/Rehype Plugins

- `remark-annotations` - Markdown annotation processing
- `rehype-render-annotations` - HTML annotation rendering

### CodeMirror Integration

- `codemirror-widgets` - Inline annotation widgets
- `codemirror-json-theme` - JSON syntax highlighting

## Future Documentation

Comprehensive documentation for the annotation system is planned, including:

- Annotation data model specification
- Creating custom annotation types
- Annotation rendering pipeline
- Image annotation architecture
- Entity detection algorithms
- Collaboration and conflict resolution
- Performance optimization strategies

## See Also

- [API-INTEGRATION.md](API-INTEGRATION.md#useannotations) - Annotation API hooks
- [COMPONENTS.md](COMPONENTS.md) - Annotation components
- Web Annotation Data Model: https://www.w3.org/TR/annotation-model/

## Contributing

If you're working with the annotation system and would like to contribute to this documentation, please see the main [README.md](../README.md) for contribution guidelines.
