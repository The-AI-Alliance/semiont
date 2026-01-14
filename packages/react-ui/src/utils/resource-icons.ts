/**
 * Utility for getting icons for resources based on their type or content
 */

import { DocumentTextIcon } from '@heroicons/react/24/outline';
import type { ComponentType } from 'react';

/**
 * Get the appropriate icon for a resource
 * @param resource - The resource object
 * @returns The icon component
 */
export function getResourceIcon(resource: any): ComponentType<{ className?: string }> {
  // For now, return a default icon
  // TODO: Implement logic to return different icons based on resource type
  return DocumentTextIcon;
}