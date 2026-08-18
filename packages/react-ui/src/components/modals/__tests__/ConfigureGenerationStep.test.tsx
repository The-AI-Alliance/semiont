/**
 * INFERENCE-LIMITS-EXPOSURE P3b — the max-length control is bounded by the
 * generation-serving agent's discovered output ceiling.
 *
 * The control was NOT previously unbounded: it shipped `min="100" max="4000"`.
 * So this phase replaces a hardcoded 4000 with the real ceiling, which for any
 * model above 4000 RAISES a cap users hit today, and for a smaller model
 * lowers it to something the provider will actually honour.
 */
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { CollaboratorEntry, GatheredContext } from '@semiont/core';
import { ConfigureGenerationStep } from '../ConfigureGenerationStep';

const translations = {
  resourceTitle: 'Title',
  resourceTitlePlaceholder: 'Title…',
  additionalInstructions: 'Instructions',
  additionalInstructionsPlaceholder: 'Instructions…',
  language: 'Language',
  languageHelp: 'Language help',
  creativity: 'Creativity',
  creativityFocused: 'Focused',
  creativityCreative: 'Creative',
  maxLength: 'Max length',
  maxLengthHelp: 'How long the generated resource may be.',
  // Named model + ceiling, so the bound is legible rather than mysterious (D6).
  maxLengthCeiling: 'Limited to {{maxOutputTokens}} tokens by {{model}}.',
  back: 'Back',
  generate: 'Generate',
};

const context = { resources: [], annotations: [] } as unknown as GatheredContext;

/** The wizard's initial draft (WIZARD-NAVIGATION D3). */
const DRAFT = {
  title: 'Untitled', storagePath: '', prompt: '', language: 'en',
  temperature: 0.7, maxTokensText: '500',
};

const agentWithCeiling = (maxOutputTokens: number): CollaboratorEntry =>
  ({
    agent: {
      '@type': 'Software',
      name: 'Claude Sonnet 5',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    },
    servesJobTypes: ['generation'],
    limits: { contextTokens: 200_000, maxOutputTokens },
  }) as unknown as CollaboratorEntry;

/**
 * The step is CONTROLLED since WIZARD-NAVIGATION D3 — the wizard owns the draft so
 * Back cannot discard it. These tests therefore mount a tiny stateful harness rather
 * than the bare component: a `vi.fn()` for `onConfigChange` would swallow every edit
 * and quietly turn each assertion below into a test of nothing.
 */
function Harness({ generationAgent }: { generationAgent?: CollaboratorEntry }) {
  const [draft, setDraft] = useState(DRAFT);
  return (
    <ConfigureGenerationStep
      config={draft}
      onConfigChange={setDraft}
      context={context}
      onBack={vi.fn()}
      onGenerate={onGenerateSpy}
      translations={translations}
      {...(generationAgent ? { generationAgent } : {})}
    />
  );
}

let onGenerateSpy = vi.fn();

function renderStep(generationAgent?: CollaboratorEntry) {
  onGenerateSpy = vi.fn();
  const utils = render(<Harness {...(generationAgent ? { generationAgent } : {})} />);
  const input = () => screen.getByLabelText('Max length') as HTMLInputElement;
  return { ...utils, input, props: { onGenerate: onGenerateSpy } };
}

function fillRequired() {
  fireEvent.change(screen.getByLabelText('Save location'), {
    target: { value: 'generated/out.md' },
  });
}

describe('ConfigureGenerationStep — ceiling awareness', () => {
  it('bounds the control by the agent ceiling and names it in help text', () => {
    const { input } = renderStep(agentWithCeiling(64_000));

    expect(input().max).toBe('64000');
    expect(screen.getByText(/Limited to 64000 tokens by claude-sonnet-5\./)).toBeInTheDocument();
  });

  it('will not commit a value above the ceiling', () => {
    // `max` on a number input does not prevent TYPING an over-value — it only
    // marks the field invalid. D6 says the value cannot be entered, so assert
    // the committed state, never the attribute alone.
    const { input } = renderStep(agentWithCeiling(2_000));

    fireEvent.change(input(), { target: { value: '9999' } });

    expect(input().value).toBe('2000');
  });

  it('clamps the 500 default down when the ceiling is smaller', () => {
    const { input } = renderStep(agentWithCeiling(300));

    expect(input().value).toBe('300');
  });

  it('re-bounds and clamps when the ceiling arrives AFTER mount', () => {
    // The case that decides whether this feature works in the app at all:
    // `browse.agents()` is asynchronous, so `generationAgent` is undefined on
    // first render and arrives later. An implementation that only consults the
    // ceiling in the `useState` initializer passes every test above and does
    // nothing in production.
    const { input, rerender } = renderStep(undefined);

    expect(input().max).toBe('4000');
    fireEvent.change(input(), { target: { value: '3000' } });
    expect(input().value).toBe('3000');

    rerender(<Harness generationAgent={agentWithCeiling(1_000)} />);

    expect(input().max).toBe('1000');
    // 3000 is now out of range and must not survive as a submittable value.
    expect(input().value).toBe('1000');
  });

  it('keeps a value that is still within a newly arrived ceiling', () => {
    const { input, rerender } = renderStep(undefined);
    fireEvent.change(input(), { target: { value: '800' } });

    rerender(<Harness generationAgent={agentWithCeiling(4_000)} />);

    expect(input().value).toBe('800');
  });

  it('falls back to today\'s bounds and copy without an agent (D3/D6 degradation)', () => {
    const { input } = renderStep(undefined);

    expect(input().min).toBe('100');
    expect(input().max).toBe('4000');
    expect(screen.getByText('How long the generated resource may be.')).toBeInTheDocument();
    expect(screen.queryByText(/Limited to/)).not.toBeInTheDocument();
  });

  it('falls back when the agent is present but discovery could not answer', () => {
    const noLimits = { ...agentWithCeiling(64_000) } as Record<string, unknown>;
    delete noLimits.limits;
    const { input } = renderStep(noLimits as unknown as CollaboratorEntry);

    expect(input().max).toBe('4000');
    expect(screen.queryByText(/Limited to/)).not.toBeInTheDocument();
  });

  it('submits the clamped value, not the typed one', () => {
    const { props } = renderStep(agentWithCeiling(1_500));
    const onGenerate = props.onGenerate;

    fillRequired();
    const input = screen.getByLabelText('Max length') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '8000' } });
    fireEvent.click(screen.getByText(/Generate/));

    expect(onGenerate).toHaveBeenCalledTimes(1);
    expect(onGenerate.mock.calls[0]![0].maxTokens).toBe(1_500);
  });

  it('lets the field be cleared, and never submits NaN for it', () => {
    // Pre-existing hazard the clamp must not inherit: the handler was
    // `parseInt(e.target.value)` and `parseInt('')` is NaN, which React then
    // warns about and which would travel into the job config. Clearing must
    // stay possible (you cannot retype a number otherwise), so the contract is
    // about what SUBMITS, not about forbidding the empty state.
    const { props } = renderStep(agentWithCeiling(4_000));
    const onGenerate = props.onGenerate;
    const input = screen.getByLabelText('Max length') as HTMLInputElement;

    fillRequired();
    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('');

    fireEvent.click(screen.getByText(/Generate/));

    const submitted = onGenerate.mock.calls[0]![0].maxTokens;
    expect(Number.isFinite(submitted)).toBe(true);
    expect(submitted).toBeGreaterThanOrEqual(100);
    expect(submitted).toBeLessThanOrEqual(4_000);
  });
});

// The rest of the draft, same contract as the ceiling: every field reports to
// the owner (WIZARD-NAVIGATION D3). A field that kept its own state would look
// right until someone pressed Back.
describe('ConfigureGenerationStep — the draft is the owner\'s', () => {
  it('reports edits to title, instructions, language and creativity', async () => {
    const { input } = renderStep(agentWithCeiling(4_000));
    expect(input()).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(translations.resourceTitle), { target: { value: 'Caspian Sea' } });
    expect((screen.getByLabelText(translations.resourceTitle) as HTMLInputElement).value).toBe('Caspian Sea');

    fireEvent.change(screen.getByLabelText(translations.additionalInstructions), { target: { value: 'hydrology only' } });
    expect((screen.getByLabelText(translations.additionalInstructions) as HTMLTextAreaElement).value).toBe('hydrology only');

    // The label carries the live value — "Creativity (0.7)" — which is itself
    // the proof the slider is controlled: it can only update if the owner's
    // draft came back down.
    const slider = () => screen.getByLabelText(new RegExp(`^${translations.creativity}`)) as HTMLInputElement;
    fireEvent.change(slider(), { target: { value: '0.2' } });
    expect(slider().value).toBe('0.2');
    expect(screen.getByText(/Creativity \(0\.2\)/)).toBeInTheDocument();
  });

  it('lets the max-length field go empty while retyping', () => {
    // Clearing is a legitimate mid-edit state — you cannot retype a number
    // otherwise — so the field must accept '' and let submission clamp it.
    const { input } = renderStep(agentWithCeiling(4_000));
    fireEvent.change(input(), { target: { value: '' } });
    expect(input().value).toBe('');
  });

  it('reports a language change to the owner', () => {
    renderStep(agentWithCeiling(4_000));
    const select = () => screen.getByLabelText(translations.language) as HTMLSelectElement;
    const other = Array.from(select().options).map((o) => o.value).find((v) => v !== select().value);
    fireEvent.change(select(), { target: { value: other } });
    expect(select().value).toBe(other);
  });

  it('carries the typed instructions into the submitted config, trimmed', () => {
    const { props } = renderStep(agentWithCeiling(4_000));
    fillRequired();
    fireEvent.change(screen.getByLabelText(translations.additionalInstructions), { target: { value: '  hydrology only  ' } });
    fireEvent.click(screen.getByText(new RegExp(translations.generate)));

    expect(props.onGenerate).toHaveBeenCalledTimes(1);
    expect(props.onGenerate.mock.calls[0]![0].prompt).toBe('hydrology only');
  });

  it('omits the prompt entirely when the field is blank', () => {
    // `prompt` is optional on the wire; sending "" would be a claim the user
    // never made, and the worker would prepend an empty instruction block.
    const { props } = renderStep(agentWithCeiling(4_000));
    fillRequired();
    fireEvent.click(screen.getByText(new RegExp(translations.generate)));
    expect(props.onGenerate.mock.calls[0]![0]).not.toHaveProperty('prompt');
  });
});

describe('ConfigureGenerationStep — the hint echo (GEP P1c, D8)', () => {
  it('echoes a non-empty hint, and renders nothing without one', () => {
    const { container, rerender } = render(
      <ConfigureGenerationStep
        context={context} config={DRAFT} onConfigChange={vi.fn()}
        onBack={vi.fn()} onGenerate={vi.fn()} translations={translations}
        hintEcho={{ label: 'Hint', value: 'the ancient city, not the modern province' }}
      />,
    );
    const echo = container.querySelector('.semiont-wizard__hint-echo');
    expect(echo).not.toBeNull();
    expect(echo!.textContent).toContain('the ancient city, not the modern province');

    rerender(
      <ConfigureGenerationStep
        context={context} config={DRAFT} onConfigChange={vi.fn()}
        onBack={vi.fn()} onGenerate={vi.fn()} translations={translations}
      />,
    );
    expect(container.querySelector('.semiont-wizard__hint-echo')).toBeNull();
  });
});
