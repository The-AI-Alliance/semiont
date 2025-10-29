'use client';

import React from 'react';

interface ResourceTagsInlineProps {
  documentId: string;
  tags: string[];
  isEditing: boolean;
  onUpdate: (tags: string[]) => Promise<void>;
  disabled?: boolean;
}

export function ResourceTagsInline({
  documentId,
  tags,
  isEditing,
  onUpdate,
  disabled = false
}: ResourceTagsInlineProps) {
  // If no tags, don't show anything
  if (tags.length === 0) {
    return null;
  }

  return (
    <div className="px-6 py-2 border-t border-gray-200 dark:border-gray-700">
      <div className="flex flex-wrap items-center gap-2">
        {/* Display existing tags */}
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 px-2 py-1 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 rounded text-xs"
          >
            {tag}
          </span>
        ))}
      </div>
    </div>
  );
}