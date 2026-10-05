/**
 * `@semiont/vectors/testing` — test doubles for the vector surface.
 *
 * Not part of the runtime surface; consumers import it from their test suites.
 * Published as a subpath (the `@semiont/core/testing` pattern) because an
 * `EmbeddingProvider` is required at every KnowledgeBase / Gatherer / Matcher
 * construction site — so every consumer's tests need a double, and one
 * published double is the alternative to a hand-written copy per package,
 * which drifts. It sits outside `src/__tests__/` because `tsconfig.build.json`
 * excludes that directory, which nothing outside this package can reach.
 */

import type { EmbeddingProvider } from './embedding/interface';

/**
 * The vector `MockEmbeddingProvider` returns for `text` at `dimensions`:
 * reproducible and normalized. Exported so a test can state the vector it
 * expects without calling the provider it is asserting on.
 */
export function deterministicVector(text: string, dimensions: number): number[] {
  const vec = new Array<number>(dimensions);
  for (let i = 0; i < dimensions; i++) {
    const charCode = text.charCodeAt(i % text.length) || 0;
    vec[i] = Math.sin(charCode + i * 0.1) * 0.5;
  }
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  return norm > 0 ? vec.map((v) => v / norm) : vec;
}

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
    return deterministicVector(text, this.dims);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(t => deterministicVector(t, this.dims));
  }

  async dimensions(): Promise<number> {
    return this.dims;
  }

  model(): string {
    return this.modelName;
  }
}
