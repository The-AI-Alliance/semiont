'use client';

import { useEffect, useRef } from 'react';
import type { components } from '@semiont/api-client';
import { getAnnotationExactText } from '@semiont/api-client';
import { getTagCategory, getTagSchemaId } from '@semiont/ontology';
import { getTagSchema } from '../../../lib/tag-schemas';
import { useEventBus } from '../../../contexts/EventBusContext';

type Annotation = components['schemas']['Annotation'];

interface TagEntryProps {
  tag: Annotation;
  isFocused: boolean;
}

export function TagEntry({
  tag,
  isFocused,
}: TagEntryProps) {
  const eventBus = useEventBus();
  const tagRef = useRef<HTMLDivElement>(null);

  // Register ref with parent via event
  useEffect(() => {
    eventBus.emit('annotation:ref-update', {
      annotationId: tag.id,
      element: tagRef.current
    });
    return () => {
      eventBus.emit('annotation:ref-update', {
        annotationId: tag.id,
        element: null
      });
    };
  }, [tag.id]);

  // Scroll to tag when focused
  useEffect(() => {
    if (isFocused && tagRef.current) {
      tagRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [isFocused]);

  const selectedText = getAnnotationExactText(tag);
  const category = getTagCategory(tag);
  const schemaId = getTagSchemaId(tag);
  const schema = schemaId ? getTagSchema(schemaId) : null;

  return (
    <div
      ref={tagRef}
      onClick={() => {
        eventBus.emit('annotation:click', { annotationId: tag.id, motivation: tag.motivation });
      }}
      onMouseEnter={() => {
        eventBus.emit('annotation-entry:hover', { annotationId: tag.id });
      }}
      onMouseLeave={() => {
        eventBus.emit('annotation-entry:hover', { annotationId: null });
      }}
      className="semiont-annotation-entry"
      data-type="tag"
      data-focused={isFocused ? 'true' : 'false'}
    >
      {/* Category badge */}
      <div className="semiont-annotation-entry__header">
        <span className="semiont-tag-badge" data-variant="tag">
          {category}
        </span>
        {schema && (
          <span className="semiont-annotation-entry__meta">
            {schema.name}
          </span>
        )}
      </div>

      {/* Selected text */}
      <div className="semiont-annotation-entry__quote" data-type="tag">
        "{selectedText.substring(0, 150)}{selectedText.length > 150 ? '...' : ''}"
      </div>
    </div>
  );
}
