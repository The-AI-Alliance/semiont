'use client';

import React, { useEffect, useRef } from 'react';
import type { components } from '@semiont/api-client';
import { getAnnotationExactText } from '@semiont/api-client';
import { getTagCategory, getTagSchemaId } from '@semiont/ontology';
import { getTagSchema } from '../../../lib/tag-schemas';

type Annotation = components['schemas']['Annotation'];

interface TagEntryProps {
  tag: Annotation;
  isFocused: boolean;
  onClick: () => void;
  onTagRef: (tagId: string, el: HTMLElement | null) => void;
  onTagHover?: (tagId: string | null) => void;
}

export function TagEntry({
  tag,
  isFocused,
  onClick,
  onTagRef,
  onTagHover,
}: TagEntryProps) {
  const tagRef = useRef<HTMLDivElement>(null);

  // Register ref with parent
  useEffect(() => {
    onTagRef(tag.id, tagRef.current);
    return () => {
      onTagRef(tag.id, null);
    };
  }, [tag.id, onTagRef]);

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
      onClick={onClick}
      onMouseEnter={() => onTagHover?.(tag.id)}
      onMouseLeave={() => onTagHover?.(null)}
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
