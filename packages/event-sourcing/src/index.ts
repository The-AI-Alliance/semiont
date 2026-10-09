/**
 * @semiont/event-sourcing
 *
 * What a reader of the Archivist's record needs:
 * - ViewStorage: reading a resource's materialized view from the state tree
 */

export {
  type ViewStorage,
  type ResourceView,
  FilesystemViewStorage,
} from './storage/view-storage';
