import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from 'react';
import { useObservable } from '@semiont/react-ui';
import type { ResourceId } from '@semiont/core';
import { chatTurn, type PendingReference, type TurnPhase } from '../lib/chat-turn';
import { ingest, mimeTypeFor } from '../lib/ingest';
import { questionHistory } from '../lib/question-history';
import { QUESTION_ENTITY_TYPE, type ChatSession } from '../lib/session';
import { AnswerView } from './AnswerView';
import { MentionComposer, type MentionComposerHandle } from './MentionComposer';
import type { MentionCandidate } from './MentionPicker';
import { UploadRecord } from './UploadRecord';
import type { ViewerPrefs } from './ViewerPrefControls';

/** A question/answer turn in the chat log. */
export interface Turn {
  kind: 'qna';
  id: string;
  question: string;
  // running → answered (answer painted; references marked on demand, additively)
  status: 'running' | 'answered' | 'error';
  // which await the running turn is on (gathering vs yielding)
  phase?: TurnPhase;
  // epoch ms the current phase began — drives the elapsed timer beside the sprite
  phaseStartedAt: number;
  answerId?: ResourceId;
  answerText?: string;
  // present (true) exactly when the generation stopped at the token ceiling —
  // rendered as a quiet marker under the answer, never an error
  answerTruncated?: true;
  // entity types already marked on the answer — the chip shows these as done. (Annotations
  // themselves are NOT stored: the message viewers load them live from the backend.)
  markedEntityTypes?: string[];
  // the question is its own (Question-typed) resource, so it can be marked too — tracked here
  questionId?: ResourceId;
  questionMarkedEntityTypes?: string[];
  error?: string;
}

/** A durable record of a completed upload, interleaved into the chat log. The
 *  transient panel handles the in-progress bar; this is what persists. */
export interface UploadEntry {
  kind: 'upload';
  id: string;
  name: string;
  fileUri: string;
  resourceId?: ResourceId;
  // entity types already marked on the uploaded resource — the chip shows these as done
  markedEntityTypes?: string[];
}

export type LogEntry = Turn | UploadEntry;

export function ChatPane({
  session,
  prefs,
  entries,
  setEntries,
  onResourcesChanged,
  onOpenResource,
}: {
  session: ChatSession;
  /** App-global viewer prefs — threaded to every message viewer (the footer lives in App). */
  prefs: ViewerPrefs;
  /** The active session's log; App owns the sessions store and persists it. */
  entries: LogEntry[];
  setEntries: (updater: (prev: LogEntry[]) => LogEntry[]) => void;
  /** Fired when this pane creates a resource (a finished answer, an upload) so the
   *  document list can refresh itself. */
  onResourcesChanged: () => void;
  /** Open a referenced/uploaded resource in the main pane; bound to this KB by the caller. */
  onOpenResource: (id: string, name: string) => void;
}) {
  const entityTypesState = useObservable(useMemo(() => session.client.browse.entityTypes(), [session]));
  const entityTypes = entityTypesState?.status === 'ready' ? entityTypesState.value : [];
  // Enrich uploads/answers against the corpus vocabulary, never as a Question.
  const docEntityTypes = entityTypes.filter((t) => t !== QUESTION_ENTITY_TYPE);

  // The KB's documents, offered for `@`-mention (Questions excluded, same as the nav list).
  const resourcesState = useObservable(useMemo(() => session.client.browse.resources(), [session]));
  const resources = resourcesState?.status === 'ready' ? resourcesState.value.resources : undefined;
  const mentionDocs: MentionCandidate[] = useMemo(
    () =>
      (resources ?? [])
        .filter((r) => !(r.entityTypes ?? []).includes(QUESTION_ENTITY_TYPE))
        .map((r) => ({ id: String(r['@id']), name: r.name ?? String(r['@id']) })),
    [resources],
  );

  // The mention composer owns all `@`-authoring (contenteditable chips, picker, hovercard —
  // see MentionComposer). ChatPane keeps only a handle (for the @ button + Send) and an
  // is-empty flag for Send's disabled state — no per-keystroke state, so typing no longer
  // re-renders the chat log.
  const composerRef = useRef<MentionComposerHandle>(null);
  const [composerEmpty, setComposerEmpty] = useState(true);

  // This session's past questions, newest-first, for the composer's Up/Down recall. Each
  // entry points at its question RESOURCE (the persisted questionId) — the composer
  // rebuilds chips from that resource's own annotations.
  const history = useMemo(() => questionHistory(entries.filter((e) => e.kind === 'qna')), [entries]);

  // Upload-a-file state. The catch in our case: Semiont needs a storage URI for
  // the resource, which the GUI can't derive — so we ask for it.
  const fileInput = useRef<HTMLInputElement>(null);
  const [staged, setStaged] = useState<File | null>(null);
  const [fileUri, setFileUri] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  // Keep the newest turn in view: auto-scroll the log to the bottom on new content, but
  // only while the user is already near the bottom (don't yank them down if they've
  // scrolled up to read). Sending or uploading forces a stick (see below).
  const logRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  // The stick exists to follow ARRIVING content. A click inside the log (pencil toggle,
  // follow-click, …) is reading intent: the reflow it triggers must not move the view at
  // all. Two forces try to: the watchdog's bottom-pin (bubble grows → yanks the anchor up
  // by the growth), and the BROWSER's clamp (the browse↔annotate swap briefly collapses
  // the bubble → scrollTop clamps to the shrunken max → the regrow leaves the view
  // stranded above where the user was). So for a short window after any in-log
  // pointerdown, the watchdog HOLDS the position it captured instead of pinning —
  // restoring through the shrink/regrow. Explicit user scrolling (wheel/touch) cancels
  // the hold; sending clears it (explicit "take me to my new message").
  const suppressPinUntil = useRef(0);
  const holdScrollTop = useRef<number | null>(null);
  const onLogPointerDown = () => {
    suppressPinUntil.current = Date.now() + 1500;
    holdScrollTop.current = logRef.current?.scrollTop ?? null;
  };
  const onLogUserScroll = () => {
    suppressPinUntil.current = 0;
    holdScrollTop.current = null;
  };
  const onLogScroll = () => {
    const el = logRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  // Bubbles keep growing (and briefly shrinking) long after the entries update — the
  // plain-text fallback swaps to the loaded viewer, markdown reflows, annotations paint,
  // session churn remounts content. Event-driven re-pinning (entries effects, resize
  // observers) loses races against that churn: a shrink lets the browser clamp scrollTop,
  // and the regrowth can land between observer generations. So: one mount-once watchdog
  // that keeps the bottom pinned every frame while the user is actually at the bottom.
  useEffect(() => {
    const el = logRef.current;
    if (el === null) return undefined;
    // Pin ONLY when the content/viewport size changes — never on a quiet tick, so the
    // watchdog can't fight a user gently scrolling up (small trackpad deltas stay inside
    // the stick threshold; a same-size tick must leave their position alone). A timer,
    // not requestAnimationFrame: rAF suspends in occluded/background windows (and in
    // headless panes), exactly when an arriving answer most needs the pin.
    let lastScrollHeight = -1;
    let lastClientHeight = -1;
    const timer = setInterval(() => {
      const held = Date.now() < suppressPinUntil.current && holdScrollTop.current !== null;
      if (held) {
        // Post-interaction: hold the captured position (clamped if the content is
        // momentarily too short — the next tick restores fully once it regrows).
        const target = Math.min(holdScrollTop.current ?? 0, el.scrollHeight - el.clientHeight);
        if (el.scrollTop !== target) el.scrollTop = target;
      } else if (el.scrollHeight !== lastScrollHeight || el.clientHeight !== lastClientHeight) {
        if (stickToBottom.current) el.scrollTop = el.scrollHeight - el.clientHeight;
      }
      lastScrollHeight = el.scrollHeight;
      lastClientHeight = el.clientHeight;
    }, 250);
    return () => clearInterval(timer);
  }, []);

  // The composer hands us the serialized text + the mentions its chips carry (chips are
  // atomic, so no survived-the-edit filtering is needed — a deleted chip is just gone).
  // Mentions aren't stored on the turn: at send they become reference ANNOTATIONS on the
  // question resource — which is what the viewer renders AND what Up-arrow recall rebuilds
  // chips from (the turn's persisted questionId points at them; a chat turn IS a resource).
  const send = async (text: string, mentions: PendingReference[]) => {
    const id = crypto.randomUUID();
    stickToBottom.current = true; // a new question — scroll to it
    suppressPinUntil.current = 0; // sending overrides any in-log interaction hold
    holdScrollTop.current = null;
    setEntries((prev) => [
      ...prev,
      { kind: 'qna', id, question: text, status: 'running', phase: 'gathering', phaseStartedAt: Date.now() },
    ]);

    // Patch the matching Q&A entry by id (upload entries are left untouched).
    const update = (patch: Partial<Turn>) =>
      setEntries((prev) => prev.map((e) => (e.kind === 'qna' && e.id === id ? { ...e, ...patch } : e)));

    try {
      // Each @-mention becomes a real, pre-resolved reference annotation on the question
      // resource (created inside the turn, before gather).
      const run = chatTurn(session, { question: text, references: mentions });
      const { questionId, answerId, answerTruncated } = await run((event) => {
        if (event.kind === 'phase') update({ phase: event.phase, phaseStartedAt: Date.now() });
        // Mid-turn: the question resource (with its mention annotations) exists — mount
        // the annotated question bubble now, not when the answer lands.
        else update({ questionId: event.questionId });
      });

      if (answerId === undefined) {
        update({ status: 'error', error: 'The model produced no answer resource.' });
        return;
      }

      // Paint the answer and rest here. Finding its references (and the question's) is on
      // demand — delegated to the KB AI from each message's annotate cluster (DELEGATION.md).
      // A KB usually has many entity types, and marking all every turn is slow.
      const answerText = await session.client.browse.resourceContent(answerId);
      update({
        status: 'answered',
        answerId,
        answerText,
        questionId,
        ...(answerTruncated === true ? { answerTruncated: true as const } : {}),
        phaseStartedAt: Date.now(),
      });
      onResourcesChanged(); // the answer is a new resource — refresh the document list
    } catch (err) {
      update({ status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  };

  // Completed find-references delegations (DelegationControl runs the task; App persists
  // the entries): record the union of delegated types on the entry — provenance of what was
  // asked, surfaced as dimmed entries in the delegation form. Answer and question are
  // tracked separately.
  const recordAnswerDelegated = (turn: Turn, entityTypes: string[]) => {
    setEntries((prev) =>
      prev.map((e) => {
        if (e.kind !== 'qna' || e.id !== turn.id) return e;
        const markedEntityTypes = [...new Set([...(e.markedEntityTypes ?? []), ...entityTypes])];
        return { ...e, markedEntityTypes };
      }),
    );
  };

  const recordQuestionDelegated = (turn: Turn, entityTypes: string[]) => {
    setEntries((prev) =>
      prev.map((e) => {
        if (e.kind !== 'qna' || e.id !== turn.id) return e;
        const questionMarkedEntityTypes = [...new Set([...(e.questionMarkedEntityTypes ?? []), ...entityTypes])];
        return { ...e, questionMarkedEntityTypes };
      }),
    );
  };

  const recordUploadDelegated = (entry: UploadEntry, entityTypes: string[]) => {
    setEntries((prev) =>
      prev.map((e) => {
        if (e.kind !== 'upload' || e.id !== entry.id) return e;
        const markedEntityTypes = [...new Set([...(e.markedEntityTypes ?? []), ...entityTypes])];
        return { ...e, markedEntityTypes };
      }),
    );
    onResourcesChanged(); // the pass created annotations on the resource
  };

  // Stage a file for upload — shared by the picker and drag-and-drop. The staging
  // panel then asks for the File URI before the actual upload.
  const stageFile = (file: File) => {
    setStaged(file);
    setFileUri(`file://uploads/${file.name}`); // sensible default — the user edits it
    setUploadError(null);
    setUploadPct(0);
  };

  const onPickFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // reset so the same file can be re-picked later
    if (file) stageFile(file);
  };

  // Drag-and-drop onto the chat pane. `dragDepth` counters nested dragenter/leave
  // so the overlay doesn't flicker as the cursor crosses child elements; the
  // `Files` check ignores text/element drags.
  const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files');
  const onDragEnter = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragOver = (event: DragEvent) => {
    if (hasFiles(event)) event.preventDefault(); // required to allow the drop
  };
  const onDragLeave = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDragging(false);
    }
  };
  const onDrop = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) stageFile(file);
  };

  const cancelUpload = () => {
    setStaged(null);
    setFileUri('');
    setUploadError(null);
    setUploadPct(0);
  };

  const upload = async () => {
    const file = staged;
    if (file === null) return;
    const uri = fileUri.trim();
    if (uri.length === 0) return;

    setUploading(true);
    setUploadError(null);
    setUploadPct(0);
    try {
      const { resourceId } = await ingest(session, file, file.name, {
        storageUri: uri,
        // Prefer the browser's sniffed type; fall back to the extension.
        format: file.type || mimeTypeFor(file.name),
        onProgress: (fraction) => setUploadPct(Math.round(fraction * 100)),
      });
      // The resource is created + embedded now — plain, unmarked. Marking its references is
      // on demand via the upload record's chip (see markUpload).
      setUploadPct(100);
      stickToBottom.current = true; // a new upload record — scroll to it
      suppressPinUntil.current = 0; // uploading overrides any in-log interaction hold
      holdScrollTop.current = null;
      setEntries((prev) => [
        ...prev,
        { kind: 'upload', id: crypto.randomUUID(), name: file.name, fileUri: uri, resourceId, markedEntityTypes: [] },
      ]);
      onResourcesChanged(); // the uploaded file is a new resource — refresh the document list
      await new Promise((resolve) => setTimeout(resolve, 500));
      cancelUpload();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  return (
    <section
      className="chat"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragging && (
        <div className="chat__dropzone" aria-hidden="true">
          <span>Drop a file to upload</span>
        </div>
      )}
      <div
        className="chat__log"
        ref={logRef}
        onScroll={onLogScroll}
        onPointerDownCapture={onLogPointerDown}
        onWheel={onLogUserScroll}
        onTouchMove={onLogUserScroll}
      >
        {entries.length === 0 ? (
          <p className="chat__placeholder">Ask a question about your documents.</p>
        ) : (
          entries.map((entry) =>
            entry.kind === 'upload' ? (
              <UploadRecord
                key={entry.id}
                record={entry}
                session={session}
                prefs={prefs}
                markableEntityTypes={docEntityTypes}
                onDelegated={recordUploadDelegated}
                onOpenResource={onOpenResource}
              />
            ) : (
              <AnswerView
                key={entry.id}
                turn={entry}
                session={session}
                prefs={prefs}
                markableEntityTypes={docEntityTypes}
                onDelegated={recordAnswerDelegated}
                onQuestionDelegated={recordQuestionDelegated}
                onOpenResource={onOpenResource}
              />
            ),
          )
        )}
      </div>

      {staged !== null && (
        <div className="upload">
          <div className="upload__head">
            <span className="upload__name">
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              {staged.name}
            </span>
            <button
              type="button"
              className="upload__cancel"
              onClick={cancelUpload}
              disabled={uploading}
              aria-label="Remove file"
            >
              ×
            </button>
          </div>
          <label className="upload__field">
            <span className="upload__label">File URI</span>
            <input
              className="upload__uri"
              value={fileUri}
              onChange={(e) => setFileUri(e.target.value)}
              placeholder="file://uploads/document.txt"
              aria-label="File URI"
            />
          </label>
          {uploadError !== null && (
            <p className="upload__error" role="alert">
              {uploadError}
            </p>
          )}
          {uploading && (
            <div
              className="upload__progress"
              role="progressbar"
              aria-valuenow={uploadPct}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="upload__progress-fill" style={{ width: `${uploadPct}%` }} />
            </div>
          )}
          <div className="upload__actions">
            <button type="button" className="upload__secondary" onClick={cancelUpload} disabled={uploading}>
              Cancel
            </button>
            <button
              type="button"
              className="upload__primary"
              onClick={() => void upload()}
              disabled={uploading || fileUri.trim().length === 0}
            >
              {uploading ? 'Uploading…' : 'Upload'}
            </button>
          </div>
        </div>
      )}

      <form
        className="chat__compose"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          composerRef.current?.submit();
        }}
      >
        <button
          type="button"
          className="chat__attach"
          onClick={() => fileInput.current?.click()}
          aria-label="Attach a file"
          title="Attach a file"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        <input ref={fileInput} type="file" className="chat__file" onChange={onPickFile} tabIndex={-1} aria-hidden="true" />
        <button
          type="button"
          className="chat__mention"
          onClick={() => composerRef.current?.insertMentionTrigger()}
          aria-label="Reference a document"
          title="Reference a document"
        >
          @
        </button>
        <MentionComposer
          ref={composerRef}
          session={session}
          docs={mentionDocs}
          history={history}
          onSubmit={(text, mentions) => void send(text, mentions)}
          onEmptyChange={setComposerEmpty}
        />
        <button type="submit" disabled={composerEmpty}>
          Send
        </button>
      </form>
    </section>
  );
}
