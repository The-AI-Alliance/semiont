'use client';

import React, { useMemo, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkAnnotations, type PreparedAnnotation } from '@/lib/remark-annotations';
import { rehypeRenderAnnotations } from '@/lib/rehype-render-annotations';
import type { components } from '@semiont/api-client';
import { getExactText, getTextPositionSelector, isReference, isStubReference, getTargetSelector, getBodySource, getMimeCategory, type MimeCategory } from '@semiont/api-client';
import { getAnnotationInternalType, getAnnotationTypeMetadata } from '@/lib/annotation-registry';
import { ImageViewer } from '@/components/viewers';

type Annotation = components['schemas']['Annotation'];
import { useResourceAnnotations } from '@/contexts/ResourceAnnotationsContext';
import '@/styles/animations.css';

interface Props {
  content: string;
  mimeType: string;
  resourceUri: string;
  highlights: Annotation[];
  references: Annotation[];
  assessments: Annotation[];
  comments: Annotation[];
  onAnnotationClick?: (annotation: Annotation) => void;
  onAnnotationHover?: (annotationId: string | null) => void;
  onCommentHover?: (commentId: string | null) => void;
  hoveredAnnotationId?: string | null;
  hoveredCommentId?: string | null;
  onWikiLinkClick?: (pageName: string) => void;
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
  highlights,
  references,
  assessments,
  comments,
  onAnnotationClick,
  onAnnotationHover,
  onCommentHover,
  hoveredAnnotationId,
  hoveredCommentId
}: Props) {
  const { newAnnotationIds } = useResourceAnnotations();
  const containerRef = useRef<HTMLDivElement>(null);

  const category = getMimeCategory(mimeType);

  const allAnnotations = useMemo(() =>
    [...highlights, ...references, ...assessments, ...comments],
    [highlights, references, assessments, comments]
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
      const metadata = annotation ? getAnnotationTypeMetadata(annotation) : null;

      // Route to side panel if annotation type has one
      if (metadata?.hasSidePanel && onCommentHover) {
        onCommentHover(annotationId);
        return;
      }
    }
    if (onAnnotationHover) {
      onAnnotationHover(annotationId);
    }
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
        <div ref={containerRef} className="prose prose-lg dark:prose-invert max-w-none p-4">
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
      );

    case 'image':
      return (
        <div ref={containerRef} className="w-full h-full">
          <ImageViewer
            resourceUri={resourceUri as any}
            mimeType={mimeType}
            alt="Resource content"
          />
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