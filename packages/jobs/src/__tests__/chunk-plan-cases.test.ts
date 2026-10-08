/**
 * How the worker plans the pieces of a text, held to
 * specs/src/worker/chunk-plan-cases.json: the table every worker runs, so that
 * one text under one budget is asked about in the same pieces, and a failed
 * piece is retried the same way, whichever language planned it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { UnitCursor } from '@semiont/core';
import { StructuredReadError, type InferenceLimits } from '@semiont/inference';
import { DeterministicJobError } from '../failure-class';
import {
  callChunkSubdividing,
  deriveDetectionBudget,
  runAdaptiveChunks,
  YieldCollapseError,
  type AdaptiveChunk,
  type ChunkCallResult,
  type DetectionBudget,
  type UnderReportedPiece,
} from '../workers/detection/detection-chunking';
import {
  DEFAULT_CHUNK_SIZING_POLICY,
  nextChunkSize,
  type CallOutcome,
  type ChunkSizingPolicy,
  type SizingBounds,
} from '../workers/detection/chunk-size-controller';
import { InferenceTimeoutError } from '../workers/inference-call';

interface Budget {
  size: number;
  overlap: number;
  floor: number;
  ceiling: number;
  outputBudget: number;
}

interface Outcome {
  sizeFailed: boolean;
  outputTokens?: number;
}

interface FailureDescription {
  name: string;
  stopReason?: string;
  salvage?: string[];
  verdict?: UnderReportedPiece;
}

interface BudgetCase {
  kind: 'budget';
  why: string;
  limits: InferenceLimits;
  scaffoldTokens: number;
  typesPerCall: number;
  budget?: Budget;
  refused?: true;
}

interface StepCase {
  kind: 'step';
  why: string;
  size: number;
  outcome: Outcome;
  bounds: SizingBounds;
  nextSize: number;
}

interface WalkCase {
  kind: 'walk';
  why: string;
  text: string;
  budget: Budget;
  resume?: UnitCursor;
  outcomes: Array<Outcome | { fails: true }>;
  pieces: Array<{ at: number; to: number; size: number; next: number }>;
  completes: boolean;
}

type Reply = { items: string[]; outputTokens?: number; counted?: number } | { fails: FailureDescription };

interface DescentResult {
  items: string[];
  sizeFailed: boolean;
  outputTokens?: number;
  counted: number[];
  underReported: UnderReportedPiece[];
}

interface DescentCase {
  kind: 'descent';
  why: string;
  piece: string;
  size: number;
  overlap: number;
  replies: Reply[];
  asked: Array<[number, number]>;
  result?: DescentResult;
  raises?: number;
}

type Case = BudgetCase | StepCase | WalkCase | DescentCase;

const table: { sizing: ChunkSizingPolicy; cases: Case[] } = JSON.parse(
  readFileSync(new URL('../../../../specs/src/worker/chunk-plan-cases.json', import.meta.url), 'utf8'),
);

/** A budget as the table states one, in the shape the worker carries it. */
function toDetectionBudget(budget: Budget): DetectionBudget {
  return {
    chunking: { chunkSize: budget.size, overlap: budget.overlap },
    outputBudget: budget.outputBudget,
    bounds: { floor: budget.floor, ceiling: budget.ceiling, outputBudget: budget.outputBudget },
  };
}

/** An outcome as the table states one, in the shape the worker carries it. */
function toCallOutcome(outcome: Outcome): CallOutcome {
  return {
    truncated: outcome.sizeFailed,
    ...(outcome.outputTokens !== undefined ? { outputTokens: outcome.outputTokens } : {}),
  };
}

/** The failure a reply scripts: the worker's own failure of the kind the table names. */
function failureOf(described: FailureDescription): Error {
  switch (described.name) {
    case 'InferenceTimeoutError':
      return new InferenceTimeoutError('scripted by the table');
    case 'DeterministicJobError':
      return new DeterministicJobError('scripted by the table');
    case 'StructuredReadError':
      if (described.stopReason === undefined) throw new Error('the table scripts a StructuredReadError with no stop reason');
      return new StructuredReadError('scripted by the table', described.stopReason);
    case 'YieldCollapseError':
      if (described.salvage === undefined || described.verdict === undefined) {
        throw new Error('the table scripts a YieldCollapseError without its salvage and verdict');
      }
      return new YieldCollapseError('scripted by the table', described.salvage, described.verdict);
    case 'Error':
      return new Error('scripted by the table');
    default:
      throw new Error(`the table scripts a failure this runner cannot raise: ${described.name}`);
  }
}

function runBudget(c: BudgetCase): void {
  const derive = () => deriveDetectionBudget(c.limits, c.scaffoldTokens, c.typesPerCall);
  if (c.refused === true) {
    expect(derive).toThrow();
    return;
  }
  const derived = derive();
  expect({
    size: derived.chunking.chunkSize,
    overlap: derived.chunking.overlap,
    floor: derived.bounds.floor,
    ceiling: derived.bounds.ceiling,
    outputBudget: derived.outputBudget,
  }).toEqual(c.budget);
  // One output budget: the one a call is given is the one its use is measured against.
  expect(derived.bounds.outputBudget).toBe(derived.outputBudget);
}

function runStep(c: StepCase): void {
  expect(nextChunkSize(toCallOutcome(c.outcome), c.size, c.bounds)).toBe(c.nextSize);
}

async function runWalk(c: WalkCase): Promise<void> {
  const handed: AdaptiveChunk[] = [];
  const failure = new Error('the piece fails, as the table scripts');
  let answered = 0;
  const walk = runAdaptiveChunks(
    c.text,
    toDetectionBudget(c.budget),
    async (chunk) => {
      handed.push(chunk);
      const scripted = c.outcomes[answered];
      answered += 1;
      if (scripted === undefined) throw new Error('the walk cut more pieces than the table scripts outcomes for');
      if ('fails' in scripted) throw failure;
      return toCallOutcome(scripted);
    },
    c.resume,
  );

  if (c.completes) await walk;
  else await expect(walk).rejects.toBe(failure);

  expect(handed).toEqual(
    c.pieces.map(({ at, to, size, next }) => ({ piece: c.text.slice(at, to), size, at, next, totalChars: c.text.length })),
  );
  expect(answered).toBe(c.outcomes.length);
}

async function runDescent(c: DescentCase): Promise<void> {
  const failures = c.replies.map((reply) => ('fails' in reply ? failureOf(reply.fails) : undefined));
  const asked: string[] = [];
  const counted: number[] = [];
  const underReported: UnderReportedPiece[] = [];

  const descent = callChunkSubdividing<string>(
    'case',
    c.piece,
    { chunkSize: c.size, overlap: c.overlap },
    async (piece): Promise<ChunkCallResult<string>> => {
      const call = asked.length;
      asked.push(piece);
      const reply = c.replies[call];
      if (reply === undefined) throw new Error('the descent made more calls than the table scripts replies for');
      if ('fails' in reply) throw failures[call];
      return {
        items: reply.items,
        // The provider's count of what it was sent is not scripted: nothing in a plan reads it.
        ...(reply.outputTokens !== undefined ? { usage: { inputTokens: 0, outputTokens: reply.outputTokens } } : {}),
        ...(reply.counted !== undefined ? { counted: reply.counted } : {}),
      };
    },
    undefined,
    (verdict) => { underReported.push(verdict); },
    (count) => { counted.push(count); },
  );

  if (c.raises !== undefined) {
    const raised = failures[c.raises];
    if (raised === undefined) throw new Error('the table says the descent raises a reply that scripts no failure');
    await expect(descent).rejects.toBe(raised);
  } else {
    const { items, outcome } = await descent;
    expect({
      items,
      sizeFailed: outcome.truncated,
      ...(outcome.outputTokens !== undefined ? { outputTokens: outcome.outputTokens } : {}),
      counted,
      underReported,
    }).toEqual(c.result);
  }

  expect(asked).toEqual(c.asked.map(([from, to]) => c.piece.slice(from, to)));
  expect(asked.length).toBe(c.replies.length);
}

describe('planning the pieces of a text (specs/src/worker/chunk-plan-cases.json)', () => {
  it('has cases of every kind to run', () => {
    for (const kind of ['budget', 'step', 'walk', 'descent']) {
      expect(table.cases.filter((c) => c.kind === kind).length, kind).toBeGreaterThan(0);
    }
  });

  it('states the sizing the worker steps by', () => {
    expect(table.sizing).toEqual(DEFAULT_CHUNK_SIZING_POLICY);
  });

  for (const c of table.cases) {
    it(`${c.kind}: ${c.why}`, async () => {
      switch (c.kind) {
        case 'budget': return runBudget(c);
        case 'step': return runStep(c);
        case 'walk': return runWalk(c);
        case 'descent': return runDescent(c);
      }
    });
  }
});
