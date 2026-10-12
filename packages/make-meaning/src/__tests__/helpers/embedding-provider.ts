/**
 * The embedding provider these suites hand an actor: the published double
 * (`@semiont/vectors/testing`), whose vector is a pure function of the text.
 * No model is called.
 */

import type { EmbeddingProvider } from '@semiont/vectors';
import { MockEmbeddingProvider } from '@semiont/vectors/testing';

/** The dimension of every vector in these suites: small, so fixtures stay readable. */
const EMBEDDING_DIMENSIONS = 4;

export function createMockEmbeddingProvider(): EmbeddingProvider {
  return new MockEmbeddingProvider(EMBEDDING_DIMENSIONS);
}
