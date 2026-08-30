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
  type ExtractionCache,
} from './content-extractor';

// Extraction byte budget (#1124). Also the generation output bound
// (PDF-GENERATION P5): an artifact we generate must stay within the budget
// our own extractor accepts, or we would mint resources the Smelter
// declines as 'too-large'. One threshold, two enforcement points.
export { MAX_PDF_BYTES, withinByteBudget } from './pdf-extractor';

// Persistent recognition cache (ANCHORED-TEXT-CACHE Lane 2). Derived values
// only — an authored coordinate map is master data and never belongs here.
export {
  createAnchoredTextStore,
  type AnchoredTextStore,
  type CachedAnchoredText,
  type CachedLine,
} from './anchored-text-store';
// The out-of-process half of the same cache: the store contract over
// IContentTransport, for the workers that consult it across the wire (P2c).

// Reading a resource's bytes — the contract every reader declares, the way
// it fails, and the Archivist-backed implementation the fleet uses when it
// holds no KB mount (SINGLE-KB-MOUNT P4).
export {
  archivistContentReads,
  RepresentationMissing,
  type ContentReads,
  type MissingReason,
} from './representation-reads';

// PDF text-layer extraction. The anchoring vocabulary these produce
// (AnchoredText, PdfTextItem) and the locate/textUnder pair that reads it are
// exported from @semiont/core — pure, and needed by the browser canvas too.
export { extractPdfTextLayer } from './extract-pdf-text-layer';
export type {
  PdfTextLayer,
  PdfPageInfo,
  PdfFormField,
} from './pdf-text-layer';
