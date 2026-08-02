'use client';

export interface EntityFoundEntry {
  entityType: string;
  foundCount: number;
}

export interface EntityFoundLogProps {
  entries: EntityFoundEntry[];
  /** Formats the per-entity count line, e.g. `(n) => t('found', { count: n })`. */
  formatFound: (count: number) => string;
}

/**
 * "✓ Person: 5 found" — the completed entity-type log.
 *
 * One markup for one concept (ASSIST-SURFACE-WARTS Lane B). This was two
 * class families a single panel apart: the live progress display used
 * `semiont-annotation-log*` while ReferencesPanel's post-run form log used
 * `semiont-assist-widget__log*`, with the same rows rendered by hand in both.
 * Presentational and provider-free, like AssistProgress — the caller brings
 * the formatter.
 */
export function EntityFoundLog({ entries, formatFound }: EntityFoundLogProps) {
  if (entries.length === 0) return null;

  return (
    <div className="semiont-annotation-log">
      {entries.map((item, index) => (
        <div key={index} className="semiont-annotation-log-item">
          <span className="semiont-annotation-check">✓</span>
          <span className="semiont-annotation-entity-type">{item.entityType}:</span>
          <span>{formatFound(item.foundCount)}</span>
        </div>
      ))}
    </div>
  );
}
