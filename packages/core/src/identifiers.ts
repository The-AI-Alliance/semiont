/**
 * The kinds of id: `ResourceId`, `AnnotationId`, `JobId` and `UserId`.
 *
 * Each is a type of its own, so one kind is not taken for another, and each
 * is made by one constructor that holds text to the kind's rule. Types and
 * constructors are generated from the spec (specs/src/identifiers/kinds.json
 * and each kind's schema, by scripts/spec/generate-identifiers.mjs): the
 * rule is stated there, once, for every SDK and for the gateway.
 *
 * A constructor stands where text enters: a URL, a DOM attribute, a script's
 * argument. What the gateway answers is typed already and is not checked
 * again here.
 */
import { resourceId } from './generated/identifiers';

export type { AnnotationId, JobId, ResourceId, UserId } from './generated/identifiers';
export { annotationId, jobId, resourceId, userId } from './generated/identifiers';

/**
 * The scope a system event is logged under — a fact about the knowledge base
 * rather than about any resource: the entity-type and tag-schema vocabulary,
 * and who the people in the record are.
 *
 * Typed as a `ResourceId` because that is how it is USED. The event log is
 * keyed by resource and this is the key system events take: `getEvents` takes
 * it, `appendEvent` falls back to it when an event names no resource, sharding
 * skips it, and the projections it produces live in a directory named after
 * it (`projections/__system__/`). Being a branded string it also passes
 * straight to `path.join`, so the one constant covers both readings — the same
 * way a resource's own projections live under its own id.
 *
 * **Tests that pin the on-disk layout keep the literal, deliberately.** They
 * are the gate on this value: production code says `SYSTEM_SCOPE` so that
 * nothing spells it a seventeenth time, and a test asserting
 * `events/__system__/` fails if the constant is ever changed — which it must,
 * because every deployed knowledge base has that directory on disk.
 */
export const SYSTEM_SCOPE = resourceId('__system__');
