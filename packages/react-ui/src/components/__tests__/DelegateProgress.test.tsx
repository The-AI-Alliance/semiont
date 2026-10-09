/**
 * DelegateProgress — the ONE job-progress renderer, for every delegate section and
 * the resource-generate flow.
 *
 * Contract: presentational and provider-free — no SemiontProvider, no session;
 * cancel/dismiss arrive as callbacks the caller wires (job.cancelByType /
 * mark.dismissProgress). Feature blocks are data-presence-driven: a call
 * site gets a block by passing the data for it.
 *
 * i18n contract: every string this component
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
import { DelegateProgress, type DelegateProgressTranslations } from '../DelegateProgress';

type JobProgress = components['schemas']['JobProgress'];
type JobProgressMessage = components['schemas']['JobProgressMessage'];

describe('DelegateProgress', () => {
  it('renders provider-free — no session, no context, no providers', () => {
    // The embeddable contract: this must render standalone. If it ever reaches
    // for a provider, this throws rather than silently degrading.
    const { container } = render(
      <DelegateProgress ended={false} progress={detecting()} dataType="reference" translations={T3()} />,
    );
    expect(container.querySelector('.semiont-delegate-progress')).toBeInTheDocument();
    expect(container.querySelector('[data-type="reference"]')).toBeInTheDocument();
  });

  it('renders the completed entity-type log when data + formatter are present', () => {
    render(
      <DelegateProgress ended={false}
        progress={detecting({
          completedItems: [{ value: 'Person', foundCount: 3 }],
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
    delete (tr as Partial<DelegateProgressTranslations>).found;
    render(
      <DelegateProgress
        progress={detecting({ completedItems: [{ value: 'Person', foundCount: 3 }] })}
        dataType="comment"
        ended={false}
        translations={tr}
      />,
    );
    expect(screen.queryByText('Person:')).toBeNull();
  });

  it('the control takes its accessible name from translations, per lifecycle', () => {
    const { rerender } = render(
      <DelegateProgress ended={false}
        progress={detecting()} dataType="reference"
        onCancel={vi.fn()} onDismiss={vi.fn()} translations={T3()}
      />,
    );
    expect(screen.getByLabelText('tr.cancel')).toBeInTheDocument();

    rerender(
      <DelegateProgress
        progress={detecting()} dataType="reference" ended
        onCancel={vi.fn()} onDismiss={vi.fn()} translations={T3()}
      />,
    );
    expect(screen.getByLabelText('tr.close')).toBeInTheDocument();
  });

  it('offers no control at all when the caller wires neither callback', () => {
    render(<DelegateProgress ended={false} progress={detecting()} dataType="reference" translations={T3()} />);
    expect(screen.queryByTestId('semiont-delegate-control')).toBeNull();
  });

  it('falls back to the generic in-progress copy when no code has arrived', () => {
    // `JobProgress.message` is optional: a pure liveness heartbeat carries none.
    const noCode = { percentage: 5 } as JobProgress;
    render(<DelegateProgress ended={false} progress={noCode} dataType="comment" translations={T3()} />);
    expect(screen.getByTestId('semiont-delegate-status').textContent).toBe('tr.inProgress');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The consolidated widget — one status region, one control, a data-driven bar.
// The titles below state its axioms (A1–A5).
//
// These assert STRUCTURE, never copy: the wording ("Marking…", subject
// beneath) was chosen by hand and it will be revised from use. A test pinned to
// a sentence rots on the first edit and teaches the next reader to weaken it.
// ─────────────────────────────────────────────────────────────────────────────
const STATUS = 'semiont-delegate-status';
const SUBJECT = 'semiont-delegate-subject';
const CONTROL = 'semiont-delegate-control';
const BAR = 'semiont-delegate-bar';
const PARAMS = 'semiont-delegate-params';

/** The widget's translations: one function for the coded copy, plus structure keys. */
const T3 = (over: Partial<DelegateProgressTranslations> = {}): DelegateProgressTranslations =>
  ({
    cancel: 'tr.cancel',
    close: 'tr.close',
    inProgress: 'tr.inProgress',
    message: (m: JobProgressMessage) => `tr.code(${m.code})`,
    subject: (current: { kind: string; value: string }, done?: number, total?: number) =>
      done === undefined
        ? `tr.subject(${current.kind}:${current.value})`
        : `tr.subject(${current.kind}:${current.value}|${done}/${total})`,
    paramLabel: (code: string) => `tr.param(${code})`,
    found: (n: number) => `tr.found(${n})`,
    ...over,
  }) as DelegateProgressTranslations;

const detecting = (over: Partial<JobProgress> = {}): JobProgress =>
  ({
    percentage: 40,
    message: { code: 'detecting-entities', entityType: 'Person' },
    current: { kind: 'entity-type', value: 'Person' },
    processed: 1,
    total: 3,
    ...over,
  }) as JobProgress;

describe('DelegateProgress — the consolidated widget', () => {
  it('A1: renders the subject exactly once for one progress event', () => {
    // A status line and a detail line that both call
    // `currentLabel(currentEntityType)` produce the IDENTICAL string, because
    // the wire carries a code and not prose. Singular `getByText` throws on
    // multiple matches — that IS the assertion.
    render(<DelegateProgress progress={detecting()} dataType="reference" ended={false} translations={T3()} />);

    expect(screen.getByText(/tr\.subject\(entity-type:Person/)).toBeInTheDocument();
    // And the status line is the CODE's copy, not a second copy of the subject.
    expect(screen.getByTestId(STATUS).textContent).toContain('tr.code(detecting-entities)');
    expect(screen.getByTestId(STATUS).textContent).not.toContain('tr.subject');
  });

  it('A2: renders no heading of its own — the section header is the title', () => {
    const { container } = render(
      <DelegateProgress ended={false} progress={detecting()} dataType="reference" translations={T3()} />,
    );
    expect(container.querySelector('h1,h2,h3,h4,h5,h6')).toBeNull();
  });

  it('A3: offers exactly one control, and it means cancel while running', async () => {
    const onCancel = vi.fn();
    const onDismiss = vi.fn();
    render(
      <DelegateProgress ended={false}
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
    // Terminality is the owner's fact, arriving as the `ended` prop: the
    // component reads no terminal marker from the payload.
    const onCancel = vi.fn();
    const onDismiss = vi.fn();
    render(
      <DelegateProgress
        progress={detecting({ message: { code: 'complete-created', count: 7, motivation: 'linking' } })}
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
    render(<DelegateProgress ended={false} progress={detecting()} dataType="reference" translations={T3()} />);

    expect(screen.getByTestId(SUBJECT).textContent).toBe('tr.subject(entity-type:Person|1/3)');
    expect(screen.getByTestId(BAR)).toBeInTheDocument();
  });

  it('A4: a tag frame carrying percentage alone still gets a bar — and no subject line', () => {
    // The tag flow's `creating-tag-annotations` frame as `processTagJob` sends
    // it: a percentage and a code, with no `current`, `processed` or `total`.
    // A bar gated on the fraction would drop the tag flow's bar on this
    // frame, so the fixture carries only what the producer sends.
    render(
      <DelegateProgress ended={false}
        progress={{
          percentage: 60,
          message: { code: 'creating-tag-annotations', count: 4 },
        } as JobProgress}
        dataType="tag" translations={T3()}
      />,
    );
    expect(screen.getByTestId(BAR)).toBeInTheDocument();
    // No fraction to show, so no subject line — and that is correct, not a gap.
    expect(screen.queryByTestId(SUBJECT)).toBeNull();
  });

  it('A4: the bar is unconditional — percentage is required on every event', () => {
    // A "no bar when nothing fills it" state is unreachable: `percentage` is a
    // REQUIRED field on JobProgress, so there is always something to fill a
    // bar with.
    render(
      <DelegateProgress ended={false}
        progress={{ percentage: 10, message: { code: 'loading' } } as JobProgress}
        dataType="comment" translations={T3()}
      />,
    );
    expect(screen.getByTestId(BAR)).toBeInTheDocument();
  });

  it('A5: every rendered string is traceable to translations', () => {
    const { container } = render(
      <DelegateProgress ended={false} progress={detecting()} dataType="reference" translations={T3()} />,
    );
    // Key-echo strings mean any text NOT starting `tr.` came from the component.
    const stray = Array.from(container.querySelectorAll('*'))
      .filter((el) => el.children.length === 0)
      .map((el) => el.textContent?.trim() ?? '')
      .filter((t) => t.length > 0 && !t.startsWith('tr.') && !/^[\s✨✅✓×✕()0-9/of]+$/.test(t));
    expect(stray).toEqual([]);
  });

  it('the outcome link renders only in the ended frame', async () => {
    // The link opens the generated resource. Its label is the resource's name —
    // user content, deliberately NOT a translation. While the run is live there
    // is no outcome to offer, even if a caller wires the prop early.
    const onOpen = vi.fn();
    const outcome = { label: 'Summary of PB', onOpen };
    const { rerender } = render(
      <DelegateProgress ended={false} progress={detecting()} dataType="generation"
        outcome={outcome} translations={T3()} />,
    );
    expect(screen.queryByText('Summary of PB')).toBeNull();

    rerender(
      <DelegateProgress ended progress={detecting()} dataType="generation"
        outcome={outcome} translations={T3()} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Summary of PB' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('the params line appears only when it adds information', () => {
    // The discriminator is the COUNT, not the copy — splitting a localized
    // string on commas to decide whether to show it would be its own defect.
    const oneType = detecting({
      requestParams: [{ label: 'entity-types', value: 'Person' }],
      total: 1,
    });
    const { unmount } = render(
      <DelegateProgress ended={false} progress={oneType} dataType="reference" translations={T3()} />,
    );
    expect(screen.queryByTestId(PARAMS)).toBeNull();
    unmount();

    const many = detecting({
      requestParams: [{ label: 'entity-types', value: 'Person, Organization, Location' }],
      total: 3,
    });
    render(<DelegateProgress ended={false} progress={many} dataType="reference" translations={T3()} />);
    expect(screen.getByTestId(PARAMS)).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The honest ended frame. The producer's terminal 100% frame races
// job:complete and can lose (its emit is a fire-and-forget heartbeat);
// terminality is the OWNER's fact, so the ended rendering stops trusting the
// last payload: full bar, and the owner's terminal sentence when it supplies
// one.
// ─────────────────────────────────────────────────────────────────────────────
describe('DelegateProgress — the honest ended frame', () => {
  it('an ended frame renders a FULL bar whatever the last payload said', () => {
    const { container } = render(
      <DelegateProgress ended progress={detecting({ percentage: 95 })} dataType="generation" translations={T3()} />,
    );
    const fill = container.querySelector('.semiont-progress-bar__fill') as HTMLElement;
    expect(fill.style.width).toBe('100%');
  });

  it('a live frame keeps the payload percentage', () => {
    const { container } = render(
      <DelegateProgress ended={false} progress={detecting({ percentage: 95 })} dataType="generation" translations={T3()} />,
    );
    const fill = container.querySelector('.semiont-progress-bar__fill') as HTMLElement;
    expect(fill.style.width).toBe('95%');
  });

  it('endedMessage replaces the stale payload copy once ended', () => {
    render(
      <DelegateProgress ended endedMessage="tr.ended" progress={detecting({ percentage: 95 })} dataType="generation" translations={T3()} />,
    );
    expect(screen.getByTestId(STATUS).textContent).toBe('tr.ended');
  });

  it('endedMessage is inert while the run is live', () => {
    render(
      <DelegateProgress ended={false} endedMessage="tr.ended" progress={detecting()} dataType="generation" translations={T3()} />,
    );
    expect(screen.getByTestId(STATUS).textContent).toBe('tr.code(detecting-entities)');
  });
});
