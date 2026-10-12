/**
 * The estimate of a text's tokens, held to specs/src/text/chunk-cases.json:
 * the table every chunker runs. Each case states its text's
 * `estimatedTokens`, the count a chunk is sized by.
 *
 * This package cuts no text, so it runs the part it has: the estimate. The
 * cuts and the chunks are run by the chunkers, in apps/worker and
 * apps/smelter.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { estimateTokens } from '../token-estimate';

interface Case {
  why: string;
  text: string;
  estimatedTokens: number;
}

const table: { cases: Case[] } = JSON.parse(
  readFileSync(new URL('../../../../specs/src/text/chunk-cases.json', import.meta.url), 'utf8'),
);

describe("a text's estimated tokens (specs/src/text/chunk-cases.json)", () => {
  it('has cases', () => {
    expect(table.cases.length).toBeGreaterThan(0);
  });

  for (const { why, text, estimatedTokens } of table.cases) {
    it(why, () => {
      expect(estimateTokens(text)).toBe(estimatedTokens);
    });
  }
});
