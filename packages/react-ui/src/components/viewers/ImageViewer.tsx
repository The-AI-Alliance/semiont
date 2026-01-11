import React from 'react';
import type { ResourceUri } from '@semiont/api-client';

interface ImageViewerProps {
  resourceUri: ResourceUri;
  mimeType: string;
  alt?: string;
}

export function ImageViewer({ resourceUri, mimeType, alt = 'Resource image' }: ImageViewerProps) {
  // Extract resource ID from W3C canonical URI (last segment of path)
  const resourceId = resourceUri.split('/').pop();

  // Use Next.js API route proxy instead of direct backend call
  // This allows us to add authentication headers which <img> tags can't send
  const imageUrl = `/api/resources/${resourceId}`;

  return (
    <div className="w-full h-full flex items-center justify-center bg-gray-50 dark:bg-gray-900">
      <img
        src={imageUrl}
        alt={alt}
        className="max-w-full max-h-full object-contain"
        style={{ imageRendering: 'auto' }}
      />
    </div>
  );
}
