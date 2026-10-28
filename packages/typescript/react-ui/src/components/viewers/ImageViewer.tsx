interface ImageViewerProps {
  imageUrl: string;
  mimeType: string;
  alt: string;
}

export function ImageViewer({ imageUrl, alt }: ImageViewerProps) {
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
