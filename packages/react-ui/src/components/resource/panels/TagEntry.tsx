'use client';

import { forwardRef } from 'react';
import type { components } from '@semiont/core';
import { getAnnotationExactText } from '@semiont/api-client';
import { getTagCategory, getTagSchemaId } from '@semiont/ontology';
import { getTagSchema } from '../../../lib/tag-schemas';
import { useEventBus } from '../../../contexts/EventBusContext';
import { useHoverEmitter } from '../../../hooks/useAttentionFlow';

type Annotation = components['schemas']['Annotation'];

interface TagEntryProps {
  tag: Annotation;
  isFocused: boolean;
  isHovered?: boolean;
}

export const TagEntry = forwardRef<HTMLDivElement, TagEntryProps>(
  function TagEntry(
    {
      tag,
      isFocused,
      isHovered = false,
    },
    ref
  ) {
  const eventBus = useEventBus();
  const hoverProps = useHoverEmitter(tag.id);

  const selectedText = getAnnotationExactText(tag);
  const category = getTagCategory(tag);
  const schemaId = getTagSchemaId(tag);
  const schema = schemaId ? getTagSchema(schemaId) : null;

  return (
    <div
      ref={ref}
      onClick={() => {
        eventBus.get('annotation:click').next({ annotationId: tag.id, motivation: tag.motivation });
      }}
      {...hoverProps}
      className={`semiont-annotation-entry${isHovered ? ' semiont-annotation-pulse' : ''}`}
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
});
