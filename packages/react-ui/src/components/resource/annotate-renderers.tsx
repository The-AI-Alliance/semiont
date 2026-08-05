'use client';

import { lazy, Suspense, type ComponentType } from 'react';
import type { Annotation } from '@semiont/core';
import type { SemiontSession } from '@semiont/sdk';
import { SvgDrawingCanvas } from '../image-annotation/SvgDrawingCanvas';
import { CodeMirrorRenderer } from '../CodeMirrorRenderer';
import { segmentTextWithAnnotations } from '../../lib/text-segmentation';
import type { SelectionMotivation, ShapeType } from '../annotation/AnnotateToolbar';
import { useTranslations } from '../../contexts/TranslationContext';

// Lazy-load the PDF component to avoid SSR issues with browser PDF.js loading.
// Kept lazy here deliberately: hoisting it to a static import would make it
// eager again and reintroduce the SSR problem this indirection exists for.
/** The lazy chunk's fallback needs its own component: a hook cannot run
 *  inside a `fallback` prop expression. */
function PdfViewerLoading() {
  const t = useTranslations('PdfViewer');
  return <>{t('viewerLoading')}</>;
}

const PdfAnnotationCanvas = lazy(() =>
  import('../pdf-annotation/PdfAnnotationCanvas.client').then((mod) => ({ default: mod.PdfAnnotationCanvas })),
);

/**
 * Common props for an ANNOTATING media renderer. The read-only sibling is
 * `MediaRendererProps` in `browse-renderers.tsx`; this one additionally
 * carries the active tool, because annotating is an interaction, not a paint.
 *
 * `content` is decoded text for the text renderer, or a media URL for the
 * image / PDF renderers. `annotations` is the FLAT list — a renderer derives
 * whatever shape it needs (the text one segments it), so a custom renderer is
 * never handed a projection only one implementation can use.
 * See .plans/ANNOTATE-RENDERER-REGISTRY.md (D1)
 */
export interface AnnotateMediaRendererProps {
  content: string;
  mimeType: string;
  resourceUri: string;
  annotations: Annotation[];
  /** Session for interaction routing — the canvases emit via `session.client`. */
  session: SemiontSession | null;

  /** Active drawing tool, or null when nothing is selected (read-only paint). */
  drawingMode: ShapeType | null;
  selectedMotivation: SelectionMotivation | null;
  hoveredAnnotationId?: string | null;
  hoverDelayMs?: number;

  // Text-path extras. Optional on the shared interface: a custom image or PDF
  // renderer simply ignores them, the same way `MediaRendererProps.session` is
  // documented to be ignorable.
  newAnnotationIds?: Set<string>;
  scrollToAnnotationId?: string | null;
  showLineNumbers?: boolean;
  enableWidgets?: boolean;
  getTargetResourceName?: (resourceId: string) => string | undefined;
  generatingReferenceId?: string | null;
}

/** Annotating media dispatch, keyed by the registry render mode. */
export type AnnotateMediaRenderers = Partial<Record<string, ComponentType<AnnotateMediaRendererProps>>>;

export function TextAnnotateRenderer({
  content,
  annotations,
  session,
  newAnnotationIds,
  hoveredAnnotationId,
  scrollToAnnotationId,
  showLineNumbers = false,
  hoverDelayMs = 150,
  enableWidgets = false,
  getTargetResourceName,
  generatingReferenceId,
}: AnnotateMediaRendererProps) {
  // D1: segmentation is a text-rendering concern, derived here rather than
  // threaded through the shared interface.
  const segments = segmentTextWithAnnotations(content, annotations);

  return (
    <CodeMirrorRenderer
      content={content}
      segments={segments}
      editable={false}
      newAnnotationIds={newAnnotationIds}
      {...(hoveredAnnotationId !== undefined && { hoveredAnnotationId })}
      {...(scrollToAnnotationId !== undefined && { scrollToAnnotationId })}
      sourceView={true}
      showLineNumbers={showLineNumbers}
      hoverDelayMs={hoverDelayMs}
      enableWidgets={enableWidgets}
      session={session}
      {...(getTargetResourceName && { getTargetResourceName })}
      {...(generatingReferenceId !== undefined && { generatingReferenceId })}
    />
  );
}

export function ImageAnnotateRenderer({
  content,
  resourceUri,
  annotations,
  session,
  drawingMode,
  selectedMotivation,
  hoveredAnnotationId,
  hoverDelayMs = 150,
}: AnnotateMediaRendererProps) {
  if (!content) return null;
  return (
    <SvgDrawingCanvas
      imageUrl={content}
      resourceUri={resourceUri}
      existingAnnotations={annotations}
      drawingMode={drawingMode}
      selectedMotivation={selectedMotivation}
      session={session}
      hoveredAnnotationId={hoveredAnnotationId || null}
      hoverDelayMs={hoverDelayMs}
    />
  );
}

export function PdfAnnotateRenderer({
  content,
  resourceUri,
  annotations,
  session,
  drawingMode,
  selectedMotivation,
  hoveredAnnotationId,
  hoverDelayMs = 150,
}: AnnotateMediaRendererProps) {
  if (!content) return null;
  return (
    <Suspense fallback={<div className="semiont-annotate-view__loading"><PdfViewerLoading /></div>}>
      <PdfAnnotationCanvas
        pdfUrl={content}
        resourceUri={resourceUri}
        existingAnnotations={annotations}
        drawingMode={drawingMode}
        selectedMotivation={selectedMotivation}
        session={session}
        hoveredAnnotationId={hoveredAnnotationId || null}
        hoverDelayMs={hoverDelayMs}
      />
    </Suspense>
  );
}

/**
 * Default annotating media renderers. `AnnotateView` merges a caller's
 * `renderers` override on top of these, so a host can swap one renderer (its
 * own PDF viewer, say) or add a mode without forking the view — the same seam
 * `defaultBrowseRenderers` gives the read-only path.
 */
export const defaultAnnotateRenderers: Record<'text' | 'image' | 'pdf', ComponentType<AnnotateMediaRendererProps>> = {
  text: TextAnnotateRenderer,
  image: ImageAnnotateRenderer,
  pdf: PdfAnnotateRenderer,
};
