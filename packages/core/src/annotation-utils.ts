/**
 * Annotation body utilities
 *
 * These are the matcher primitives used by the `mark:body-updated` event
 * replay path (ViewMaterializer and GraphDBConsumer) to apply add/remove/
 * replace operations against an annotation body.
 */

import type { components } from './types';

type Annotation = components['schemas']['Annotation'];
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
export type BodyItemIdentity =
  | { type: 'SpecificResource'; source: string; purpose?: BodyPurpose }
  | { type: 'TextualBody'; value: string; purpose?: BodyPurpose };

/**
 * Find a body item by identity. Returns the index of the first match, or -1.
 *
 * See `BodyItemIdentity` for matching semantics.
 */
export function findBodyItem(
  body: Annotation['body'],
  identity: BodyItemIdentity,
): number {
  if (!Array.isArray(body)) {
    return -1;
  }

  for (let i = 0; i < body.length; i++) {
    const item = body[i];

    if (typeof item !== 'object' || item === null || !('type' in item)) {
      continue;
    }

    const itemType = (item as { type: unknown }).type;
    if (itemType !== identity.type) {
      continue;
    }

    // Identity field match (source or value)
    if (identity.type === 'SpecificResource') {
      if (!('source' in item)) continue;
      const itemSource = (item as { source: unknown }).source;
      if (itemSource !== identity.source) continue;
    } else {
      if (!('value' in item)) continue;
      const itemValue = (item as { value: unknown }).value;
      if (itemValue !== identity.value) continue;
    }

    // Purpose match — ONLY if the caller specified one. Omitted purpose
    // means "any purpose on this identity", which is what the bind-flow
    // unlinker wants today.
    if (identity.purpose !== undefined) {
      const itemPurpose = (item as { purpose?: unknown }).purpose;
      if (itemPurpose !== identity.purpose) continue;
    }

    return i;
  }

  return -1;
}
