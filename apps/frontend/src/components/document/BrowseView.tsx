'use client';

import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import { remarkAnnotations } from '@/lib/remark-annotations';
import { rehypeRenderAnnotations } from '@/lib/rehype-render-annotations';
import type { Annotation } from '@/contexts/DocumentAnnotationsContext';
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
    .filter(ann => ann.selectionData)
    .map(ann => ({
      id: ann.id,
      text: ann.selectionData!.text,
      offset: ann.selectionData!.offset,
      length: ann.selectionData!.length,
      type: ann.type as 'highlight' | 'reference'
    }));
}

export function BrowseView({
  content,
  highlights,
  references,
  onAnnotationClick
}: Props) {
  const { newAnnotationIds } = useDocumentAnnotations();

  const allAnnotations = useMemo(() =>
    [...highlights, ...references],
    [highlights, references]
  );

  const preparedAnnotations = useMemo(() =>
    prepareAnnotations(allAnnotations),
    [allAnnotations]
  );

  return (
    <div className="prose prose-lg dark:prose-invert max-w-none p-4">
      <ReactMarkdown
        remarkPlugins={[
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