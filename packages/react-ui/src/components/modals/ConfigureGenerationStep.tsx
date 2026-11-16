'use client';

import React, { useEffect } from 'react';
import { WizardFooter } from './WizardFooter';
import type { CollaboratorEntry, GatheredContext, SupportedMediaType } from '@semiont/core';
import type { GenerationOptions } from '@semiont/sdk';
import { LOCALES, GENERATABLE_MEDIA_TYPES, capabilitiesOf, proposeStoragePath } from '@semiont/core';

/**
 * Bounds for the max-length control when no ceiling is known. These are the
 * values this control has always shipped — the fallback is today's behaviour,
 * not an unbounded field (INFERENCE-LIMITS-EXPOSURE D6, as corrected in review).
 */
const MIN_MAX_TOKENS = 100;
const DEFAULT_MAX_TOKENS_CEILING = 4000;
/** The step's form values, owned by the wizard so Back cannot discard them (D3). */
export interface GenerationDraft {
  title: string;
  /**
   * The path FRAGMENT the user types beside the `file://` prefix — not a URI.
   * (`GenerationConfig.storageUri` is the assembled one; the names differ
   * because the things differ.)
   */
  storagePath: string;
  prompt: string;
  language: string;
  temperature: number;
  /** Text, not number: the field is user-editable and may be mid-edit or empty. */
  maxTokensText: string;
  /** The artifact's media type. Seeded `text/markdown` by both hosts (D2). */
  outputMediaType: SupportedMediaType;
}

/**
 * What this form fills in. Named here, but TYPED by the SDK (P2b).
 *
 * `storageUri` is on this list rather than a local `storagePath: string`
 * because the two were the same thing under different names — a divergence
 * that survived precisely because nothing tied them together (D8).
 */
type FormFilled =
  | 'title'
  | 'storageUri'
  | 'language'
  | 'temperature'
  | 'maxTokens'
  | 'outputMediaType';

/**
 * The submitted payload: the SDK's own generation options, DERIVED rather
 * than restated (P2b), plus the grounding context.
 *
 * This was a hand-written interface listing the same fields with independent
 * types — the shape `## Duplicated Shape` forbids — and it drifted exactly as
 * predicted: `storagePath: string` held a `storageUri`, so every consumer
 * re-mapped it by hand and silently dropped whatever the mapping forgot.
 * Deriving means a rename or retype in `GenerationOptions` is a compile
 * error here instead of a quiet gap at the wire.
 *
 * NARROWED on purpose: the SDK also carries `task`, `structure`, `cite` and
 * `stallDeadlineMs`, which this form does not collect, and a payload type
 * that advertised them would promise more than the UI delivers. Surfacing one
 * later is a one-word edit to `FormFilled` plus its control — the door is
 * unlocked, not open.
 *
 * `Required` because the form always fills these, even where the SDK lets
 * them be absent; `prompt` stays optional, because a blank instruction field
 * is omitted rather than sent empty.
 */
export type GenerationConfig =
  & Required<Pick<GenerationOptions, FormFilled>>
  & Pick<GenerationOptions, 'prompt'>
  & { context: GatheredContext };

/** The one place a format's required extension is read (D7). */
const extensionFor = (format: SupportedMediaType): string =>
  capabilitiesOf(format)?.extension ?? '';

/**
 * A fresh draft, defined ONCE for both hosts (D8b). The two modals carried
 * byte-identical literals — magic numbers included — so every new field meant
 * two edits and an opportunity to seed only one of them.
 */
export const freshGenerationDraft = (title: string, locale: string): GenerationDraft => ({
  title,
  storagePath: '',
  prompt: '',
  language: locale,
  temperature: 0.7,
  maxTokensText: '500',
  // D2: markdown is the DEFAULT, not an assumption — the worker would also
  // default to it, but a control must send what it shows.
  outputMediaType: 'text/markdown',
});

export interface ConfigureGenerationStepProps {
  context: GatheredContext;
  /** Echo of the gather step's hint — the thing being steered stays visible (GEP D8). */
  hintEcho?: { label: string; value: string };
  /** Owned by the wizard so Back is lossless (WIZARD-NAVIGATION D3). */
  config: GenerationDraft;
  onConfigChange: (config: GenerationDraft) => void;
  /** Absent in a single-stack host (GATHER-AT-THE-TOP D6) — the footer then renders no retreat. */
  onBack?: () => void;
  onGenerate: (config: GenerationConfig) => void;
  /**
   * Folder of the resource being generated FROM, so the artifact lands beside
   * its source (D11). The page derives it; this component stays
   * presentational, exactly as it already receives the default title.
   */
  defaultFolder?: string;
  translations: {
    resourceTitle: string;
    resourceTitlePlaceholder: string;
    saveLocation: string;
    additionalInstructions: string;
    additionalInstructionsPlaceholder: string;
    language: string;
    languageHelp: string;
    creativity: string;
    creativityFocused: string;
    creativityCreative: string;
    maxLength: string;
    maxLengthHelp: string;
    /**
     * Shown INSTEAD of `maxLengthHelp` when the ceiling is known, so the bound
     * is legible rather than mysterious. Interpolates `{{maxOutputTokens}}`
     * and `{{model}}`.
     */
    maxLengthCeiling: string;
    /** Label for the output-format select. */
    outputFormat: string;
    /**
     * Shown when the Save location's extension contradicts the chosen format,
     * which the form REFUSES to submit (D7 — the worker is faithful and will
     * write a PDF to a `.md` path, so this is the only gate). Interpolates
     * `{{extension}}`.
     */
    formatExtensionMismatch: string;
    back?: string;
    generate: string;
  };
  /**
   * The roster entry serving `generation` (from `useCollaborators`). When its
   * `limits` are known the max-length control is hard-bounded by the model's
   * output ceiling; absent — or present without `limits`, which is normal when
   * discovery could not answer right now — the control keeps its default
   * bounds and generation still submits (D3).
   */
  generationAgent?: CollaboratorEntry;
}

export function ConfigureGenerationStep({
  context,
  hintEcho,
  config,
  onConfigChange,
  onBack,
  onGenerate,
  defaultFolder = '',
  translations: t,
  generationAgent,
}: ConfigureGenerationStepProps) {
  // CONTROLLED (WIZARD-NAVIGATION D3): these were six local `useState`s, so Back
  // unmounted the step and threw away every typed instruction, the save path and
  // both sliders. `maxTokensText` stays TEXT rather than a number so the field can
  // be cleared mid-edit — `parseInt` on an empty field yields NaN, which React
  // warns about and which used to travel into the job config.
  const { title, storagePath, prompt, language, temperature, maxTokensText, outputMediaType } = config;
  const set = (patch: Partial<GenerationDraft>) => onConfigChange({ ...config, ...patch });

  // D11 — the Save location starts filled and FOLLOWS the title and format
  // until the user takes it over. `pathTouched` is DERIVED rather than stored:
  // it is exactly "the field holds the user's own text", which makes clearing
  // the field un-touch it for free, keeps it reset-on-open and Back-safe
  // because `storagePath` already is, and leaves no second field to desync.
  const pathTouched = storagePath !== '';
  const proposedPath = proposeStoragePath(defaultFolder, title, outputMediaType);
  const effectivePath = pathTouched ? storagePath : proposedPath;

  // D7 — the GUI is where a format/extension mismatch is caught, because it is
  // where the person who can fix it is standing. An EMPTY path is not a
  // mismatch: the field is `required`, so emptiness is already refused, and
  // telling an untouched form it is wrong is not a welcome. Under D11 a
  // PROPOSED path always matches, so this now fires only on hand-edits.
  const requiredExtension = extensionFor(outputMediaType);
  const extensionMismatch =
    effectivePath !== '' &&
    !effectivePath.toLowerCase().endsWith(requiredExtension.toLowerCase());

  const ceiling = generationAgent?.limits?.maxOutputTokens ?? DEFAULT_MAX_TOKENS_CEILING;

  /**
   * The value that will actually be submitted: always finite, always inside
   * the bounds, whatever the field currently shows.
   */
  const clamp = (n: number): number =>
    Math.min(Math.max(Number.isFinite(n) ? n : MIN_MAX_TOKENS, MIN_MAX_TOKENS), ceiling);

  const submittedMaxTokens = clamp(parseInt(maxTokensText, 10));

  // Re-clamp whenever the ceiling changes — which INCLUDES its first arrival.
  // `browse.agents()` is asynchronous, so `generationAgent` is undefined on the
  // first render and lands later; clamping only in the `useState` initializer
  // would satisfy a mount-time test and do nothing in the running app.
  useEffect(() => {
    const n = parseInt(maxTokensText, 10);
    // An empty/mid-edit field is left alone; submission clamps it anyway.
    if (Number.isFinite(n) && n > ceiling) set({ maxTokensText: String(ceiling) });
    // `set` and the draft are intentionally out of the dep list: this reacts to the
    // CEILING arriving (browse.agents() is async), not to the user typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ceiling]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (extensionMismatch) return;
    const trimmedPrompt = prompt.trim();
    onGenerate({
      title,
      storageUri: `file://${effectivePath}`,
      ...(trimmedPrompt ? { prompt: trimmedPrompt } : {}),
      language,
      temperature,
      maxTokens: submittedMaxTokens,
      outputMediaType,
      context,
    });
  };

  return (
    // No --scrollable: this form renders below the evidence display inside the
    // host's single step-scroll pane — an independent scroll region here is
    // what squeezed the parameters out of view (the measured failure).
    <form onSubmit={handleSubmit} className="semiont-form">
      {hintEcho && (
        <p className="semiont-wizard__hint-echo">
          {hintEcho.label}: {hintEcho.value}
        </p>
      )}
      {/* Resource Title */}
      <div className="semiont-form__field">
        <label htmlFor="wizard-title" className="semiont-form__label">
          {t.resourceTitle}
        </label>
        <input
          id="wizard-title"
          type="text"
          value={title}
          onChange={(e) => set({ title: e.target.value })}
          required
          className="semiont-input"
          placeholder={t.resourceTitlePlaceholder}
        />
      </div>

      {/* Storage URI */}
      <div className="semiont-form__field">
        <label htmlFor="wizard-storagePath" className="semiont-form__label">
          {t.saveLocation}
        </label>
        <div className="semiont-input-addon">
          <span className="semiont-input-addon__prefix">file://</span>
          <input
            id="wizard-storagePath"
            type="text"
            value={effectivePath}
            onChange={(e) => set({ storagePath: e.target.value })}
            required
            aria-invalid={extensionMismatch}
            {...(extensionMismatch ? { 'aria-describedby': 'wizard-format-mismatch' } : {})}
            className="semiont-input semiont-input--addon"
            placeholder="generated/my-resource.md"
          />
        </div>
        {/* The reason sits with the field, not on the button: the message
            belongs where the fix is. */}
        {extensionMismatch && (
          <p id="wizard-format-mismatch" className="semiont-form__error" role="alert">
            {t.formatExtensionMismatch.replace('{{extension}}', requiredExtension)}
          </p>
        )}
      </div>

      {/* Output format — with the artifact's IDENTITY (title, location), not
          among the model knobs below (D5). The options are DERIVED from the
          registry (D1): promote a fourth row to `generatable` and it appears
          here, with no list to forget to update. */}
      <div className="semiont-form__field">
        <label htmlFor="wizard-outputFormat" className="semiont-form__label">
          {t.outputFormat}
        </label>
        <select
          id="wizard-outputFormat"
          value={outputMediaType}
          onChange={(e) => set({ outputMediaType: e.target.value as SupportedMediaType })}
          className="semiont-select"
        >
          {GENERATABLE_MEDIA_TYPES.map((format) => (
            <option key={format} value={format}>
              {capabilitiesOf(format)?.label ?? format}
            </option>
          ))}
        </select>
      </div>

      {/* Additional Instructions */}
      <div className="semiont-form__field">
        <label htmlFor="wizard-prompt" className="semiont-form__label">
          {t.additionalInstructions}
        </label>
        <textarea
          id="wizard-prompt"
          value={prompt}
          onChange={(e) => set({ prompt: e.target.value })}
          rows={2}
          className="semiont-textarea"
          placeholder={t.additionalInstructionsPlaceholder}
        />
      </div>

      {/* Language / Creativity / Max Length — compact inline row */}
      <div className="semiont-form__inline-row">
        <div className="semiont-form__field semiont-form__field--inline">
          <label htmlFor="wizard-language" className="semiont-form__label">
            {t.language}
          </label>
          <select
            id="wizard-language"
            value={language}
            onChange={(e) => set({ language: e.target.value })}
            className="semiont-select"
          >
            {LOCALES.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.nativeName}
              </option>
            ))}
          </select>
        </div>

        <div className="semiont-form__field semiont-form__field--inline semiont-form__field--slider">
          <label htmlFor="wizard-temperature" className="semiont-form__label">
            {t.creativity} ({temperature.toFixed(1)})
          </label>
          <input
            id="wizard-temperature"
            type="range"
            min="0"
            max="1"
            step="0.1"
            value={temperature}
            onChange={(e) => set({ temperature: parseFloat(e.target.value) })}
            className="semiont-slider"
          />
          <div className="semiont-slider__labels semiont-slider__labels--small">
            <span>{t.creativityFocused}</span>
            <span>{t.creativityCreative}</span>
          </div>
        </div>

        <div className="semiont-form__field semiont-form__field--inline semiont-form__field--narrow semiont-form__field--end">
          <label htmlFor="wizard-maxTokens" className="semiont-form__label">
            {t.maxLength}
          </label>
          <input
            id="wizard-maxTokens"
            type="number"
            min={MIN_MAX_TOKENS}
            max={ceiling}
            step="100"
            value={maxTokensText}
            onChange={(e) => {
              const raw = e.target.value;
              // Empty is a legitimate transient state while retyping.
              if (raw === '') { set({ maxTokensText: '' }); return; }
              const n = parseInt(raw, 10);
              if (!Number.isFinite(n)) return;
              // `max` alone does not stop a larger value being typed — it only
              // marks the field invalid. D6 says it cannot be entered, so the
              // clamp lives here.
              set({ maxTokensText: String(Math.min(n, ceiling)) });
            }}
            className="semiont-input"
          />
        </div>
      </div>

      {/* The bound, as a full sentence — which is why it lives UNDER the row,
          never inside the 5.5rem Max Length column: a sentence in that box
          wraps one word per line and its height taxes the whole flex row. */}
      <p className="semiont-form__help semiont-form__help--row">
        {generationAgent?.limits
          ? t.maxLengthCeiling
              .replace('{{maxOutputTokens}}', String(ceiling))
              .replace(
                '{{model}}',
                (generationAgent.agent as { model?: string; name?: string }).model
                  ?? generationAgent.agent.name,
              )
          : t.maxLengthHelp}
      </p>

      <WizardFooter
        {...(onBack && t.back ? { backLabel: t.back, onBack } : {})}
        primary={{ label: t.generate, type: 'submit', disabled: extensionMismatch }}
      />
    </form>
  );
}
