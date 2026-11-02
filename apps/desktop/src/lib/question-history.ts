import { getBodySource, isResolvedReference, type Annotation, type ResourceId } from '@semiont/core';
import { resourceId as brandResourceId } from '@semiont/sdk';
import type { PendingReference } from './chat-turn';

/**
 * Readline-style question recall for the composer (Up/Down arrows). The vertical arrows
 * are free in a single-line composer, and sent questions are immutable resources — so
 * Slack-style "edit last message" can't apply, and terminal-style history recall is the
 * natural fit for a question-asking app.
 *
 * A chat turn IS a resource: recall entries carry the question-resource id the turn
 * already persists, and chip reconstruction derives from that resource's own linking
 * ANNOTATIONS (`mentionsFromAnnotations`) — the platform vocabulary, no parallel mention
 * store. The KB stays the record: references deleted since composing don't resurrect,
 * references added since composing recall too.
 *
 * Pure logic only; the composer owns the DOM (chip rebuild, draft stash, caret, picker
 * precedence) and the annotation fetch.
 */

/** One recallable question: its text, and (when the turn persisted one) its resource id. */
export interface RecallEntry {
  text: string;
  questionId?: ResourceId;
}

/**
 * One arrow step over the recall list. `index` is the cursor: `null` = the live draft,
 * `0` = the newest past question, higher = older. Up walks back and clamps at the oldest
 * (no wrap); Down walks forward and lands on the draft (`null`) past the newest.
 */
export function historyStep(count: number, index: number | null, direction: 'up' | 'down'): number | null {
  if (direction === 'up') {
    if (count === 0) return null;
    if (index === null) return 0;
    return Math.min(index + 1, count - 1);
  }
  if (index === null || index === 0) return null;
  return index - 1;
}

/**
 * Chronological turns → the newest-first recall list. Duplicates collapse by TEXT to the
 * most recent occurrence (retries of the same question are common); blanks are dropped;
 * turns without a persisted question resource recall as plain text.
 */
export function questionHistory(
  chronological: Array<{ question: string; questionId?: ResourceId }>,
): RecallEntry[] {
  const seen = new Set<string>();
  const newestFirst: RecallEntry[] = [];
  for (let i = chronological.length - 1; i >= 0; i--) {
    const turn = chronological[i];
    const q = turn?.question.trim() ?? '';
    if (turn === undefined || q.length === 0 || seen.has(q)) continue;
    seen.add(q);
    newestFirst.push({
      text: turn.question,
      ...(turn.questionId !== undefined ? { questionId: turn.questionId } : {}),
    });
  }
  return newestFirst;
}

/**
 * Chip reconstruction from the question resource's own annotations: each RESOLVED linking
 * annotation with a text-position anchor that still matches the text becomes a composer
 * mention (the ephemeral send shape — never persisted). Sorted by position; overlaps drop
 * left-to-right; stubs, resource-level references (no selector), and stale offsets are
 * skipped — the send path's never-mis-anchor rule, applied in reverse.
 */
export function mentionsFromAnnotations(text: string, annotations: Annotation[]): PendingReference[] {
  const anchored: PendingReference[] = [];
  for (const annotation of annotations) {
    if (!isResolvedReference(annotation)) continue;
    const referent = getBodySource(annotation.body);
    if (referent === null || referent.length === 0) continue;
    const target = annotation.target;
    if (typeof target === 'string' || target.selector === undefined) continue;
    const selectors = Array.isArray(target.selector) ? target.selector : [target.selector];
    const pos = selectors.find(
      (s): s is { type: 'TextPositionSelector'; start: number; end: number } => s.type === 'TextPositionSelector',
    );
    if (pos === undefined || pos.start < 0 || pos.end > text.length || pos.end <= pos.start) continue;
    const name = text.slice(pos.start, pos.end);
    if (name.trim().length === 0) continue;
    anchored.push({ kind: 'resource', name, resourceId: brandResourceId(referent), start: pos.start, end: pos.end });
  }
  anchored.sort((a, b) => a.start - b.start);
  const mentions: PendingReference[] = [];
  let pos = 0;
  for (const m of anchored) {
    if (m.start < pos) continue; // overlap — first (leftmost) wins
    mentions.push(m);
    pos = m.end;
  }
  return mentions;
}
