import type { ResourceId } from '@semiont/core';
import { useApiClient } from '../../contexts/ApiClientContext';

interface ImageViewerProps {
  resourceUri: ResourceId;
  mimeType: string;
  alt?: string;
}

export function ImageViewer({ resourceUri, alt = 'Resource image' }: ImageViewerProps) {
  const { baseUrl } = useApiClient();
  const imageUrl = `${baseUrl}/resources/${resourceUri}`;

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
