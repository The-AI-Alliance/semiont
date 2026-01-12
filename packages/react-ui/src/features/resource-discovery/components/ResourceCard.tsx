/**
 * ResourceCard Component
 *
 * Pure component for displaying a single resource in the discovery grid.
 * Handles keyboard navigation and accessibility.
 */

import React from 'react';
import type { components } from '@semiont/api-client';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

export interface ResourceCardProps {
  resource: ResourceDescriptor;
  onOpen: (resource: ResourceDescriptor) => void;
  tabIndex?: number;
  archivedLabel: string;
  createdLabel: string;
}

export const ResourceCard = React.memo(({
  resource,
  onOpen,
  tabIndex = 0,
  archivedLabel,
  createdLabel
}: ResourceCardProps) => (
  <div
    onClick={() => onOpen(resource)}
    onKeyDown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onOpen(resource);
      }
    }}
    role="button"
    tabIndex={tabIndex}
    aria-label={`Open resource: ${resource.name}`}
    className="semiont-resource-card"
  >
    <div className="semiont-resource-card__header">
      <h4 className="semiont-resource-card__title">
        {resource.name}
      </h4>
      {resource.archived && (
        <span className="semiont-resource-card__badge" data-type="archived">
          {archivedLabel}
        </span>
      )}
    </div>

    {/* Resource Metadata */}
    <div className="semiont-resource-card__metadata">
      <span className="semiont-resource-card__date">{createdLabel} {resource.dateCreated ? new Date(resource.dateCreated).toLocaleDateString() : 'N/A'}</span>
      {resource.entityTypes && resource.entityTypes.length > 0 && (
        <div className="semiont-resource-card__tags">
          {resource.entityTypes.slice(0, 2).map((type) => (
            <span
              key={type}
              className="semiont-resource-card__tag"
            >
              {type}
            </span>
          ))}
          {resource.entityTypes.length > 2 && (
            <span className="semiont-resource-card__tag-more">
              +{resource.entityTypes.length - 2}
            </span>
          )}
        </div>
      )}
    </div>
  </div>
));

ResourceCard.displayName = 'ResourceCard';
