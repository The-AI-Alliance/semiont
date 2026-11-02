import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import { resourceId as brandResourceId } from '@semiont/sdk';
import type { PendingReference } from '../lib/chat-turn';
import { historyStep, mentionsFromAnnotations, type RecallEntry } from '../lib/question-history';
import type { ChatSession } from '../lib/session';
import { MentionPicker, type MentionCandidate } from './MentionPicker';
import { AnchoredHovercard } from './ResourceHovercard';

const HOVER_DELAY_MS = 400;

export interface MentionComposerHandle {
  /** The `@` toolbar button's mouse path: insert an `@` at the caret and open the picker. */
  insertMentionTrigger: () => void;
  /** Serialize + submit (the Send button's path; Enter does this internally). */
  submit: () => void;
  focus: () => void;
}

/**
 * The compose box, upgraded from a plain `<input>` to a `contenteditable` mention-input
 * (UNIFY plan, D3/Phase 3b): typing `@` opens the picker, and a chosen document becomes an
 * **inline, atomic chip** styled with react-ui's own `annotation-reference` class — so a
 * mention looks identical while composing and in the sent message — with the shared
 * `ResourceHovercard` on hover. The DOM is the single source of truth: chips ARE the
 * mentions; serialization walks the editor emitting text (chips as their `@Name` token,
 * which the send path anchors annotations on) plus the `{name, resourceId}` list.
 *
 * Single-line semantics like the old input: Enter submits (Shift+Enter swallowed), Esc
 * closes the picker leaving the literal `@`, paste is forced to plain text.
 *
 * Up/Down are readline-style question recall (the vertical arrows are free in a
 * single-line box, and sent questions are immutable resources — so terminal history, not
 * Slack edit-last): Up walks back through `history` (newest first, clamps at oldest),
 * Down walks forward and past the newest restores the stashed draft (chips intact —
 * stashed as DOM). A recalled question's chips rebuild from **its own resource's
 * annotations** (a chat turn IS a resource; the turn persists only the questionId): the
 * text paints immediately, then the resolved linking annotations arrive and become chip
 * spans — so recall reflects the KB's current reference structure, including references
 * added or deleted since composing. Typing while cycling adopts the recalled line as the
 * new draft; Esc while cycling restores the stash. Picker-open arrows keep their
 * candidate-navigation meaning.
 */
export const MentionComposer = forwardRef<
  MentionComposerHandle,
  {
    session: ChatSession;
    /** The KB's documents offered for mention (Questions already filtered by the caller). */
    docs: MentionCandidate[];
    /** Past questions for Up/Down recall, newest first (`questionHistory` of the log). */
    history: RecallEntry[];
    onSubmit: (text: string, mentions: PendingReference[]) => void;
    /** Fired when the composer flips between empty and non-empty (drives Send's disabled). */
    onEmptyChange: (empty: boolean) => void;
  }
>(function MentionComposer({ session, docs, history, onSubmit, onEmptyChange }, ref) {
  const editorRef = useRef<HTMLDivElement>(null);
  const emptyRef = useRef(true);

  // Open-picker state: the `@…` token under the caret (its text node + offsets).
  const atRef = useRef<{ node: Text; atIdx: number; caret: number } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  // Chip hover → the shared hovercard, after a dwell.
  const [chipHover, setChipHover] = useState<{ rid: string; name: string; rect: DOMRect } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Question recall (Up/Down): the readline cursor and the stashed draft. The stash is
  // innerHTML so an in-progress draft's chips survive a cycle away and back. Refs, not
  // state — recall mutates the DOM directly and nothing else re-renders on it.
  const histIndexRef = useRef<number | null>(null);
  const draftStashRef = useRef<string | null>(null);

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = q.length === 0 ? docs : docs.filter((d) => d.name.toLowerCase().includes(q));
    return matches.slice(0, 8);
  }, [docs, query]);
  const activeIndex = Math.min(active, Math.max(0, candidates.length - 1));

  const closePicker = () => {
    setPickerOpen(false);
    setQuery('');
    atRef.current = null;
  };

  const emitEmpty = () => {
    const text = serialize(editorRef.current).text;
    const empty = text.trim().length === 0;
    if (empty !== emptyRef.current) {
      emptyRef.current = empty;
      onEmptyChange(empty);
    }
  };

  // Is the caret inside an open `@…` token (an `@` at start/whitespace, no whitespace since)?
  const syncMention = () => {
    const editor = editorRef.current;
    const sel = window.getSelection();
    const node = sel?.anchorNode ?? null;
    if (
      editor === null ||
      sel === null ||
      !sel.isCollapsed ||
      node === null ||
      node.nodeType !== Node.TEXT_NODE ||
      !editor.contains(node)
    ) {
      closePicker();
      return;
    }
    const upto = (node.textContent ?? '').slice(0, sel.anchorOffset);
    const atIdx = upto.lastIndexOf('@');
    const boundaryOk = atIdx === 0 || (atIdx > 0 && /[\s ]/.test(upto[atIdx - 1] ?? ''));
    const between = atIdx === -1 ? ' ' : upto.slice(atIdx + 1);
    if (atIdx === -1 || !boundaryOk || /[\s ]/.test(between)) {
      closePicker();
      return;
    }
    atRef.current = { node: node as Text, atIdx, caret: sel.anchorOffset };
    setQuery(between);
    setActive(0);
    setPickerOpen(true);
  };

  // One chip factory for both paths that create chips: picking a candidate, and recall
  // rebuilding a retained mention.
  const makeChip = (rid: string, name: string) => {
    const chip = document.createElement('span');
    chip.className = 'annotation-reference cchip';
    chip.contentEditable = 'false';
    chip.dataset.rid = rid;
    chip.dataset.name = name;
    // The `@` was only the trigger — the chip carries the bare name, exactly as the
    // reference will read in the sent message (and in the stored resource text).
    chip.textContent = name;
    return chip;
  };

  // Lay a recalled question out as text segments + chip spans (mentions arrive validated,
  // sorted, and non-overlapping from `mentionsFromAnnotations`).
  const setEditorFromMentions = (editor: HTMLElement, text: string, mentions: PendingReference[]) => {
    editor.innerHTML = '';
    let pos = 0;
    for (const m of mentions) {
      if (m.start > pos) editor.appendChild(document.createTextNode(text.slice(pos, m.start)));
      editor.appendChild(makeChip(String(m.resourceId), m.name));
      pos = m.end;
    }
    if (pos < text.length) editor.appendChild(document.createTextNode(text.slice(pos)));
  };

  // The async half of recall: the question resource's own resolved linking annotations
  // become chips (a chat turn IS a resource — no parallel mention store). Guarded by the
  // cursor position: if the user cycled or edited meanwhile, the fetch result is dropped.
  // Cache-warm for questions whose bubbles are on screen, so chips usually paint at once.
  const enrichRecall = async (editor: HTMLElement, index: number, entry: RecallEntry) => {
    if (entry.questionId === undefined) return;
    try {
      const annotations = await session.client.browse.annotations(entry.questionId).fresh();
      if (histIndexRef.current !== index) return;
      const mentions = mentionsFromAnnotations(entry.text, annotations);
      if (mentions.length === 0) return;
      setEditorFromMentions(editor, entry.text, mentions);
      caretToEnd(editor);
    } catch {
      // fetch failed — the plain-text recall stands
    }
  };

  const caretToEnd = (editor: HTMLElement) => {
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  };

  // One Up/Down step over past questions. Leaving the draft stashes it (as DOM, chips
  // intact); stepping past the newest restores it. A recalled entry paints its text
  // immediately; its chips follow from the resource's annotations (enrichRecall).
  const recallStep = (direction: 'up' | 'down') => {
    const editor = editorRef.current;
    if (editor === null) return;
    const next = historyStep(history.length, histIndexRef.current, direction);
    if (next === histIndexRef.current) return; // clamped (oldest) or already on the draft
    if (histIndexRef.current === null) draftStashRef.current = editor.innerHTML;
    if (next === null) {
      editor.innerHTML = draftStashRef.current ?? '';
      draftStashRef.current = null;
    } else {
      const entry = history[next];
      if (entry !== undefined) {
        editor.textContent = entry.text;
        void enrichRecall(editor, next, entry);
      }
    }
    histIndexRef.current = next;
    closePicker();
    emitEmpty();
    caretToEnd(editor);
  };

  const restoreDraft = () => {
    const editor = editorRef.current;
    if (editor === null || histIndexRef.current === null) return;
    editor.innerHTML = draftStashRef.current ?? '';
    draftStashRef.current = null;
    histIndexRef.current = null;
    emitEmpty();
    caretToEnd(editor);
  };

  // Replace the open `@query` with an atomic chip + a trailing space; caret lands after it.
  const choose = (candidate: MentionCandidate) => {
    const info = atRef.current;
    const editor = editorRef.current;
    if (info === null || editor === null) return;
    const { node, atIdx, caret } = info;
    const after = node.splitText(atIdx);
    after.deleteData(0, caret - atIdx);

    const chip = makeChip(candidate.id, candidate.name);
    const space = document.createTextNode(' ');

    const parent = after.parentNode;
    if (parent === null) return;
    parent.insertBefore(chip, after);
    parent.insertBefore(space, after);

    const range = document.createRange();
    range.setStart(space, 1);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    closePicker();
    emitEmpty();
    editor.focus();
  };

  const doSubmit = () => {
    const editor = editorRef.current;
    if (editor === null) return;
    const { text, mentions } = serialize(editor);
    if (text.trim().length === 0) return;
    editor.innerHTML = '';
    histIndexRef.current = null;
    draftStashRef.current = null;
    closePicker();
    emitEmpty();
    onSubmit(text.trim(), mentions);
  };

  useImperativeHandle(ref, () => ({
    insertMentionTrigger: () => {
      const editor = editorRef.current;
      if (editor === null) return;
      editor.focus();
      // Space-separate from any preceding word, then let the input handler open the picker.
      const { text } = serialize(editor);
      const needsSpace = text.length > 0 && !/[\s ]$/.test(text);
      document.execCommand('insertText', false, `${needsSpace ? ' ' : ''}@`);
      syncMention();
    },
    submit: doSubmit,
    focus: () => editorRef.current?.focus(),
  }));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (pickerOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActive((i) => Math.min(i + 1, candidates.length - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
        return;
      }
      if (event.key === 'Enter') {
        const pick = candidates[activeIndex];
        if (pick) {
          event.preventDefault();
          choose(pick);
          return;
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closePicker(); // the literal `@` stays, like the old input
        return;
      }
    }
    if (event.key === 'Enter') {
      event.preventDefault(); // single-line: Enter submits, Shift+Enter does nothing
      if (!event.shiftKey) doSubmit();
      return;
    }
    // Readline recall — only when the picker isn't consuming the arrows.
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      recallStep('up');
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      recallStep('down');
      return;
    }
    if (event.key === 'Escape' && histIndexRef.current !== null) {
      event.preventDefault();
      restoreDraft();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault(); // plain text only — no pasted markup in the editor
    document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
  };

  const onMouseOver = (event: React.MouseEvent<HTMLDivElement>) => {
    const chip = event.target instanceof Element ? event.target.closest<HTMLElement>('.cchip') : null;
    if (chip === null || chip.dataset.rid === undefined) return;
    if (hoverTimer.current !== undefined) clearTimeout(hoverTimer.current);
    const rid = chip.dataset.rid;
    const name = chip.dataset.name ?? rid;
    const rect = chip.getBoundingClientRect();
    hoverTimer.current = setTimeout(() => setChipHover({ rid, name, rect }), HOVER_DELAY_MS);
  };
  const onMouseOut = () => {
    if (hoverTimer.current !== undefined) clearTimeout(hoverTimer.current);
    setChipHover(null);
  };

  return (
    <>
      <div
        ref={editorRef}
        className="chat__editor"
        contentEditable
        role="textbox"
        aria-label="Ask a question"
        data-placeholder="Ask a question…"
        onInput={() => {
          // Typing while cycling adopts the recalled text as the new draft (the old
          // stash is superseded — readline's edit-and-fork behavior, simplified).
          if (histIndexRef.current !== null) {
            histIndexRef.current = null;
            draftStashRef.current = null;
          }
          syncMention();
          emitEmpty();
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onMouseOver={onMouseOver}
        onMouseOut={onMouseOut}
        onBlur={() => setTimeout(closePicker, 150) /* let a picker mousedown land first */}
      />
      {pickerOpen && (
        <MentionPicker candidates={candidates} activeIndex={activeIndex} query={query} onPick={choose} />
      )}
      {chipHover !== null && (
        <AnchoredHovercard
          session={session}
          resourceId={chipHover.rid}
          name={chipHover.name}
          anchorRect={chipHover.rect}
        />
      )}
    </>
  );
});

/**
 * Walk the editor: text nodes append verbatim (nbsp → space), chips append their BARE name
 * AND record the mention with its exact span in the emitted text — the send path anchors
 * each reference annotation on those offsets (positional, no token search; the `@` never
 * reaches the serialized text).
 */
function serialize(root: HTMLElement | null): { text: string; mentions: PendingReference[] } {
  const mentions: PendingReference[] = [];
  if (root === null) return { text: '', mentions };
  let text = '';
  root.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += (node.textContent ?? '').replace(/ /g, ' ');
    } else if (node instanceof HTMLElement && node.dataset.rid !== undefined) {
      const name = node.dataset.name ?? '';
      mentions.push({
        kind: 'resource',
        name,
        resourceId: brandResourceId(node.dataset.rid),
        start: text.length,
        end: text.length + name.length,
      });
      text += name;
    } else if (node instanceof HTMLElement && node.tagName !== 'BR') {
      text += (node.textContent ?? '').replace(/ /g, ' '); // stray wrapper (defensive)
    }
  });
  return { text, mentions };
}
