/**
 * @semiont/content
 *
 * Working tree storage for project resources.
 */

// Working Tree Store
export {
  WorkingTreeStore,
  ChecksumMismatchError,
  type StoredResource,
} from './working-tree-store';

// Storage URI derivation (extensions come from @semiont/core's media-type registry)
export { deriveStorageUri } from './storage-uri';

// Checksum utilities
export {
  calculateChecksum,
  verifyChecksum
} from './checksum';

// Strategy-keyed text extraction for embedding (SMELTER-MEDIA-TYPES)
export {
  EXTRACTORS,
  type ContentExtractor,
  type ExtractedText,
  type ExtractionDecline,
} from './content-extractor';

// PDF text-layer extraction. The anchoring vocabulary these produce
// (AnchoredText, PdfTextItem) and the locate/textUnder pair that reads it are
// exported from @semiont/core — pure, and needed by the browser canvas too.
export { extractPdfTextLayer } from './extract-pdf-text-layer';
export type {
  PdfTextLayer,
  PdfPageInfo,
  PdfFormField,
} from './pdf-text-layer';
