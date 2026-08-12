/**
 * `@semiont/vectors/testing` — test doubles for the vector surface.
 *
 * Not part of the runtime surface; consumers import it from their test suites.
 * Published as a subpath (the `@semiont/core/testing` pattern) because
 * MANDATORY-EMBEDDING makes an `EmbeddingProvider` required at every
 * KnowledgeBase / Gatherer / Matcher construction site — so every consumer's
 * tests need a double, and a copy per package is the redundancy the house rules
 * forbid. Previously this lived in `src/__tests__/`, which
 * `tsconfig.build.json` excludes, so nothing outside this package could reach it.
 */

import type { EmbeddingProvider } from './embedding/interface';

/**
 * Mock EmbeddingProvider for testing.
 * Returns deterministic vectors derived from the input text
 * so cosine similarity results are predictable.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  private dims: number;
  private modelName: string;

  constructor(dimensions = 768, modelName = 'mock') {
    this.dims = dimensions;
    this.modelName = modelName;
  }

  async embed(text: string): Promise<number[]> {
    return this.deterministicVector(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(t => this.deterministicVector(t));
  }

  dimensions(): number {
    return this.dims;
  }

  model(): string {
    return this.modelName;
  }

  /**
   * Generate a reproducible vector from text.
   * Same text always produces the same vector.
   * Similar texts produce somewhat similar vectors (not guaranteed).
   */
  private deterministicVector(text: string): number[] {
    const vec = new Array(this.dims);
    for (let i = 0; i < this.dims; i++) {
      const charCode = text.charCodeAt(i % text.length) || 0;
      vec[i] = Math.sin(charCode + i * 0.1) * 0.5;
    }
    // Normalize
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < this.dims; i++) {
        vec[i] /= norm;
      }
    }
    return vec;
  }
}
