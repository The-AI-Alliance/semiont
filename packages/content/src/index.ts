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

// MIME Extensions
export {
  getExtensionForMimeType,
  hasKnownExtension,
  deriveStorageUri,
} from './mime-extensions';

// Checksum utilities
export {
  calculateChecksum,
  verifyChecksum
} from './checksum';

// PDF text-layer extraction
export { extractPdfTextLayer } from './extract-pdf-text-layer';
export { locate } from './locate';
export type {
  PdfTextLayer,
  PdfTextItem,
  PdfPageInfo,
} from './pdf-text-layer';
