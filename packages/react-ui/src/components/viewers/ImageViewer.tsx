interface ImageViewerProps {
  imageUrl: string;
  mimeType: string;
  alt?: string;
}

export function ImageViewer({ imageUrl, alt = 'Resource image' }: ImageViewerProps) {
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
