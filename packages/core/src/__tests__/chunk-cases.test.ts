/**
 * The chunker, held to specs/src/text/chunk-cases.json: the table every
 * worker's chunker runs, so that a text is cut the same way whoever cuts it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_CHUNKING_CONFIG, chunkText, cutChunk, estimateTokens, type ChunkingConfig } from '../chunking';
import { textOffsets } from '../text-offsets';

interface Cut {
  at: number;
  piece: string;
  next: number;
}

interface Case {
  why: string;
  text: string;
  estimatedTokens: number;
  chunking: ChunkingConfig;
  chunks: string[];
  cuts: Cut[];
}

const table: { defaults: ChunkingConfig; cases: Case[] } = JSON.parse(
  readFileSync(new URL('../../../../specs/src/text/chunk-cases.json', import.meta.url), 'utf8'),
);

describe('the chunker (specs/src/text/chunk-cases.json)', () => {
  it('has cases', () => {
    expect(table.cases.length).toBeGreaterThan(0);
  });

  it('chunks by the table\'s defaults when no chunking is given', () => {
    expect(DEFAULT_CHUNKING_CONFIG).toStrictEqual(table.defaults);
  });

  for (const { why, text, estimatedTokens, chunking, chunks, cuts } of table.cases) {
    it(why, () => {
      expect(estimateTokens(text), 'estimatedTokens').toBe(estimatedTokens);
      expect(chunkText(text, chunking), 'chunks').toStrictEqual(chunks);
      for (const { at, piece, next } of cuts) {
        expect(cutChunk(text, textOffsets(text), at, chunking), `the cut at ${at}`).toStrictEqual({ piece, next });
      }
    });
  }
});
