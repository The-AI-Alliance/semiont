/** A KB document offered for `@`-mention. */
export interface MentionCandidate {
  id: string;
  name: string;
}

/**
 * The popover that opens while composing an `@Name` mention — a filtered, keyboard-navigable
 * list of the KB's documents. Presentational only: the composer owns the filter query, the
 * active index, and what selecting one does (arrow keys / Enter / Escape are handled there so
 * focus stays in the input). Rows pick on `mousedown` — before the input can blur — so a
 * click doesn't collapse the picker out from under itself.
 */
export function MentionPicker({
  candidates,
  activeIndex,
  query,
  onPick,
}: {
  candidates: MentionCandidate[];
  activeIndex: number;
  query: string;
  onPick: (candidate: MentionCandidate) => void;
}) {
  return (
    <div className="mention" role="listbox" aria-label="Reference a document">
      {candidates.length === 0 ? (
        <p className="mention__empty">
          {query.length > 0 ? `No documents match “${query}”` : 'No documents to reference'}
        </p>
      ) : (
        <ul className="mention__list">
          {candidates.map((candidate, i) => (
            <li key={candidate.id}>
              <button
                type="button"
                role="option"
                aria-selected={i === activeIndex}
                className={`mention__item${i === activeIndex ? ' mention__item--active' : ''}`}
                onMouseDown={(event) => {
                  event.preventDefault(); // keep the composer focused
                  onPick(candidate);
                }}
              >
                <span className="mention__name">{candidate.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
