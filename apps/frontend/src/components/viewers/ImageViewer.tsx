import React from 'react';
import type { ResourceUri } from '@semiont/api-client';
import { NEXT_PUBLIC_API_URL } from '../../lib/env';

interface ImageViewerProps {
  resourceUri: ResourceUri;
  mimeType: string;
  alt?: string;
}

export function ImageViewer({ resourceUri, mimeType, alt = 'Resource image' }: ImageViewerProps) {
  // Extract resource ID from W3C canonical URI (last segment of path)
  const resourceId = resourceUri.split('/').pop();

  // Construct backend API URL for content negotiation
  // Browser's <img> tag automatically sends Accept: image/* header
  const backendUrl = `${NEXT_PUBLIC_API_URL}/resources/${resourceId}`;

  return (
    <div className="w-full h-full flex items-center justify-center bg-gray-50 dark:bg-gray-900">
      <img
        src={backendUrl}
        alt={alt}
        className="max-w-full max-h-full object-contain"
        style={{ imageRendering: 'auto' }}
      />
    </div>
  );
}
