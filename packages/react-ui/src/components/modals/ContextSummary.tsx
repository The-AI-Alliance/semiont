'use client';

import type { GatheredContext } from '@semiont/core';

export interface ContextSummaryTranslations {
  annotationLabel: string;
  sourceResourceLabel: string;
  motivationLabel: string;
  sourceContextLabel: string;
  graphContextLabel: string;
  connectionsLabel: string;
  citedByLabel: string;
  siblingTypesLabel: string;
  userHintLabel: string;
  userHintPlaceholder: string;
}

export interface ContextSummaryProps {
  context: GatheredContext;
  translations: ContextSummaryTranslations;
}

export function ContextSummary({ context, translations: t }: ContextSummaryProps) {
  const graphContext = context.graphContext;
  const connections = graphContext?.connections ?? [];
  const citedBy = graphContext?.citedBy ?? [];
  const citedByCount = graphContext?.citedByCount ?? 0;
  const siblingEntityTypes = graphContext?.siblingEntityTypes ?? [];

  return (
    <>
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
            {connections.length > 0 && (
              <div>
                <span style={{ fontWeight: 500, color: 'var(--semiont-text-secondary)' }}>{t.connectionsLabel}</span>
                <ul style={{ marginTop: '0.25rem', display: 'flex', flexDirection: 'column', gap: '0.25rem', listStyle: 'none', padding: 0 }}>
                  {connections.map(conn => (
                    <li key={conn.resourceId} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.375rem' }}>
                      <span style={{ color: 'var(--semiont-text-primary)' }}>{conn.resourceName}</span>
                      {conn.bidirectional && (
                        <span className="semiont-chip" style={{ fontSize: 'var(--semiont-text-xs)', padding: '0.125rem 0.375rem' }}>mutual</span>
                      )}
                      {conn.entityTypes && conn.entityTypes.map(et => (
                        <span key={et} className="semiont-chip" style={{ fontSize: 'var(--semiont-text-xs)', padding: '0.125rem 0.375rem' }}>
                          {et}
                        </span>
                      ))}
                    </li>
                  ))}
                </ul>
              </div>
            )}

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
    </>
  );
}
