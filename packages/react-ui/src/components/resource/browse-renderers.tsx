'use client';

import { lazy, Suspense, memo, type ComponentType } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Annotation } from '@semiont/core';
import type { SemiontSession } from '@semiont/sdk';
import { SvgDrawingCanvas } from '../image-annotation/SvgDrawingCanvas';

// Lazy-load the PDF component to avoid SSR issues with browser PDF.js loading.
const PdfAnnotationCanvas = lazy(() => import('../pdf-annotation/PdfAnnotationCanvas.client').then(mod => ({ default: mod.PdfAnnotationCanvas })));

/**
 * Common props for a read-only ("browse") media renderer. `content` is decoded
 * text for the text renderer, or a media URL for the image / PDF renderers.
 * A consumer can implement this interface to swap in a custom renderer.
 */
export interface MediaRendererProps {
  content: string;
  mimeType: string;
  resourceUri: string;
  annotations: Annotation[];
  /**
   * Session for interaction routing inside annotation-bearing renderers — the
   * canvases emit clicks/hover via `session.client.browse/beckon`. Absent/null
   * → the annotations still PAINT, but are inert (paint-only). Threaded by
   * BrowseView's dispatch; custom renderers may ignore it.
   */
  session?: SemiontSession | null;
}

/** Read-only media dispatch, keyed by the registry render mode. */
export type BrowseMediaRenderers = Partial<Record<string, ComponentType<MediaRendererProps>>>;

const MemoizedMarkdown = memo(function MemoizedMarkdown({ content }: { content: string }) {
  // No annotation plugins: annotations are applied as a DOM overlay after paint.
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>;
});

export function TextBrowseRenderer({ content }: MediaRendererProps) {
  return <MemoizedMarkdown content={content} />;
}

export function ImageBrowseRenderer({ content, resourceUri, annotations, session }: MediaRendererProps) {
  // The annotate-mode canvas, read-only (drawingMode=null): paints SvgSelector
  // shapes over the image and routes click/hover via the session — the same
  // shapes browse mode silently dropped when this was a bare ImageViewer
  // (bugs/image-browse-renderer-drops-annotations.md).
  return (
    <SvgDrawingCanvas
      imageUrl={content}
      resourceUri={resourceUri}
      existingAnnotations={annotations}
      drawingMode={null}
      selectedMotivation={null}
      session={session}
    />
  );
}

export function PdfBrowseRenderer({ content, resourceUri, annotations, session }: MediaRendererProps) {
  return (
    <Suspense fallback={<div className="semiont-browse-view__loading">Loading PDF viewer...</div>}>
      <PdfAnnotationCanvas
        pdfUrl={content}
        resourceUri={resourceUri}
        existingAnnotations={annotations}
        drawingMode={null}
        selectedMotivation={null}
        session={session}
      />
    </Suspense>
  );
}

/**
 * Default read-only media renderers. `BrowseView` merges a caller's `renderers`
 * override on top of these, so a host can swap one renderer (e.g. its own PDF
 * viewer) or add a mode without forking the view.
 */
export const defaultBrowseRenderers: Record<'text' | 'image' | 'pdf', ComponentType<MediaRendererProps>> = {
  text: TextBrowseRenderer,
  image: ImageBrowseRenderer,
  pdf: PdfBrowseRenderer,
};
