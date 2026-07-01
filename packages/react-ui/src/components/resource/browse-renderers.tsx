'use client';

import { lazy, Suspense, memo, type ComponentType } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Annotation } from '@semiont/core';
import { ImageViewer } from '../viewers';

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

export function ImageBrowseRenderer({ content, mimeType }: MediaRendererProps) {
  return <ImageViewer imageUrl={content} mimeType={mimeType} alt="Resource content" />;
}

export function PdfBrowseRenderer({ content, annotations }: MediaRendererProps) {
  return (
    <Suspense fallback={<div className="semiont-browse-view__loading">Loading PDF viewer...</div>}>
      <PdfAnnotationCanvas
        pdfUrl={content}
        existingAnnotations={annotations}
        drawingMode={null}
        selectedMotivation={null}
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
