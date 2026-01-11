/**
 * @semiont/content
 *
 * Content-addressed storage for resource representations.
 * Framework-independent storage with automatic deduplication.
 */

// Representation Store
export {
  FilesystemRepresentationStore,
  type RepresentationStore,
  type RepresentationMetadata,
  type StoredRepresentation
} from './representation-store';

// MIME Extensions
export {
  getExtensionForMimeType,
  hasKnownExtension
} from './mime-extensions';
