'use client';

import React, { useEffect, useRef } from 'react';
import type { components } from '@semiont/api-client';
import { getAnnotationExactText, getTagCategory, getTagSchemaId } from '@semiont/api-client';
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
      className={`
        group relative p-4 rounded-lg border-2 transition-all duration-200 cursor-pointer
        ${isFocused
          ? 'border-orange-500 bg-orange-50 dark:border-orange-500 dark:bg-orange-900/20 shadow-lg'
          : 'border-gray-200 dark:border-gray-700 hover:border-orange-300 dark:hover:border-orange-600 hover:bg-orange-50/50 dark:hover:bg-orange-900/10'
        }
      `}
    >
      {/* Category badge */}
      <div className="flex items-center gap-2 mb-2">
        <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-gradient-to-r from-orange-200 to-amber-200 text-gray-900 dark:from-orange-900/50 dark:to-amber-900/50 dark:text-white">
          {category}
        </span>
        {schema && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {schema.name}
          </span>
        )}
      </div>

      {/* Selected text */}
      <div className="text-sm text-gray-700 dark:text-gray-300 italic border-l-2 border-orange-300 dark:border-orange-600 pl-3">
        "{selectedText.substring(0, 150)}{selectedText.length > 150 ? '...' : ''}"
      </div>
    </div>
  );
}
