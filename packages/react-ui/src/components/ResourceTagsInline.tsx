'use client';

interface ResourceTagsInlineProps {
  documentId: string;
  tags: string[];
  isEditing: boolean;
  onUpdate: (tags: string[]) => Promise<void>;
  disabled?: boolean;
}

export function ResourceTagsInline({
  tags
}: ResourceTagsInlineProps) {
  // If no tags, don't show anything
  if (tags.length === 0) {
    return null;
  }

  return (
    <div className="semiont-resource-tags-inline">
      <div className="semiont-resource-tags-list">
        {/* Display existing tags */}
        {tags.map((tag) => (
          <span
            key={tag}
            className="semiont-resource-tag"
          >
            {tag}
          </span>
        ))}
      </div>
    </div>
  );
}