'use client';

import React, { useMemo, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkAnnotations, type PreparedAnnotation } from '@/lib/remark-annotations';
import { rehypeRenderAnnotations } from '@/lib/rehype-render-annotations';
import type { components } from '@semiont/api-client';
import { getExactText, getTextPositionSelector, isReference, isStubReference, getTargetSelector, getBodySource, getMimeCategory, type MimeCategory } from '@semiont/api-client';
import { getAnnotationInternalType, getAnnotator } from '@/lib/annotation-registry';
import { ImageViewer } from '@/components/viewers';
import { AnnotateToolbar, type ClickAction } from '@/components/annotation/AnnotateToolbar';
import type { AnnotationsCollection, AnnotationHandlers } from '@/types/annotation-props';

type Annotation = components['schemas']['Annotation'];
import { useResourceAnnotations } from '@/contexts/ResourceAnnotationsContext';
import '@/styles/animations.css';

interface Props {
  content: string;
  mimeType: string;
  resourceUri: string;
  annotations: AnnotationsCollection;
  handlers?: AnnotationHandlers;
  hoveredAnnotationId?: string | null;
  hoveredCommentId?: string | null;
  selectedClick?: ClickAction;
  onClickChange?: (motivation: ClickAction) => void;
}

/**
 * Convert W3C Annotations to simplified format for remark plugin.
 * Extracts position info and converts start/end to offset/length.
 */
function prepareAnnotations(annotations: Annotation[]): PreparedAnnotation[] {
  return annotations
    .map(ann => {
      const targetSelector = getTargetSelector(ann.target);
      const posSelector = getTextPositionSelector(targetSelector);
      const start = posSelector?.start ?? 0;
      const end = posSelector?.end ?? 0;

      // Use centralized registry to determine type
      const type = getAnnotationInternalType(ann);

      return {
        id: ann.id,
        exact: getExactText(targetSelector),
        offset: start,           // remark plugin expects 'offset'
        length: end - start,      // remark plugin expects 'length', not 'end'
        type,
        source: getBodySource(ann.body)
      };
    });
}

export function BrowseView({
  content,
  mimeType,
  resourceUri,
  annotations,
  handlers,
  hoveredAnnotationId,
  hoveredCommentId,
  selectedClick = 'detail',
  onClickChange
}: Props) {
  const { newAnnotationIds } = useResourceAnnotations();
  const containerRef = useRef<HTMLDivElement>(null);

  const category = getMimeCategory(mimeType);

  const { highlights, references, assessments, comments, tags } = annotations;

  // Extract individual handlers from grouped object
  const onAnnotationClick = handlers?.onClick;
  const onAnnotationHover = handlers?.onHover;
  const onCommentHover = handlers?.onCommentHover;

  const allAnnotations = useMemo(() =>
    [...highlights, ...references, ...assessments, ...comments, ...tags],
    [highlights, references, assessments, comments, tags]
  );

  const preparedAnnotations = useMemo(() =>
    prepareAnnotations(allAnnotations),
    [allAnnotations]
  );

  // Create a map of annotation ID -> full annotation for click handling
  const annotationMap = useMemo(() => {
    const map = new Map<string, Annotation>();
    for (const ann of allAnnotations) {
      map.set(ann.id, ann);
    }
    return map;
  }, [allAnnotations]);

  // Wrapper for annotation hover that routes based on registry metadata
  const handleAnnotationHover = useCallback((annotationId: string | null) => {
    if (annotationId) {
      const annotation = annotationMap.get(annotationId);
      const metadata = annotation ? getAnnotator(annotation) : null;

      // Route to side panel if annotation type has one
      if (metadata?.hasSidePanel) {
        // Clear the other hover state when switching
        if (onAnnotationHover) onAnnotationHover(null);
        if (onCommentHover) onCommentHover(annotationId);
        return;
      } else {
        // Clear the other hover state when switching
        if (onCommentHover) onCommentHover(null);
        if (onAnnotationHover) onAnnotationHover(annotationId);
        return;
      }
    }
    // Clear both when null
    if (onAnnotationHover) onAnnotationHover(null);
    if (onCommentHover) onCommentHover(null);
  }, [annotationMap, onAnnotationHover, onCommentHover]);

  // Attach click handlers, hover handlers, and animations after render
  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;

    // Find all annotation spans
    const annotationSpans = container.querySelectorAll('[data-annotation-id]');

    // Attach click handlers
    const handleClick = (e: Event) => {
      const target = e.currentTarget as HTMLElement;
      const annotationId = target.getAttribute('data-annotation-id');
      const annotationType = target.getAttribute('data-annotation-type');

      if (annotationId && annotationType === 'reference' && onAnnotationClick) {
        const annotation = annotationMap.get(annotationId);
        if (annotation) {
          onAnnotationClick(annotation);
        }
      }
    };

    // Attach hover handlers
    const handleMouseEnter = (e: Event) => {
      const target = e.currentTarget as HTMLElement;
      const annotationId = target.getAttribute('data-annotation-id');
      if (annotationId) {
        handleAnnotationHover(annotationId);
      }
    };

    const handleMouseLeave = () => {
      handleAnnotationHover(null);
    };

    const clickHandlers: Array<{ element: Element; handler: EventListener }> = [];
    const hoverHandlers: Array<{ element: Element; enterHandler: EventListener; leaveHandler: EventListener }> = [];

    annotationSpans.forEach((span) => {
      const annotationType = span.getAttribute('data-annotation-type');
      if (annotationType === 'reference') {
        span.addEventListener('click', handleClick);
        clickHandlers.push({ element: span, handler: handleClick });
      }

      // Add hover handlers for all annotation types
      span.addEventListener('mouseenter', handleMouseEnter);
      span.addEventListener('mouseleave', handleMouseLeave);
      hoverHandlers.push({ element: span, enterHandler: handleMouseEnter, leaveHandler: handleMouseLeave });
    });

    // Apply animation classes to new annotations
    if (newAnnotationIds) {
      annotationSpans.forEach((span) => {
        const annotationId = span.getAttribute('data-annotation-id');
        if (annotationId && newAnnotationIds.has(annotationId)) {
          span.classList.add('annotation-sparkle');
        }
      });
    }

    // Cleanup
    return () => {
      clickHandlers.forEach(({ element, handler }) => {
        element.removeEventListener('click', handler);
      });
      hoverHandlers.forEach(({ element, enterHandler, leaveHandler }) => {
        element.removeEventListener('mouseenter', enterHandler);
        element.removeEventListener('mouseleave', leaveHandler);
      });
    };
  }, [content, allAnnotations, onAnnotationClick, annotationMap, newAnnotationIds, handleAnnotationHover]);

  // Handle hoveredCommentId visual feedback
  useEffect(() => {
    if (!containerRef.current || !hoveredCommentId) return undefined;

    const container = containerRef.current;
    const element = container.querySelector(
      `[data-annotation-id="${CSS.escape(hoveredCommentId)}"]`
    ) as HTMLElement;

    if (element) {
      element.classList.add('annotation-pulse');
      const timeoutId = setTimeout(() => {
        element.classList.remove('annotation-pulse');
      }, 1500);

      return () => {
        clearTimeout(timeoutId);
        element.classList.remove('annotation-pulse');
      };
    }

    return undefined;
  }, [hoveredCommentId]);

  // Route to appropriate viewer based on MIME type category
  switch (category) {
    case 'text':
      return (
        <div className="relative h-full flex flex-col">
          <AnnotateToolbar
            selectedMotivation={null}
            selectedClick={selectedClick}
            onSelectionChange={() => {}}
            onClickChange={onClickChange || (() => {})}
            showSelectionGroup={false}
            showDeleteButton={false}
          />
          <div ref={containerRef} className="flex-1 overflow-auto prose prose-lg dark:prose-invert max-w-none py-4 pr-4 pl-2">
            <ReactMarkdown
              remarkPlugins={[
                remarkGfm,
                [remarkAnnotations, { annotations: preparedAnnotations }]
              ]}
              rehypePlugins={[
                rehypeRenderAnnotations
              ]}
            >
              {content}
            </ReactMarkdown>
          </div>
        </div>
      );

    case 'image':
      return (
        <div className="relative h-full flex flex-col">
          <AnnotateToolbar
            selectedMotivation={null}
            selectedClick={selectedClick}
            onSelectionChange={() => {}}
            onClickChange={onClickChange || (() => {})}
            showSelectionGroup={false}
            showDeleteButton={false}
          />
          <div ref={containerRef} className="flex-1 overflow-auto">
            <ImageViewer
              resourceUri={resourceUri as any}
              mimeType={mimeType}
              alt="Resource content"
            />
          </div>
        </div>
      );

    case 'unsupported':
      return (
        <div ref={containerRef} className="flex items-center justify-center h-full p-8">
          <div className="text-center space-y-4">
            <p className="text-gray-600 dark:text-gray-400">
              Preview not available for {mimeType}
            </p>
            <a
              href={resourceUri}
              download
              className="inline-block px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              Download File
            </a>
          </div>
        </div>
      );
  }
}