import { describe, it, expect, vi } from 'vitest';
import { createVectorStore } from '../factory';

describe('createVectorStore', () => {
  it('makes no store from the type a test alone uses, and asks the embedding provider nothing', async () => {
    const dimensions = vi.fn(async () => 768);

    await expect(createVectorStore({ type: 'memory', dimensions })).rejects.toThrow('Unsupported vector store type: memory');
    expect(dimensions).not.toHaveBeenCalled();
  });
});
