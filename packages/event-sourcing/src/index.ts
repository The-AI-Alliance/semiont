/**
 * @semiont/event-sourcing
 *
 * What a reader of the Archivist's record needs:
 * - ViewStorage: reading a resource's materialized view from the state tree
 * - annotationIdFor: the content-addressed id an annotation is recorded under
 */

export {
  type ViewStorage,
  type ResourceView,
  FilesystemViewStorage,
} from './storage/view-storage';

export { annotationIdFor, type AnnotationIdentity } from './identifier-utils';
