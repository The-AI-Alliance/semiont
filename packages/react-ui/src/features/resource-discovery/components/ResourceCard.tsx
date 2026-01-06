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
    className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer transition-all hover:shadow-md group focus:outline-none focus:ring-2 focus:ring-cyan-500/50 dark:focus:ring-cyan-400/50"
  >
    <div className="flex justify-between items-start mb-2">
      <h4 className="font-medium text-gray-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
        {resource.name}
      </h4>
      {resource.archived && (
        <span className="px-2 py-1 text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded">
          {archivedLabel}
        </span>
      )}
    </div>

    {/* Resource Metadata */}
    <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-500">
      <span>{createdLabel} {resource.dateCreated ? new Date(resource.dateCreated).toLocaleDateString() : 'N/A'}</span>
      {resource.entityTypes && resource.entityTypes.length > 0 && (
        <div className="flex gap-1">
          {resource.entityTypes.slice(0, 2).map((type) => (
            <span
              key={type}
              className="px-2 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded"
            >
              {type}
            </span>
          ))}
          {resource.entityTypes.length > 2 && (
            <span className="px-2 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded">
              +{resource.entityTypes.length - 2}
            </span>
          )}
        </div>
      )}
    </div>
  </div>
));

ResourceCard.displayName = 'ResourceCard';
