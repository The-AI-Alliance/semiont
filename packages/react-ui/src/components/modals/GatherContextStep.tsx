'use client';

import type { GatheredContext } from '@semiont/core';
import { ContextSummary } from './ContextSummary';
import type { ContextSummaryTranslations } from './ContextSummary';

export interface GatherContextStepProps {
  context: GatheredContext | null;
  contextLoading: boolean;
  contextError: Error | null;
  onCancel: () => void;
  onBind: () => void;
  onGenerate: () => void;
  onCompose: () => void;
  translations: {
    title: string;
    loadingContext: string;
    failedContext: string;
    cancel: string;
    find: string;
    generate: string;
    compose: string;
  } & ContextSummaryTranslations;
}

export function GatherContextStep({
  context,
  contextLoading,
  contextError,
  onCancel,
  onBind,
  onGenerate,
  onCompose,
  translations: t,
}: GatherContextStepProps) {
  const contextReady = !contextLoading && !contextError && !!context;

  return (
    <>
      {contextLoading && (
        <div className="semiont-modal__empty-state" style={{ textAlign: 'center', padding: '1rem 0' }}>
          {t.loadingContext}
        </div>
      )}
      {!!contextError && (
        <div style={{ textAlign: 'center', padding: '1rem 0', color: 'var(--semiont-color-red-600)' }}>
          {t.failedContext}
        </div>
      )}

      {context && <ContextSummary context={context} translations={t} />}

      {/* Action Buttons */}
      <div className="semiont-modal__actions" style={{ paddingTop: '0.5rem' }}>
        <button
          type="button"
          onClick={onCancel}
          className="semiont-button--secondary semiont-button--flex"
        >
          ✕ {t.cancel}
        </button>
        <button
          type="button"
          onClick={onBind}
          disabled={!contextReady}
          className="semiont-button--primary semiont-button--flex"
        >
          🔍 {t.find}…
        </button>
        <button
          type="button"
          onClick={onGenerate}
          disabled={!contextReady}
          className="semiont-button--primary semiont-button--flex"
        >
          ✨ {t.generate}…
        </button>
        <button
          type="button"
          onClick={onCompose}
          disabled={!contextReady}
          className="semiont-button--secondary semiont-button--flex"
        >
          ✍️ {t.compose}
        </button>
      </div>
    </>
  );
}
