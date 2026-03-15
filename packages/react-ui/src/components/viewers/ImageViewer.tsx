import type { ResourceId } from '@semiont/core';

interface ImageViewerProps {
  resourceUri: ResourceId;
  mimeType: string;
  alt?: string;
}

export function ImageViewer({ resourceUri, alt = 'Resource image' }: ImageViewerProps) {
  // Use Next.js API route proxy instead of direct backend call
  // This allows us to add authentication headers which <img> tags can't send
  const imageUrl = `/api/resources/${resourceUri}`;

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
