import React, { useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/esm/Page/AnnotationLayer.css';
import 'react-pdf/dist/esm/Page/TextLayer.css';
import './PdfViewer.css';

// CRITICAL: Configure PDF.js worker for performance
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.js`;

export interface PdfViewerProps {
  resourceUri: string;
}

export function PdfViewer({ resourceUri }: PdfViewerProps) {
  const [numPages, setNumPages] = useState<number>(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Extract resource ID from URI
  const resourceId = resourceUri.split('/').pop();
  const pdfUrl = `/api/resources/${resourceId}`;

  function onDocumentLoadSuccess({ numPages }: { numPages: number }) {
    setNumPages(numPages);
    setIsLoading(false);
  }

  function onDocumentLoadError(error: Error) {
    console.error('Error loading PDF:', error);
    setError('Failed to load PDF');
    setIsLoading(false);
  }

  if (error) {
    return <div className="semiont-pdf-viewer__error">{error}</div>;
  }

  return (
    <div className="semiont-pdf-viewer">
      {isLoading && <div className="semiont-pdf-viewer__loading">Loading PDF...</div>}

      <Document
        file={pdfUrl}
        onLoadSuccess={onDocumentLoadSuccess}
        onLoadError={onDocumentLoadError}
        loading={<div>Loading PDF...</div>}
      >
        <Page
          pageNumber={pageNumber}
          renderTextLayer={true}
          renderAnnotationLayer={false}
        />
      </Document>

      <div className="semiont-pdf-viewer__controls">
        <button
          disabled={pageNumber <= 1}
          onClick={() => setPageNumber(pageNumber - 1)}
        >
          Previous
        </button>
        <span>
          Page {pageNumber} of {numPages}
        </span>
        <button
          disabled={pageNumber >= numPages}
          onClick={() => setPageNumber(pageNumber + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
