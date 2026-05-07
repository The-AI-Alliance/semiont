'use client';

import type { GatheredContext } from '@semiont/core';

export interface ContextSummaryTranslations {
  sourceContextLabel: string;
  connectionsLabel: string;
  citedByLabel: string;
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

  return (
    <>
      {graphContext && (connections.length > 0 || citedByCount > 0) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>

          {connections.length > 0 && (
            <div>
              <div style={{
                fontSize: 'var(--semiont-text-xs)',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                color: 'var(--semiont-text-tertiary)',
                marginBottom: '0.375rem',
              }}>
                {t.connectionsLabel}
              </div>
              <ul style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem', listStyle: 'none', padding: 0, margin: 0 }}>
                {connections.map(conn => (
                  <li key={conn.resourceId} style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: '0.375rem',
                    fontSize: 'var(--semiont-text-sm)',
                  }}>
                    <span style={{ color: 'var(--semiont-text-primary)', fontWeight: 500 }}>{conn.resourceName}</span>
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
              <div style={{
                fontSize: 'var(--semiont-text-xs)',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                color: 'var(--semiont-text-tertiary)',
                marginBottom: '0.375rem',
              }}>
                {t.citedByLabel} ({citedByCount})
              </div>
              {citedBy.length > 0 && (
                <ul style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', listStyle: 'none', padding: 0, margin: 0 }}>
                  {citedBy.map(ref => (
                    <li key={ref.resourceId} style={{ fontSize: 'var(--semiont-text-sm)', color: 'var(--semiont-text-primary)', fontWeight: 500 }}>
                      {ref.resourceName}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

        </div>
      )}
    </>
  );
}
