/**
 * DETECTION-RESULT-STREAMING P4, frontend half (RD5): the progress surface
 * shows found-of-~expected when the count-verifier has priced a denominator.
 *
 * The wire's absence discipline carries through to the render, in both
 * directions: `entitiesExpected` ABSENT means "no claim" (no verifying
 * provider, or nothing priced yet) — no tally renders and no denominator is
 * ever manufactured. `entitiesFound: 0` PRESENT is a real count — "0 of ~37"
 * is information, not an error state. And per Lane A, the copy comes from a
 * caller-supplied translator: no translator, no line, no English fallback.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { components } from '@semiont/core';
import { AssistProgress, type AssistProgressTranslations } from '../AssistProgress';

type JobProgress = components['schemas']['JobProgress'];

const TALLY = 'semiont-assist-tally';

const T = (over: Partial<AssistProgressTranslations> = {}): AssistProgressTranslations =>
  ({
    cancel: 'tr.cancel',
    close: 'tr.close',
    inProgress: 'tr.inProgress',
    message: (m: any) => `tr.code(${m.code})`,
    subject: (c: { kind: string; value: string }) => `tr.subject(${c.kind}:${c.value})`,
    paramLabel: (code: string) => `tr.param(${code})`,
    tally: (found: number, expected: number) => `tr.tally(${found}/${expected})`,
    ...over,
  }) as AssistProgressTranslations;

const detecting = (over: Partial<JobProgress> = {}): JobProgress =>
  ({
    percentage: 40,
    message: { code: 'detecting-entities', entityType: 'Person' },
    ...over,
  }) as JobProgress;

describe('AssistProgress — the denominator tally (RD5)', () => {
  it('renders found of ~expected when the wire prices both', () => {
    render(
      <AssistProgress ended={false} dataType="reference" translations={T()}
        progress={detecting({ entitiesFound: 7, entitiesExpected: 37 })}
      />,
    );
    expect(screen.getByTestId(TALLY)).toHaveTextContent('tr.tally(7/37)');
  });

  it('renders NO tally when entitiesExpected is absent — a denominator is never manufactured', () => {
    render(
      <AssistProgress ended={false} dataType="reference" translations={T()}
        progress={detecting({ entitiesFound: 7 })}
      />,
    );
    expect(screen.queryByTestId(TALLY)).not.toBeInTheDocument();
  });

  it('zero found is a real count, not absence: renders 0 of ~expected', () => {
    render(
      <AssistProgress ended={false} dataType="reference" translations={T()}
        progress={detecting({ entitiesFound: 0, entitiesExpected: 37 })}
      />,
    );
    expect(screen.getByTestId(TALLY)).toHaveTextContent('tr.tally(0/37)');
  });

  it('no tally translator, no line — flows without the copy render nothing (Lane A)', () => {
    render(
      <AssistProgress ended={false} dataType="highlight"
        translations={T({ tally: undefined })}
        progress={detecting({ entitiesFound: 7, entitiesExpected: 37 })}
      />,
    );
    expect(screen.queryByTestId(TALLY)).not.toBeInTheDocument();
  });
});
