# Old Code to Remove

Once the new AnnotatedRenderer is working properly, the following code can be removed:

## Files to Delete

1. `/apps/frontend/src/components/AnnotatedMarkdownRenderer.tsx` - Old implementation with DOM manipulation issues
2. `/apps/frontend/src/components/AnnotatedMarkdownRendererV2.tsx` - Previous attempt that didn't handle annotations properly
3. `/apps/frontend/src/components/CodeMirrorAnnotatedRenderer.tsx` - CodeMirror attempt that had position tracking issues
4. `/apps/frontend/src/components/AnnotatedRenderer.tsx` - Previous attempt with DOM manipulation errors

## Why These Can Be Removed

- `AnnotatedMarkdownRenderer.tsx`: This was the original implementation that had issues with:
  - Direct DOM manipulation fighting React's rendering
  - Highlights disappearing when state changed
  - Position calculation errors
  - Complex text wrapping logic that was fragile

- `AnnotatedMarkdownRendererV2.tsx`: This was an intermediate attempt that:
  - Tried to segment text for annotations
  - Didn't integrate well with the document page
  - Had issues with position tracking

## New Component

The new `CodeMirrorAnnotatedRenderer.tsx` replaces both of these with:
- CodeMirror for robust position tracking
- Custom rendering for beautiful markdown display
- Support for multiple content types (markdown, code, plain text)
- Clean separation between position tracking and rendering
- Stable highlight rendering that doesn't disappear

## Testing Before Removal

Before removing these files:
1. Test text selection and annotation creation
2. Verify highlights and references display correctly
3. Check that selections don't disappear when UI updates
4. Ensure wiki links work
5. Test right-click context menu on annotations