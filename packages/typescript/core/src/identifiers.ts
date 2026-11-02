/**
 * The kinds of id: `ResourceId`, `AnnotationId`, `JobId` and `UserId`.
 *
 * Each is a type of its own, so one kind is not taken for another, and each
 * is made by one constructor that holds text to the kind's rule. Its guard
 * (`isResourceId`) asks the same of text without throwing. Types and
 * constructors are generated from the spec (specs/src/identifiers/kinds.json
 * and each kind's schema, by packages/codegen/schemas/generate-identifiers.mjs): the
 * rule is stated there, once, for every SDK and for the gateway.
 *
 * A constructor stands where text enters: a URL, a DOM attribute, a script's
 * argument. What the gateway answers is typed already and is not checked
 * again here.
 */

export type { AnnotationId, JobId, ResourceId, UserId } from './generated/identifiers';
export {
  annotationId,
  isAnnotationId,
  isJobId,
  isResourceId,
  isUserId,
  jobId,
  resourceId,
  userId,
} from './generated/identifiers';
