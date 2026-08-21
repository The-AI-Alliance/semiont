'use client';

import React, { useState } from 'react';
import { LOCALES } from '@semiont/core';
import { CodeMirrorRenderer } from '../CodeMirrorRenderer';
import { WizardFooter } from './WizardFooter';

/**
 * COMPOSE-IN-MODAL P1 — the compose strategy's form, as a pure step.
 *
 * The from-reference slice of the compose page, lifted: name, save location,
 * entity types, language, editor. Deliberately none of the page's
 * upload/format/encoding machinery (the modal composes text; uploads stay on
 * the standalone page — plan non-goal). The draft is CONTROLLED by the host
 * (WIZARD-NAVIGATION D3), and the evidence display is the host's job (A3).
 */

export interface ComposeDraft {
  name: string;
  /** Bare working-tree path; the file:// prefix is applied at submit. */
  storagePath: string;
  content: string;
  /** Picked types — consulted only when the reference fixed none (D6). */
  entityTypes: string[];
  language: string;
}

export interface ComposeParams {
  name: string;
  /** Full file:// URI. */
  storagePath: string;
  content: string;
  entityTypes: string[];
  language: string;
}

export interface ComposeStepProps {
  draft: ComposeDraft;
  onDraftChange: (patch: Partial<ComposeDraft>) => void;
  /** Entity types fixed when the reference was created — read-only tags when
   *  non-empty (D6): they are not this step's to change. */
  referenceEntityTypes: string[];
  /** Picker vocabulary when the reference fixed none. Owner-supplied, so a
   *  failed load cannot surface as an empty vocabulary. */
  entityTypeOptions: string[];
  showLineNumbers: boolean;
  hoverDelayMs: number;
  onBack: () => void;
  /** Create-and-link. Async: the footer pends until it settles; rejection
   *  re-enables it (the host surfaces the error — same posture as Link). */
  onCompose: (params: ComposeParams) => Promise<void>;
  translations: {
    resourceTitle: string;
    resourceTitlePlaceholder: string;
    saveLocation: string;
    entityTypes: string;
    language: string;
    contentLabel: string;
    back: string;
    createAndLink: string;
    creatingAndLinking: string;
  };
}

export function ComposeStep({
  draft,
  onDraftChange,
  referenceEntityTypes,
  entityTypeOptions,
  showLineNumbers,
  hoverDelayMs,
  onBack,
  onCompose,
  translations: t,
}: ComposeStepProps) {
  const [isCreating, setIsCreating] = useState(false);
  const fixedTypes = referenceEntityTypes.length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.name.trim() || !draft.storagePath.trim()) return;
    setIsCreating(true);
    try {
      await onCompose({
        name: draft.name,
        storagePath: `file://${draft.storagePath}`,
        content: draft.content,
        entityTypes: fixedTypes ? referenceEntityTypes : draft.entityTypes,
        language: draft.language,
      });
    } catch {
      // The rejection's job ends here: it kept the wizard's close from
      // running and the host already surfaced the failure. Letting it
      // escape a React event handler is an unhandled rejection.
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="semiont-form">
      {/* Name */}
      <div className="semiont-form__field">
        <label htmlFor="compose-name" className="semiont-form__label">
          {t.resourceTitle}
        </label>
        <input
          id="compose-name"
          type="text"
          value={draft.name}
          onChange={(e) => onDraftChange({ name: e.target.value })}
          placeholder={t.resourceTitlePlaceholder}
          required
          className="semiont-input"
          disabled={isCreating}
        />
      </div>

      {/* Storage URI */}
      <div className="semiont-form__field">
        <label htmlFor="compose-storagePath" className="semiont-form__label">
          {t.saveLocation}
        </label>
        <div className="semiont-input-addon">
          <span className="semiont-input-addon__prefix">file://</span>
          <input
            id="compose-storagePath"
            type="text"
            value={draft.storagePath}
            onChange={(e) => onDraftChange({ storagePath: e.target.value })}
            placeholder="people/my-resource.md"
            required
            className="semiont-input semiont-input--addon"
            disabled={isCreating}
          />
        </div>
      </div>

      {/* Entity types: fixed at reference creation → tags; otherwise picker */}
      <div className="semiont-form__field">
        <div className="semiont-form__label">{t.entityTypes}</div>
        {fixedTypes ? (
          <div className="semiont-form__entity-type-tags" role="list">
            {referenceEntityTypes.map((type) => (
              <span key={type} role="listitem" className="semiont-form__entity-type-tag">
                {type}
              </span>
            ))}
          </div>
        ) : (
          <div className="semiont-form__entity-type-buttons" role="group">
            {entityTypeOptions.map((type) => {
              const isSelected = draft.entityTypes.includes(type);
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => onDraftChange({
                    entityTypes: isSelected
                      ? draft.entityTypes.filter((x) => x !== type)
                      : [...draft.entityTypes, type],
                  })}
                  className="semiont-form__entity-type-button"
                  data-selected={isSelected}
                  aria-pressed={isSelected}
                  disabled={isCreating}
                >
                  {type}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Language */}
      <div className="semiont-form__field">
        <label htmlFor="compose-language" className="semiont-form__label">
          {t.language}
        </label>
        <select
          id="compose-language"
          value={draft.language}
          onChange={(e) => onDraftChange({ language: e.target.value })}
          disabled={isCreating}
          className="semiont-select"
        >
          {LOCALES.map((lang) => (
            <option key={lang.code} value={lang.code}>
              {lang.nativeName}
            </option>
          ))}
        </select>
      </div>

      {/* Content editor */}
      <div className="semiont-form__field semiont-form__editor">
        <label className="semiont-form__label">{t.contentLabel}</label>
        <div className="semiont-form__editor-wrapper" lang={draft.language}>
          <CodeMirrorRenderer
            content={draft.content}
            editable={!isCreating}
            sourceView={true}
            showLineNumbers={showLineNumbers}
            hoverDelayMs={hoverDelayMs}
            onChange={(content: string) => onDraftChange({ content })}
          />
        </div>
      </div>

      <WizardFooter
        backLabel={t.back}
        onBack={onBack}
        primary={{ label: t.createAndLink, pendingLabel: t.creatingAndLinking, pending: isCreating, type: 'submit' }}
      />
    </form>
  );
}
