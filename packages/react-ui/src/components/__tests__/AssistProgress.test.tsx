/**
 * AssistProgress (#7) — the ONE job-progress renderer, unifying the three
 * previous shapes (AssistSection's inline block, AnnotateReferencesProgressWidget,
 * TaggingPanel's inline block) plus the resource-generate flow.
 *
 * Contract: presentational and provider-free — no SemiontProvider, no session;
 * cancel/dismiss arrive as callbacks the caller wires (job.cancelRequest /
 * mark.dismissProgress). Feature blocks are data-presence-driven so each call
 * site keeps its current visuals by passing what it always had.
 *
 * i18n contract (ASSIST-SURFACE-WARTS Lane A): every string this component
 * renders comes from `translations`. There are NO English fallbacks — a
 * missing key must be a type error at the call site, not a silent English
 * leak in a Japanese UI. Tests use key-echo strings ('tr.complete') so an
 * assertion failing means "rendered something other than what was passed".
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import type { components } from '@semiont/core';
import { AssistProgress, type AssistProgressTranslations } from '../AssistProgress';

type JobProgress = components['schemas']['JobProgress'];

describe('AssistProgress', () => {
  // Trimmed by P3 (2026-08-12). Five tests were DELETED rather than adapted
  // because they pinned surfaces this phase removes, and each has a successor
  // in the P3 block below:
  //   • paramsTitle copy          → H1 (the label is gone; the line is conditional)
  //   • "title header only when given one" → A2 (the section header is the title)
  //   • "cancel in the header / hidden once complete" → A3 ×2 (one control)
  //   • "stage branching"          → A8 + A3-ended (D7: no producer emits a
  //                                  terminal stage; terminality is a prop)
  //   • "percentage bar only when opted in" → A4 (a bar follows the data, not a flag)
  // What survives here is what P3 does NOT change.

  it('renders provider-free — no session, no context, no providers', () => {
    // The embeddable contract: this must render standalone. If it ever reaches
    // for a provider, this throws rather than silently degrading.
    const { container } = render(
      <AssistProgress progress={detecting()} dataType="reference" translations={T3()} />,
    );
    expect(container.querySelector('.semiont-assist-progress')).toBeInTheDocument();
    expect(container.querySelector('[data-type="reference"]')).toBeInTheDocument();
  });

  it('renders the completed entity-type log when data + formatter are present', () => {
    render(
      <AssistProgress
        progress={detecting({
          completedEntityTypes: [{ entityType: 'Person', foundCount: 3 }],
        })}
        dataType="reference"
        translations={T3()}
      />,
    );
    expect(screen.getByText('Person:')).toBeInTheDocument();
    expect(screen.getByText('tr.found(3)')).toBeInTheDocument();
  });

  it('omits the entity-type log when the formatter is absent (non-reference flows)', () => {
    const tr = T3();
    delete (tr as Partial<AssistProgressTranslations>).found;
    render(
      <AssistProgress
        progress={detecting({ completedEntityTypes: [{ entityType: 'Person', foundCount: 3 }] })}
        dataType="comment"
        translations={tr}
      />,
    );
    expect(screen.queryByText('Person:')).toBeNull();
  });

  it('the control takes its accessible name from translations, per lifecycle', () => {
    const { rerender } = render(
      <AssistProgress
        progress={detecting()} dataType="reference"
        onCancel={vi.fn()} onDismiss={vi.fn()} translations={T3()}
      />,
    );
    expect(screen.getByLabelText('tr.cancel')).toBeInTheDocument();

    rerender(
      <AssistProgress
        progress={detecting()} dataType="reference" ended
        onCancel={vi.fn()} onDismiss={vi.fn()} translations={T3()}
      />,
    );
    expect(screen.getByLabelText('tr.close')).toBeInTheDocument();
  });

  it('offers no control at all when the caller wires neither callback', () => {
    render(<AssistProgress progress={detecting()} dataType="reference" translations={T3()} />);
    expect(screen.queryByTestId('semiont-assist-control')).toBeNull();
  });

  it('falls back to the generic in-progress copy when no code has arrived', () => {
    // `JobProgress.message` is optional: a pure liveness heartbeat carries none.
    const noCode = { percentage: 5 } as JobProgress;
    render(<AssistProgress progress={noCode} dataType="comment" translations={T3()} />);
    expect(screen.getByTestId('semiont-assist-status').textContent).toBe('tr.inProgress');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ASSIST-PROGRESS-CONSOLIDATION P3 — the RED wave (A1-A5, A8).
//
// These assert STRUCTURE, never copy: H3 set the wording ("Marking…", subject
// beneath) and it will be revised from use. A test pinned to a sentence rots on
// the first edit and teaches the next reader to weaken it.
// ─────────────────────────────────────────────────────────────────────────────
const STATUS = 'semiont-assist-status';
const SUBJECT = 'semiont-assist-subject';
const CONTROL = 'semiont-assist-control';
const BAR = 'semiont-assist-bar';
const PARAMS = 'semiont-assist-params';

/** Post-P3 translations: one function for the coded copy, plus structure keys. */
const T3 = (over: Partial<AssistProgressTranslations> = {}): AssistProgressTranslations =>
  ({
    cancel: 'tr.cancel',
    close: 'tr.close',
    inProgress: 'tr.inProgress',
    message: (m: any) => `tr.code(${m.code})`,
    subject: (label: string, done?: number, total?: number) =>
      done === undefined ? `tr.subject(${label})` : `tr.subject(${label}|${done}/${total})`,
    found: (n: number) => `tr.found(${n})`,
    ...over,
  }) as AssistProgressTranslations;

const detecting = (over: Partial<JobProgress> = {}): JobProgress =>
  ({
    percentage: 40,
    message: { code: 'detecting-entities', entityType: 'Person' },
    currentEntityType: 'Person',
    processedEntityTypes: 1,
    totalEntityTypes: 3,
    ...over,
  }) as JobProgress;

describe('AssistProgress — P3 consolidation', () => {
  it('A1: renders the subject exactly once for one progress event', () => {
    // Defect 1: the status line and the detail line both called
    // `currentLabel(currentEntityType)`. Post-P1 they produce the IDENTICAL
    // string, which is why two tests here had to use getAllByText. Singular
    // `getByText` throws on multiple matches — that IS the assertion.
    render(<AssistProgress progress={detecting()} dataType="reference" translations={T3()} />);

    expect(screen.getByText(/tr\.subject\(Person/)).toBeInTheDocument();
    // And the status line is the CODE's copy, not a second copy of the subject.
    expect(screen.getByTestId(STATUS).textContent).toContain('tr.code(detecting-entities)');
    expect(screen.getByTestId(STATUS).textContent).not.toContain('tr.subject');
  });

  it('A2: renders no heading of its own — the section header is the title', () => {
    const { container } = render(
      <AssistProgress progress={detecting()} dataType="reference" translations={T3()} />,
    );
    expect(container.querySelector('h1,h2,h3,h4,h5,h6')).toBeNull();
  });

  it('A3: offers exactly one control, and it means cancel while running', async () => {
    const onCancel = vi.fn();
    const onDismiss = vi.fn();
    render(
      <AssistProgress
        progress={detecting()} dataType="reference"
        onCancel={onCancel} onDismiss={onDismiss} translations={T3()}
      />,
    );
    const controls = screen.getAllByTestId(CONTROL);
    expect(controls).toHaveLength(1);

    await userEvent.click(controls[0]!);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('A3: the same single control means dismiss once the run has ENDED', async () => {
    // D7: terminality is the owner's fact, arriving as a prop. The component
    // never reads `progress.stage` — no producer emits a terminal stage.
    const onCancel = vi.fn();
    const onDismiss = vi.fn();
    render(
      <AssistProgress
        progress={detecting({ message: { code: 'complete-created', count: 7, kind: 'reference' } } as any)}
        dataType="reference" ended
        onCancel={onCancel} onDismiss={onDismiss} translations={T3()}
      />,
    );
    const controls = screen.getAllByTestId(CONTROL);
    expect(controls).toHaveLength(1);

    await userEvent.click(controls[0]!);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('A4: the REFERENCE flow renders a fraction and a bar — data it already receives', () => {
    render(<AssistProgress progress={detecting()} dataType="reference" translations={T3()} />);

    expect(screen.getByTestId(SUBJECT).textContent).toBe('tr.subject(Person|1/3)');
    expect(screen.getByTestId(BAR)).toBeInTheDocument();
  });

  it('A4: the TAG flow keeps its fraction and bar from the same fields', () => {
    render(
      <AssistProgress
        progress={{
          percentage: 50,
          message: { code: 'creating-tag-annotations', count: 4 },
          currentCategory: 'Rule', processedCategories: 2, totalCategories: 5,
        } as JobProgress}
        dataType="tag" translations={T3()}
      />,
    );
    expect(screen.getByTestId(SUBJECT).textContent).toBe('tr.subject(Rule|2/5)');
    expect(screen.getByTestId(BAR)).toBeInTheDocument();
  });

  it('A4: no bar when there is nothing to fill it', () => {
    render(
      <AssistProgress
        progress={{ percentage: 10, message: { code: 'loading' } } as JobProgress}
        dataType="comment" translations={T3()}
      />,
    );
    expect(screen.queryByTestId(BAR)).toBeNull();
  });

  it('A5: every rendered string is traceable to translations', () => {
    const { container } = render(
      <AssistProgress progress={detecting()} dataType="reference" translations={T3()} />,
    );
    // Key-echo strings mean any text NOT starting `tr.` came from the component.
    const stray = Array.from(container.querySelectorAll('*'))
      .filter((el) => el.children.length === 0)
      .map((el) => el.textContent?.trim() ?? '')
      .filter((t) => t.length > 0 && !t.startsWith('tr.') && !/^[\s✨✅✓×✕()0-9/of]+$/.test(t));
    expect(stray).toEqual([]);
  });

  it('A8: renders no failure UI of its own — job:fail owns that surface', () => {
    // Revised by D7. `stage: 'error'` has no producer anywhere in the repo;
    // failure reaches the user through useOutcomeToasts' job:fail handler.
    // The widget must not resurrect a branch for a state it never sees.
    render(
      <AssistProgress
        progress={detecting({ stage: 'error' } as Partial<JobProgress>)}
        dataType="reference" translations={T3()}
      />,
    );
    // Still the ordinary running render — no special-cased error text.
    expect(screen.getByTestId(STATUS).textContent).toContain('tr.code(detecting-entities)');
  });

  it('H1: the params line appears only when it adds information', () => {
    // The discriminator is the COUNT, not the copy — splitting a localized
    // string on commas to decide whether to show it would be its own defect.
    const oneType = detecting({
      requestParams: [{ label: 'Entity types', value: 'Person' }],
      totalEntityTypes: 1,
    });
    const { unmount } = render(
      <AssistProgress progress={oneType} dataType="reference" translations={T3()} />,
    );
    expect(screen.queryByTestId(PARAMS)).toBeNull();
    unmount();

    const many = detecting({
      requestParams: [{ label: 'Entity types', value: 'Person, Organization, Location' }],
      totalEntityTypes: 3,
    });
    render(<AssistProgress progress={many} dataType="reference" translations={T3()} />);
    expect(screen.getByTestId(PARAMS)).toBeInTheDocument();
  });
});
