'use client';

/**
 * Client-only wrapper for PdfAnnotationCanvas
 *
 * This wrapper ensures the PDF annotation component is only loaded on the client side,
 * preventing SSR issues with browser-based PDF.js loading.
 */

export { PdfAnnotationCanvas } from './PdfAnnotationCanvas';
