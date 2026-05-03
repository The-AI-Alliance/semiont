'use client';

import { useMemo } from 'react';
import type { Ref } from 'react';
import type { Annotation } from '@semiont/core';
import { getAnnotationExactText } from '@semiont/core';
import { getTagCategory, getTagSchemaId } from '@semiont/ontology';
import { useSemiont } from '../../../session/SemiontProvider';
import { useObservable } from '../../../hooks/useObservable';
import { useHoverEmitter } from '../../../hooks/useHoverEmitter';

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

  // Resolve the schema's display name from the per-KB tag-schema registry.
  // The registry is runtime-populated (frame.addTagSchema); during the
  // initial fetch the observable yields `undefined`, which we treat as
  // "no schema name available yet" — render the category badge alone
  // until the registry resolves.
  const tagSchemas$ = useMemo(
    () => session?.client.browse.tagSchemas() ?? null,
    [session],
  );
  const schemas = useObservable(tagSchemas$);
  const schema = schemaId && schemas ? schemas.find((s) => s.id === schemaId) ?? null : null;

  return (
    <div
      ref={ref}
      onClick={() => {
        session?.client.browse.click(tag.id, tag.motivation);
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
