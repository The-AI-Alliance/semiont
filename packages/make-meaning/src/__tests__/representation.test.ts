/**
 * The ONE reading of where a descriptor says a resource's bytes are.
 *
 * Copies of this decision disagree: about "what type is this when the record
 * doesn't say", and about which field holds the URI. A reader that resolves
 * through a field the Archivist does not write finds no bytes for any
 * resource. `representations[].storageUri` is the URI's one home.
 */

import { describe, it, expect } from 'vitest';
import type { ResourceDescriptor } from '@semiont/core';
import { representationSource } from '../representation';

const URI = 'file://docs/note.md';

describe('representationSource — the one decision', () => {
  it('reads URI and mediaType together from the primary representation — the one home', () => {
    // The URI lives where the bytes' other facts live. No descriptor-level
    // field, so no URI/mediaType mismatch case and no fallback for it.
    const resource = {
      representations: [{ mediaType: 'text/markdown', checksum: 'abc', storageUri: URI }],
    } as unknown as ResourceDescriptor;

    expect(representationSource(resource)).toEqual({ storageUri: URI, mediaType: 'text/markdown' });
  });

  it('is null when the primary representation carries no URI — the has-content signal, not an error', () => {
    expect(representationSource({ representations: [{ mediaType: 'text/plain' }] } as unknown as ResourceDescriptor)).toBeNull();
    expect(representationSource({ representations: [] } as unknown as ResourceDescriptor)).toBeNull();
    expect(representationSource(undefined)).toBeNull();
  });
});
