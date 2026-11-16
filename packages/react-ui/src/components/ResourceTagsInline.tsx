'use client';

import { useState } from 'react';

interface ResourceTagsInlineProps {
  resourceId: string;
  tags: string[];
  isEditing: boolean;
  /**
   * Commit: called ONCE per edit with the FULL new tag set (the host diffs —
   * its SDK call takes `(current, updated)`). Awaited; the editor renders
   * inert while the returned promise is pending.
   */
  onUpdate: (tags: string[]) => Promise<void>;
  disabled?: boolean;
  /**
   * The KB's registered entity types — the CONTROLLED VOCABULARY, host-supplied
   * (the component is session-less; hosts fetch via `browse.entityTypes()`).
   * Adds are a picker constrained to it: no free-text minting. Without it the
   * editor is REMOVAL-ONLY (it cannot offer valid candidates). Removal is never
   * vocabulary-gated — stale/unregistered tags must stay removable.
   */
  vocabulary?: string[];
}

export function ResourceTagsInline({
  tags,
  isEditing,
  onUpdate,
  disabled = false,
  vocabulary,
}: ResourceTagsInlineProps) {
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);

  // Browse mode: exactly the historical read-only rendering (null when empty).
  if (!isEditing) {
    if (tags.length === 0) {
      return null;
    }
    return (
      <div className="semiont-resource-tags-inline">
        <div className="semiont-resource-tags-list">
          {tags.map((tag) => (
            <span key={tag} className="semiont-resource-tag">
              {tag}
            </span>
          ))}
        </div>
      </div>
    );
  }

  // Edit mode: the empty strip still renders — tagging an UNTAGGED resource is
  // the primary case; the null short-circuit is browse-only.
  const inert = disabled || busy;
  const candidates = (vocabulary ?? []).filter((v) => !tags.includes(v));

  const commit = async (next: string[]) => {
    if (inert) return; // in-flight or host-disabled: block further commits
    setBusy(true);
    try {
      await onUpdate(next);
    } finally {
      setBusy(false);
      setPicking(false);
    }
  };

  return (
    <div className="semiont-resource-tags-inline semiont-resource-tags-inline--editing">
      <div className="semiont-resource-tags-list">
        {tags.map((tag) => (
          <span key={tag} className="semiont-resource-tag semiont-resource-tag--editable">
            {tag}
            <button
              type="button"
              className="semiont-resource-tag__remove"
              aria-label={`Remove ${tag}`}
              disabled={inert}
              onClick={() => void commit(tags.filter((t) => t !== tag))}
            >
              ✕
            </button>
          </span>
        ))}
        {vocabulary && (
          <button
            type="button"
            className="semiont-resource-tag semiont-resource-tag--add"
            aria-label="Add tag"
            aria-expanded={picking}
            disabled={inert || candidates.length === 0}
            onClick={() => setPicking((v) => !v)}
          >
            +
          </button>
        )}
      </div>
      {picking && candidates.length > 0 && (
        <div className="semiont-form__entity-type-buttons">
          {candidates.map((entityType) => (
            <button
              key={entityType}
              type="button"
              className="semiont-form__entity-type-button"
              disabled={inert}
              onClick={() => void commit([...tags, entityType])}
            >
              {entityType}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
