/**
 * @semiont/content
 *
 * Reading a resource's bytes from the Archivist.
 */

// Reading a resource's bytes: the contract every reader declares, the way it
// fails, and the implementation that reaches the Archivist.
export {
  archivistContentReads,
  RepresentationMissing,
  type ContentReads,
  type MissingReason,
} from './representation-reads';
