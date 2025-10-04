# React Markdown + Annotation Rendering (BrowseView Only)

## Overview

Our markdown rendering system for **BrowseView** combines `react-markdown` with enterprise-grade annotation support, enabling precise highlighting and references that span across formatted text elements.

**Important:** This document describes the ReactMarkdown-based rendering pipeline used **only in BrowseView** (read-only mode). AnnotateView uses a completely different approach (CodeMirror) documented in [CODEMIRROR-INTEGRATION.md](./CODEMIRROR-INTEGRATION.md).

### BrowseView vs AnnotateView Styling

**BrowseView** (ReactMarkdown - this doc):
- **Highlights**: Yellow background
- **Resolved References**: Blue text (like traditional HTML links)
- **Stub References**: Red text
- **Rendering**: Prose styling with variable-width font
- **Interaction**: Simple click-to-navigate
- **No widgets**: Clean, document-like appearance

**AnnotateView** (CodeMirror):
- **Highlights**: Yellow background with dashed outline
- **All References**: Blue/cyan gradient background (no distinction between stub/resolved)
- **Rendering**: Monospace font, editor-like appearance
- **Widgets**: Inline 🔗 (resolved), ❓ (stub), ✨ (generating)
- **Interaction**: Right-click menus, popups, hover effects

## Key Breakthrough: Position Preservation

The critical insight that made this approach work: **position data survives the unified.js pipeline**.

When markdown is parsed through the unified.js transformation chain:
```
markdown → remark (MDAST) → remark-rehype → rehype (HAST) → React
```

Every AST node retains `position.start.offset` and `position.end.offset` pointing to **character offsets in the original markdown source**. This is the foundation that enables accurate annotation placement.

## Architecture

### Two-Phase Rendering

**Phase 1: Cross-Element Spanning**
- Identifies annotations that span multiple sibling elements (e.g., `**Zeus** and **Hera**`)
- Wraps sequences of children in annotation spans
- Uses a visitor pattern with stack-based tracking to find the lowest common ancestor
- Marked with `data-annotation-cross-element="true"`

**Phase 2: Within-Text-Node Annotations**
- Handles annotations contained within individual text nodes
- Uses character-by-character position mapping when markdown syntax differs from rendered text
- Creates segmented spans for proper annotation boundaries

### Position Mapping Strategy

When source text matches rendered text (plain text):
```typescript
// Direct offset calculation
const relStart = annStart - textStart;
const relEnd = (annStart + annLength) - textStart;
```

When markdown syntax is present (bold, italic, links):
```typescript
// Character-by-character mapping
const map = buildPositionMap(sourceText, renderedText, baseOffset);
const renderedStart = map.get(annStart);
const renderedEnd = map.get(annEnd);
```

Example mapping for `*Athena*`:
- Source: `*Athena*` (positions 12-20)
- Rendered: `Athena` (6 chars)
- Mapping: source[13]='A' → rendered[0]='A'

## Implementation

### Remark Plugin: Attach Metadata

[remark-annotations.ts](apps/frontend/src/lib/remark-annotations.ts) runs during the remark phase:

```typescript
export function remarkAnnotations(options: { annotations: Annotation[] }) {
  return (tree: Root, file: VFile) => {
    const source = String(file);
    visit(tree, (node) => {
      if (!node.position) return;

      const nodeStart = node.position.start.offset;
      const nodeEnd = node.position.end.offset;

      // Find overlapping annotations
      const overlapping = annotations.filter(ann => {
        const annStart = ann.offset;
        const annEnd = ann.offset + ann.length;
        return annStart < nodeEnd && annEnd > nodeStart;
      });

      if (overlapping.length > 0) {
        // Attach metadata via hProperties (survives remark→rehype)
        node.data.hProperties = {
          'data-annotations': JSON.stringify(overlapping),
          'data-node-start': nodeStart,
          'data-node-end': nodeEnd,
          'data-source': source
        };
      }
    });
  };
}
```

### Rehype Plugin: Render Annotations

[rehype-render-annotations.ts](apps/frontend/src/lib/rehype-render-annotations.ts) runs during the rehype phase:

```typescript
export function rehypeRenderAnnotations() {
  return (tree: Root) => {
    visit(tree, 'element', (element: Element) => {
      const annotationsJson = element.properties?.['data-annotations'];
      if (!annotationsJson) return;

      const annotations = JSON.parse(annotationsJson);
      const source = element.properties['data-source'];

      // PHASE 1: Cross-element spanning
      wrapCrossElementAnnotations(element, annotations);

      // PHASE 2: Within-text-node annotations
      applyWithinTextNodeAnnotations(element, annotations, source);
    });
  };
}
```

### Component Integration

[BrowseView.tsx](apps/frontend/src/components/document/BrowseView.tsx):

```typescript
<ReactMarkdown
  remarkPlugins={[
    remarkGfm,
    [remarkAnnotations, { annotations: preparedAnnotations }]
  ]}
  rehypePlugins={[rehypeRenderAnnotations]}
>
  {content}
</ReactMarkdown>
```

Client-side event handlers attached via `useEffect` after rendering:
- Click handlers for reference annotations
- Animation classes for newly created annotations

## Key Concepts

### Range Intersection

Determining if an annotation overlaps a node:
```typescript
const overlaps = annStart < nodeEnd && annEnd > nodeStart;
```

### Data Preservation via hProperties

`node.data.hProperties` in MDAST becomes `element.properties` in HAST:
```typescript
// In remark (MDAST)
node.data.hProperties = { 'data-foo': 'bar' };

// In rehype (HAST)
element.properties['data-foo'] === 'bar'  // ✓
```

### DOM Tree Rewriting

For enterprise-grade annotation support, we directly manipulate the HAST tree:
```typescript
// Wrap a sequence of children
const wrapper: Element = {
  type: 'element',
  tagName: 'span',
  properties: { className, 'data-annotation-id': id },
  children: childrenToWrap
};
element.children.splice(startIndex, endIndex - startIndex, wrapper);
```

### Character Position Tracking

When markdown syntax is stripped, maintain a mapping:
```typescript
function buildPositionMap(source: string, rendered: string, baseOffset: number) {
  const map = new Map<number, number>();
  let renderedPos = 0;
  let sourcePos = 0;

  while (sourcePos < source.length && renderedPos < rendered.length) {
    if (source[sourcePos] === rendered[renderedPos]) {
      map.set(baseOffset + sourcePos, renderedPos);
      renderedPos++;
      sourcePos++;
    } else {
      sourcePos++; // Skip markdown syntax characters
    }
  }
  return map;
}
```

## Why Previous Approaches Failed

**Attempt 1: Post-processing HTML**
- Lost connection to original markdown positions
- Regex-based text matching created duplicates
- No reliable way to handle markdown syntax

**Attempt 2: Custom markdown parser**
- Reinventing the wheel
- Missing edge cases (GFM, tables, etc.)
- High maintenance burden

**Attempt 3: react-markdown without position data**
- Assumed position data was lost in transformation
- Tried to match text patterns (fragile)
- Couldn't handle markdown syntax stripping

## The Working Solution

The breakthrough came from realizing:
1. **Position data IS preserved** through the entire unified.js pipeline
2. **hProperties survive transformation** from remark to rehype
3. **Direct offset math works** when source equals rendered
4. **Character mapping handles** cases where markdown syntax is stripped
5. **Two-phase rendering handles** both cross-element and within-node annotations

## Testing

Comprehensive test coverage in [markdown-annotations.test.ts](apps/frontend/src/lib/__tests__/markdown-annotations.test.ts):

- Plain text annotations
- Bold markdown (`**Zeus**`)
- Italic markdown (`*Athena*`)
- Link annotations (`[Zeus](url)`)
- Cross-element spanning (`**Zeus** and **Hera**`)
- Mixed complexity (bold + italic + links with overlapping annotations)
- Multiple occurrences of same text
- Overlapping annotations
- Edge cases

All tests validate that annotations:
1. Preserve original markdown positions
2. Render correct HTML structure
3. Apply appropriate CSS classes
4. Include all metadata attributes

## Dependencies

- `react-markdown`: Core markdown rendering
- `remark-gfm`: GitHub Flavored Markdown (lists, tables, etc.)
- `unified`: Plugin pipeline architecture
- `unist-util-visit`: AST traversal
- `@tailwindcss/typography`: Prose styling (headings, lists, etc.)

## Performance Considerations

- Plugins run during SSR (server-side rendering)
- Event handlers attached client-side via `useEffect`
- Position mapping built only when needed (cached per text node)
- Two-phase approach minimizes tree traversals
- **Efficient data passing**: Markdown source passed via VFile closure (once) rather than stored as `data-source` attribute on every element
- **Minimal DOM footprint**: Only `data-annotation-id` and `data-annotation-type` remain in final client-side DOM
- **Temporary metadata cleanup**: `data-annotations` used during processing but deleted before render

## Debugging

If you need to debug the annotation rendering pipeline:

1. **Enable intermediate data**: In [rehype-render-annotations.ts](apps/frontend/src/lib/rehype-render-annotations.ts), comment out the cleanup line:
   ```typescript
   // delete element.properties['data-annotations'];
   ```

2. **Inspect element metadata**: This will preserve the `data-annotations` attribute on elements, showing which annotations overlap each element in the browser DevTools

3. **Access source text**: The markdown source is available via the unified processor's VFile throughout the plugin pipeline

**What was removed to minimize DOM bloat:**
- ❌ `data-source` - Entire markdown source was duplicated on every annotated element (huge!)
- ❌ `data-node-start` / `data-node-end` - Position data already available in AST nodes
- ✅ Only `data-annotation-id` and `data-annotation-type` remain for click handlers

## Current Capabilities

✅ **Cross-element spanning within blocks**: Annotations can span multiple inline elements within a single block (e.g., `**Zeus** and **Hera**` where the annotation covers both bold elements and the text between them)

✅ **Complex markdown**: Full support for GFM including bold, italic, links, lists, tables, etc.

✅ **Position-accurate rendering**: Direct mapping from markdown source positions to rendered output

✅ **Multiple annotation types**: Both highlights and references with different styling

## Future Enhancements

### Cross-Block Annotation Spanning

**Current state**: The LCA (lowest common ancestor) approach in `wrapCrossElementAnnotations` works within a single block element, but doesn't handle annotations that span **across** sibling block elements (e.g., from one `<p>` to another).

**Why it doesn't work yet**: The rehype plugin visits each element independently. When processing a `<p>`, it only looks at that `<p>`'s immediate children, not its siblings.

**How to implement**:
1. **Process at a higher level**: Instead of processing each `<p>` independently, process their parent container (e.g., the `<div>` or `<article>` containing multiple paragraphs)
2. **Identify cross-block spans**: In `analyzeChildSpans`, detect when an annotation's start and end positions span multiple block-level children
3. **Wrap block-level siblings**: Extend `wrapChildRange` to handle wrapping sequences of block elements (not just inline elements)

**Breadcrumbs**:
- The remark plugin already attaches annotation metadata to **all overlapping nodes** (including parent containers)
- The position data is preserved and available at every level
- The range intersection logic (`annStart < nodeEnd && annEnd > nodeStart`) already works correctly
- Only need to modify the rehype plugin to process at the appropriate tree level

**Example case to support**:
```markdown
This is the first paragraph with an annotation that starts here...

...and continues into the second paragraph.
```

If annotation spans from "annotation" in first paragraph to "paragraph" in second, we need to wrap both `<p>` elements.

### Other Future Work

- Nested annotation handling (annotation within annotation)
- Performance optimization for documents with thousands of annotations
- Collaborative editing with real-time annotation updates
