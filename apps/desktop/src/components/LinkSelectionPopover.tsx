import { useMemo, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useObservable } from '@semiont/react-ui';
import { QUESTION_ENTITY_TYPE, type ChatSession } from '../lib/session';
import { MentionPicker, type MentionCandidate } from './MentionPicker';

/**
 * The post-send "link this selection to a resource" chooser (UNIFY plan, D2 path b): a small
 * fixed-position popover with a filter box over the KB's documents, reusing `MentionPicker`'s
 * list. The caller owns what picking does (create the pre-resolved reference) and where the
 * popover sits (the selection's rect). Questions and the message itself are excluded.
 */
export function LinkSelectionPopover({
  session,
  excludeId,
  style,
  onPick,
  onClose,
}: {
  session: ChatSession;
  /** The message's own resource id — a message shouldn't reference itself. */
  excludeId: string;
  /** Fixed positioning computed by the caller from the selection rect. */
  style: CSSProperties;
  onPick: (candidate: MentionCandidate) => void;
  onClose: () => void;
}) {
  const resourcesState = useObservable(useMemo(() => session.client.browse.resources(), [session]));
  const resources = resourcesState?.status === 'ready' ? resourcesState.value.resources : undefined;
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const candidates: MentionCandidate[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (resources ?? [])
      .filter((r) => !(r.entityTypes ?? []).includes(QUESTION_ENTITY_TYPE))
      .map((r) => ({ id: String(r['@id']), name: r.name ?? String(r['@id']) }))
      .filter((c) => c.id !== excludeId && (q.length === 0 || c.name.toLowerCase().includes(q)))
      .slice(0, 8);
  }, [resources, query, excludeId]);
  const activeIndex = Math.min(active, Math.max(0, candidates.length - 1));

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => Math.min(i + 1, candidates.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const pick = candidates[activeIndex];
      if (pick) onPick(pick);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div className="linksel" style={style}>
      <input
        className="linksel__filter"
        autoFocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        placeholder="Link selection to…"
        aria-label="Link selection to a document"
      />
      <MentionPicker candidates={candidates} activeIndex={activeIndex} query={query} onPick={onPick} />
    </div>
  );
}
