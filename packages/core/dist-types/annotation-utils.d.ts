/**
 * Annotation body utilities
 *
 * These are the matcher primitives used by the `mark:body-updated` event
 * replay path (ViewMaterializer and Weaver) to apply add/remove/
 * replace operations against an annotation body.
 */
import type { components } from './types';
import type { Annotation } from './annotation-types';
type BodyPurpose = components['schemas']['BodyPurpose'];
/**
 * Identity of a body item for matching purposes.
 *
 * Identity is `type + source` for SpecificResource and `type + value` for
 * TextualBody. `purpose` is OPTIONAL: if the caller provides it, it's
 * included in the match (used to disambiguate same-source bodies under
 * different purposes, per the W3C Web Annotation model). If the caller
 * omits it, the matcher ignores purpose and matches on identity alone.
 *
 * Callers SHOULD provide `purpose` when they know it (e.g., the bind flow
 * always unlinks a `purpose: 'linking'` body) so that future multi-purpose
 * annotations continue to disambiguate correctly. Leaving `purpose`
 * unspecified matches whichever purpose comes first in the body — which is
 * fine today because Semiont annotations currently have at most one body
 * item per (type, source/value) pair.
 */
export type BodyItemIdentity = {
    type: 'SpecificResource';
    source: string;
    purpose?: BodyPurpose;
} | {
    type: 'TextualBody';
    value: string;
    purpose?: BodyPurpose;
};
/**
 * Find a body item by identity. Returns the index of the first match, or -1.
 *
 * See `BodyItemIdentity` for matching semantics.
 */
export declare function findBodyItem(body: Annotation['body'], identity: BodyItemIdentity): number;
export {};
