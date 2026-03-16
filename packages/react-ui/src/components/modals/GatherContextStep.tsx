'use client';

import type { GatheredContext } from '@semiont/core';

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
    sourceContextLabel: string;
    entityTypesLabel: string;
    graphContextLabel: string;
    connectionsLabel: string;
    citedByLabel: string;
    siblingTypesLabel: string;
    loadingContext: string;
    failedContext: string;
    cancel: string;
    find: string;
    generate: string;
    compose: string;
  };
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
  const sourceContext = context?.sourceContext;
  const graphContext = context?.graphContext;
  const entityTypes = context?.metadata?.entityTypes ?? [];
  const connections = graphContext?.connections ?? [];
  const citedBy = graphContext?.citedBy ?? [];
  const citedByCount = graphContext?.citedByCount ?? 0;
  const siblingEntityTypes = graphContext?.siblingEntityTypes ?? [];

  const contextReady = !contextLoading && !contextError && !!context;

  return (
    <>
      {/* Source Context Preview */}
      <div className="semiont-form__field">
        <label className="semiont-form__label">
          {t.sourceContextLabel}
        </label>
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
        {sourceContext && (
          <div style={{
            padding: '0.75rem',
            backgroundColor: 'var(--semiont-bg-secondary)',
            borderRadius: 'var(--semiont-radius-md)',
            border: '1px solid var(--semiont-border-primary)',
            maxHeight: '200px',
            overflowY: 'auto',
          }}>
            <div style={{ fontSize: 'var(--semiont-text-sm)', fontFamily: 'monospace', whiteSpace: 'pre-wrap', color: 'var(--semiont-text-secondary)' }}>
              {sourceContext.before && <span>{sourceContext.before}</span>}
              <span style={{
                backgroundColor: 'var(--semiont-color-primary-100)',
                padding: '0 0.25rem',
                fontWeight: 600,
                color: 'var(--semiont-color-primary-900)',
              }}>
                {sourceContext.selected}
              </span>
              {sourceContext.after && <span>{sourceContext.after}</span>}
            </div>
          </div>
        )}
      </div>

      {/* Entity Types */}
      {entityTypes.length > 0 && (
        <div className="semiont-form__field">
          <label className="semiont-form__label">
            {t.entityTypesLabel}
          </label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' }}>
            {entityTypes.map(et => (
              <span key={et} className="semiont-chip" style={{ fontSize: 'var(--semiont-text-xs)', padding: '0.125rem 0.5rem' }}>
                {et}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Graph Context */}
      {graphContext && (connections.length > 0 || citedByCount > 0 || siblingEntityTypes.length > 0) && (
        <div className="semiont-form__field">
          <label className="semiont-form__label">
            {t.graphContextLabel}
          </label>
          <div style={{
            padding: '0.75rem',
            backgroundColor: 'var(--semiont-bg-secondary)',
            borderRadius: 'var(--semiont-radius-md)',
            border: '1px solid var(--semiont-border-primary)',
            fontSize: 'var(--semiont-text-sm)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
          }}>
            {/* Connections */}
            {connections.length > 0 && (
              <div>
                <span style={{ fontWeight: 500, color: 'var(--semiont-text-secondary)' }}>{t.connectionsLabel}</span>
                <ul style={{ marginTop: '0.25rem', display: 'flex', flexDirection: 'column', gap: '0.125rem', listStyle: 'none', padding: 0 }}>
                  {connections.map(conn => (
                    <li key={conn.resourceId} style={{ color: 'var(--semiont-text-secondary)', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                      <span>{conn.resourceName}</span>
                      {conn.bidirectional && (
                        <span className="semiont-chip" style={{ fontSize: 'var(--semiont-text-xs)', padding: '0.125rem 0.375rem' }}>mutual</span>
                      )}
                      {conn.entityTypes && conn.entityTypes.length > 0 && (
                        <span style={{ fontSize: 'var(--semiont-text-xs)', color: 'var(--semiont-text-tertiary)' }}>
                          {conn.entityTypes.join(', ')}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Cited By */}
            {citedByCount > 0 && (
              <div>
                <span style={{ fontWeight: 500, color: 'var(--semiont-text-secondary)' }}>
                  {t.citedByLabel} ({citedByCount})
                </span>
                {citedBy.length > 0 && (
                  <ul style={{ marginTop: '0.25rem', display: 'flex', flexDirection: 'column', gap: '0.125rem', listStyle: 'none', padding: 0 }}>
                    {citedBy.map(ref => (
                      <li key={ref.resourceId} style={{ color: 'var(--semiont-text-secondary)' }}>
                        {ref.resourceName}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {/* Sibling Entity Types */}
            {siblingEntityTypes.length > 0 && (
              <div>
                <span style={{ fontWeight: 500, color: 'var(--semiont-text-secondary)' }}>{t.siblingTypesLabel}</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', marginTop: '0.25rem' }}>
                  {siblingEntityTypes.map(et => (
                    <span key={et} className="semiont-chip" style={{ fontSize: 'var(--semiont-text-xs)', padding: '0.125rem 0.5rem' }}>
                      {et}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

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
