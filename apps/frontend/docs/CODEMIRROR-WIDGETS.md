# CodeMirror Widgets (AnnotateView Only)

## Overview

Inline widgets enhance the **AnnotateView** document curation experience by adding interactive visual indicators next to annotations.

**Important**: This document describes widgets used **only in AnnotateView** (curation mode). BrowseView uses a completely different rendering approach (ReactMarkdown) that does not include widgets. See [REACT-MARKDOWN.md](./REACT-MARKDOWN.md) for BrowseView details.

**Current Implementation**: The widgets system currently provides one type of enhancement:

1. **ReferenceResolutionWidget** - Shows resolution status next to reference annotations (🔗 resolved, ❓ stub, ✨ generating)

## Implementation

### Location

- **Widget Classes**: `/src/lib/codemirror-widgets.ts`
- **Integration**: `/src/components/CodeMirrorRenderer.tsx`
- **Consumer**: `/src/components/resource/AnnotateView.tsx`

### Widget Types

#### ReferenceResolutionWidget

Shows a small indicator next to reference annotations to indicate their resolution status.

**States**:
1. **Resolved (🔗)**: Reference has a `referencedDocumentId`
   - Icon: 🔗 link symbol
   - Hover: Shows tooltip with target document name
   - Click: Navigates to referenced document
   - Opacity: 0.6 default, 1.0 on hover

2. **Generating (✨)**: Document is being created for this reference
   - Icon: ✨ sparkle in pulsing yellow circle (matches text selection sparkle)
   - Animation: Pinging yellow background
   - State: Disabled (no click handler)
   - Dark mode: Gray-800 background with yellow-500 border

3. **Stub/Unresolved (❓)**: Reference has no target document yet
   - Icon: ❓ question mark
   - Tooltip: "Stub reference. Click to resolve."
   - Click: Opens resolution UI (calls `onUnresolvedReferenceClick`)
   - Opacity: 0.6 default, 1.0 on hover

**Features**:
- Keyboard accessible (button element with ARIA labels)
- Focus styles (2px blue outline)
- Hover tooltips (only for resolved references with valid document names)
- Click handlers differ by state
- Dark mode support for generating state

**Placement**: Appears immediately after the reference text (`side: 1`).

**Implementation**: `/src/lib/codemirror-widgets.ts` - `ReferenceResolutionWidget` class

## Integration with CodeMirrorRenderer

### Props

```typescript
interface Props {
  // ... existing props
  enableWidgets?: boolean; // Enable/disable widgets
  onReferenceNavigate?: (documentId: string) => void;
  onUnresolvedReferenceClick?: (annotation: AnnotationSelection) => void;
  getTargetDocumentName?: (documentId: string) => string | undefined;
  generatingReferenceId?: string | null;
}
```

### State Management

Widgets use a dedicated StateField (`widgetDecorationsField`) that:
- Creates widget decorations incrementally
- Maps through document changes
- Updates via `updateWidgetsEffect` effect

### Decoration Building

```typescript
function buildWidgetDecorations(
  content: string,
  segments: TextSegment[],
  generatingReferenceId: string | null | undefined,
  callbacks: {
    onReferenceNavigate?: (documentId: string) => void;
    onUnresolvedReferenceClick?: (annotation: AnnotationSelection) => void;
    getTargetDocumentName?: (documentId: string) => string | undefined;
  }
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();

  // Process all annotations in sorted order by end position
  const allAnnotatedSegments = segments
    .filter(s => s.annotation)
    .sort((a, b) => a.end - b.end);

  for (const segment of allAnnotatedSegments) {
    if (!segment.annotation) continue;

    // Add resolution widget for references only
    if (segment.annotation.type === 'reference') {
      const targetName = segment.annotation.referencedDocumentId
        ? callbacks.getTargetDocumentName?.(segment.annotation.referencedDocumentId)
        : undefined;
      const isGenerating = generatingReferenceId === segment.annotation.id;

      const widget = new ReferenceResolutionWidget(
        segment.annotation,
        targetName,
        callbacks.onReferenceNavigate,
        callbacks.onUnresolvedReferenceClick,
        isGenerating
      );

      builder.add(segment.end, segment.end, Decoration.widget({ widget, side: 1 }));
    }
  }

  return builder.finish();
}
```

## Usage Example

### In AnnotateView

```typescript
<CodeMirrorRenderer
  content={content}
  segments={segments}
  enableWidgets={true}
  onReferenceNavigate={(documentId) => {
    // Navigate to referenced document
    router.push(`/know/document/${documentId}`);
  }}
  onUnresolvedReferenceClick={(annotation) => {
    // Open resolution UI for stub references
    setSelectedAnnotation(annotation);
    setShowResolutionPopup(true);
  }}
  getTargetDocumentName={(documentId) => {
    // Look up document name from cache or API
    const doc = documentsQuery.data?.find(d => d.id === documentId);
    return doc?.title;
  }}
  generatingReferenceId={generatingReferenceId}
/>
```

## Performance Considerations

### Incremental Updates

Widgets use CodeMirror's state management system for efficient updates:
- Widget decorations created once and mapped through changes
- Only rebuild when content or segments actually change
- No DOM recreation on every render

### Widget Equality

The ReferenceResolutionWidget implements `eq()` method to avoid unnecessary recreations:

```typescript
eq(other: ReferenceResolutionWidget) {
  return other.annotation.id === this.annotation.id &&
         other.targetDocumentName === this.targetDocumentName &&
         other.isGenerating === this.isGenerating;
}
```

CodeMirror uses this to determine if a widget can be reused or must be recreated. The widget only recreates if:
- The annotation ID changes
- The target document name changes
- The generating state changes

### Event Handling

Widgets use `ignoreEvent()` to prevent CodeMirror from processing widget-internal events:

```typescript
ignoreEvent(event: Event): boolean {
  return event.type === 'click'; // Widget handles clicks internally
}
```

## Styling

All widgets use inline styles for self-containment:
- No external CSS dependencies
- Dark mode handled via inline style toggling
- Animations reference global CSS keyframes (`fadeIn`)

## Historical Note: Removed Widgets

Previous versions of this system included:
- **WikiLinkWidget**: Rendered `[[wiki links]]` as clickable pills - removed in favor of simpler approach
- **EntityTypeBadgeWidget**: Displayed entity types as inline badges - removed to reduce visual clutter

Only ReferenceResolutionWidget remains in production as it provides essential feedback about reference resolution status.

## Future Enhancements

### Short Term
1. Add caching for `getTargetDocumentName` lookups to reduce query overhead
2. Improve keyboard navigation for widget interactions
3. Enhance tooltip positioning for edge cases

### Medium Term
1. Preview panels on hover showing document snippets (not just titles)
2. Inline document previews for references
3. Animation improvements for generating state

### Long Term
1. User-customizable widget appearance
2. Plugin system for additional widget types
3. Widget analytics (track which references users navigate to)

## Debugging

### Enable Widget Logging

Add logging to widget decorations:

```typescript
console.log('[Widgets] Building decorations:', {
  references: annotatedSegments.filter(s => s.annotation.type === 'reference').length,
  generating: generatingReferenceId ? 1 : 0
});
```

### Inspect Widget DOM

Widgets are rendered as DOM elements inside CodeMirror's view:
- Use browser DevTools to inspect `.cm-widget` elements
- Check `data-annotation-id` attributes
- Verify event handlers with breakpoints

### Common Issues

1. **Widgets not appearing**: Check `enableWidgets` prop is true on CodeMirrorRenderer
2. **Callbacks not firing**: Verify `onReferenceNavigate` and `onUnresolvedReferenceClick` callbacks are passed
3. **Position issues**: Widgets use `side: 1` to appear after the annotation text
4. **Duplicate widgets**: Check widget `eq()` method - widgets should only recreate when annotation ID, target name, or generating state changes
5. **Tooltip not showing**: Tooltips only appear for resolved references with valid document names
6. **Generating animation not working**: Ensure `generatingReferenceId` matches the annotation ID and `ping` animation is defined in CSS

## Testing

### Unit Tests

Test ReferenceResolutionWidget in isolation:

```typescript
describe('ReferenceResolutionWidget', () => {
  it('should show 🔗 for resolved references', () => {
    const annotation = { id: '1', type: 'reference', referencedDocumentId: 'doc-123' };
    const widget = new ReferenceResolutionWidget(annotation, 'Target Doc');
    const dom = widget.toDOM();
    expect(dom.querySelector('button')?.innerHTML).toContain('🔗');
    expect(dom.querySelector('button')?.title).toBe('Links to: Target Doc');
  });

  it('should show ❓ for stub references', () => {
    const annotation = { id: '1', type: 'reference' };
    const widget = new ReferenceResolutionWidget(annotation);
    const dom = widget.toDOM();
    expect(dom.querySelector('button')?.innerHTML).toContain('❓');
    expect(dom.querySelector('button')?.title).toBe('Stub reference. Click to resolve.');
  });

  it('should show ✨ for generating references', () => {
    const annotation = { id: '1', type: 'reference' };
    const widget = new ReferenceResolutionWidget(annotation, undefined, undefined, undefined, true);
    const dom = widget.toDOM();
    expect(dom.querySelector('button')?.innerHTML).toContain('✨');
    expect(dom.querySelector('button')?.disabled).toBe(true);
  });

  it('should call onNavigate when resolved reference is clicked', () => {
    const onNavigate = jest.fn();
    const annotation = { id: '1', type: 'reference', referencedDocumentId: 'doc-123' };
    const widget = new ReferenceResolutionWidget(annotation, 'Target', onNavigate);
    const dom = widget.toDOM();
    dom.querySelector('button')?.click();
    expect(onNavigate).toHaveBeenCalledWith('doc-123');
  });

  it('should call onUnresolvedClick when stub reference is clicked', () => {
    const onUnresolvedClick = jest.fn();
    const annotation = { id: '1', type: 'reference' };
    const widget = new ReferenceResolutionWidget(annotation, undefined, undefined, onUnresolvedClick);
    const dom = widget.toDOM();
    dom.querySelector('button')?.click();
    expect(onUnresolvedClick).toHaveBeenCalledWith(annotation);
  });
});
```

### Integration Tests

Test widgets in CodeMirrorRenderer:

```typescript
describe('CodeMirrorRenderer with widgets', () => {
  it('should render reference resolution widget for resolved reference', () => {
    const segments = [{
      start: 0,
      end: 10,
      text: 'test reference',
      annotation: { id: '1', type: 'reference', referencedDocumentId: 'doc-123' }
    }];

    render(
      <CodeMirrorRenderer
        content="test reference"
        segments={segments}
        enableWidgets={true}
        onReferenceNavigate={jest.fn()}
        getTargetDocumentName={() => 'Target Doc'}
      />
    );

    // Widget should appear after text
    const indicator = screen.getByRole('button', { name: /Reference link to Target Doc/ });
    expect(indicator).toBeInTheDocument();
    expect(indicator.innerHTML).toContain('🔗');
  });

  it('should render generating widget when reference is being created', () => {
    const segments = [{
      start: 0,
      end: 10,
      text: 'test reference',
      annotation: { id: 'ref-1', type: 'reference' }
    }];

    render(
      <CodeMirrorRenderer
        content="test reference"
        segments={segments}
        enableWidgets={true}
        generatingReferenceId="ref-1"
      />
    );

    const indicator = screen.getByRole('button', { name: /Generating document/ });
    expect(indicator).toBeInTheDocument();
    expect(indicator.innerHTML).toContain('✨');
    expect(indicator).toBeDisabled();
  });
});
```

## Related Documentation

- [CODEMIRROR-INTEGRATION.md](./CODEMIRROR-INTEGRATION.md) - CodeMirror integration for AnnotateView
- [REACT-MARKDOWN.md](./REACT-MARKDOWN.md) - ReactMarkdown integration for BrowseView (no widgets)
- [RENDERING-ARCHITECTURE.md](./RENDERING-ARCHITECTURE.md) - Dual rendering architecture
- [ARCHITECTURE.md](./ARCHITECTURE.md) - Frontend architecture overview
- [ANNOTATIONS.md](./ANNOTATIONS.md) - Annotation UI/UX and workflows
