import type { ResourceUri } from '@semiont/core';

interface ImageViewerProps {
  resourceUri: ResourceUri;
  mimeType: string;
  alt?: string;
}

export function ImageViewer({ resourceUri, alt = 'Resource image' }: ImageViewerProps) {
  // Extract resource ID from W3C canonical URI (last segment of path)
  const resourceId = resourceUri.split('/').pop();

  // Use Next.js API route proxy instead of direct backend call
  // This allows us to add authentication headers which <img> tags can't send
  const imageUrl = `/api/resources/${resourceId}`;

  return (
    <div className="semiont-image-viewer">
      <img
        src={imageUrl}
        alt={alt}
        className="semiont-image-viewer__image"
        style={{ imageRendering: 'auto' }}
      />
    </div>
  );
}
