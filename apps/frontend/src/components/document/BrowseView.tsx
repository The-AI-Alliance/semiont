'use client';

import React, { useMemo, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkAnnotations } from '@/lib/remark-annotations';
import { rehypeRenderAnnotations } from '@/lib/rehype-render-annotations';
import type { Annotation } from '@/lib/api';
import { getExactText, getTextPositionSelector, isReference, isStubReference } from '@/lib/api';
import { useDocumentAnnotations } from '@/contexts/DocumentAnnotationsContext';
import '@/styles/animations.css';

interface Props {
  content: string;
  highlights: Annotation[];
  references: Annotation[];
  onAnnotationClick?: (annotation: Annotation) => void;
  onWikiLinkClick?: (pageName: string) => void;
}

// Convert Annotation[] to the simpler format needed by plugins
function prepareAnnotations(annotations: Annotation[]) {
  return annotations
    .filter(ann => ann.target.selector)
    .map(ann => {
      const posSelector = getTextPositionSelector(ann.target.selector);
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
        exact: getExactText(ann.target.selector),
        offset: posSelector?.offset ?? 0,
        length: posSelector?.length ?? 0,
        type,
        source: ann.body.source
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