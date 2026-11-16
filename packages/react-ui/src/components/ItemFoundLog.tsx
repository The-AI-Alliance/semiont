'use client';

export interface ItemFoundEntry {
  /** The item itself — an entity type, a tag category — shown verbatim. */
  value: string;
  foundCount: number;
}

export interface ItemFoundLogProps {
  entries: ItemFoundEntry[];
  /** Formats the per-entity count line, e.g. `(n) => t('found', { count: n })`. */
  formatFound: (count: number) => string;
}

/**
 * "✓ Person: 5 found" — the completed-items log.
 *
 * One markup for one concept (ASSIST-SURFACE-WARTS Lane B). This was two
 * class families a single panel apart: the live progress display used
 * `semiont-annotation-log*` while ReferencesPanel's post-run form log used
 * `semiont-assist-widget__log*`, with the same rows rendered by hand in both.
 * Presentational and provider-free, like AssistProgress — the caller brings
 * the formatter.
 *
 * Item-shaped rather than entity-type-shaped (CLEAN-PROGRESS D2): the tag flow
 * counts categories the same way the reference flow counts entity types, and a
 * shared component should not be named for one of its callers.
 */
export function ItemFoundLog({ entries, formatFound }: ItemFoundLogProps) {
  if (entries.length === 0) return null;

  return (
    <div className="semiont-annotation-log">
      {entries.map((item, index) => (
        <div key={index} className="semiont-annotation-log-item">
          <span className="semiont-annotation-check">✓</span>
          <span className="semiont-annotation-entity-type">{item.value}:</span>
          <span>{formatFound(item.foundCount)}</span>
        </div>
      ))}
    </div>
  );
}
