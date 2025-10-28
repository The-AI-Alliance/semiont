'use client';

import React, { useMemo, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkAnnotations, type PreparedAnnotation } from '@/lib/remark-annotations';
import { rehypeRenderAnnotations } from '@/lib/rehype-render-annotations';
import type { components } from '@semiont/api-client';
import { getExactText, getTextPositionSelector, isReference, isStubReference, getTargetSelector, getBodySource } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];
import { useDocumentAnnotations } from '@/contexts/DocumentAnnotationsContext';
import '@/styles/animations.css';

interface Props {
  content: string;
  highlights: Annotation[];
  references: Annotation[];
  onAnnotationClick?: (annotation: Annotation) => void;
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
      // Use W3C motivation to determine type
      let type: 'highlight' | 'reference' | 'assessment';
      if (ann.motivation === 'assessing') {
        type = 'assessment';
      } else if (isReference(ann)) {
        type = 'reference';
      } else {
        type = 'highlight';
      }
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
  highlights,
  references,
  onAnnotationClick
}: Props) {
  const { newAnnotationIds } = useDocumentAnnotations();
  const containerRef = useRef<HTMLDivElement>(null);

  const allAnnotations = useMemo(() =>
    [...highlights, ...references],
    [highlights, references]
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

  // Attach click handlers and animations after render
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

    const clickHandlers: Array<{ element: Element; handler: EventListener }> = [];

    annotationSpans.forEach((span) => {
      const annotationType = span.getAttribute('data-annotation-type');
      if (annotationType === 'reference') {
        span.addEventListener('click', handleClick);
        clickHandlers.push({ element: span, handler: handleClick });
      }
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
    };
  }, [content, allAnnotations, onAnnotationClick, annotationMap, newAnnotationIds]);

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
}