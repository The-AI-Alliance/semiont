'use client';

import type { Ref } from 'react';
import type { components } from '@semiont/core';
import { annotationId as toAnnotationId } from '@semiont/core';
import { getAnnotationExactText } from '@semiont/api-client';
import { getTagCategory, getTagSchemaId } from '@semiont/ontology';
import { getTagSchema } from '../../../lib/tag-schemas';
import { useSemiont } from '../../../session/SemiontProvider';
import { useObservable } from '../../../hooks/useObservable';
import { useHoverEmitter } from '../../../hooks/useHoverEmitter';

type Annotation = components['schemas']['Annotation'];

interface TagEntryProps {
  tag: Annotation;
  isFocused: boolean;
  isHovered?: boolean;
  ref?: Ref<HTMLDivElement>;
}

export function TagEntry({
  tag,
  isFocused,
  isHovered = false,
  ref,
}: TagEntryProps) {
  const session = useObservable(useSemiont().activeSession$);
  const hoverProps = useHoverEmitter(tag.id);

  const selectedText = getAnnotationExactText(tag);
  const category = getTagCategory(tag);
  const schemaId = getTagSchemaId(tag);
  const schema = schemaId ? getTagSchema(schemaId) : null;

  return (
    <div
      ref={ref}
      onClick={() => {
        session?.client.browse.click(toAnnotationId(tag.id), tag.motivation);
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
      {tag.generator && (
        <div className="semiont-annotation-entry__metadata">
          Via {typeof tag.generator === 'string' ? tag.generator : tag.generator.name}
        </div>
      )}
    </div>
  );
}
