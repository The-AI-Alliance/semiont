import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useObservable } from '@semiont/react-ui';
import type { ResourceId } from '@semiont/core';
import { chatTurn, type PendingReference, type TurnPhase } from '../lib/chat-turn';
import { questionHistory } from '../lib/question-history';
import { QUESTION_ENTITY_TYPE, type ChatSession } from '../lib/session';
import { AnswerView } from './AnswerView';
import { MentionComposer, type MentionComposerHandle } from './MentionComposer';
import type { MentionCandidate } from './MentionPicker';
import { UploadRecord } from './UploadRecord';
import type { ViewerPrefs } from './ViewerPrefControls';
import { ResourceDiscoveryModal } from './ResourceDiscoveryModal';
import {
  AGENT_MODELS,
  AGENT_PROVIDERS,
  isDesktopChatResource,
  type AgentModelId,
  type AgentProviderId,
} from '../lib/agent-bridge';

/** A question/answer turn in the chat log. */
export interface Turn {
  kind: 'qna';
  id: string;
  question?: string;
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
  provider,
  model,
  onProviderChange,
  onModelChange,
  sessionId,
  kbDid,
  currentMessageId,
  setCurrentMessageId,
  prefs,
  entries,
  setEntries,
  onResourcesChanged,
  onOpenResource,
  onNewDocument,
}: {
  session: ChatSession;
  provider: AgentProviderId;
  model: AgentModelId;
  onProviderChange: (provider: AgentProviderId) => void;
  onModelChange: (model: AgentModelId) => void;
  sessionId: string;
  kbDid: string;
  currentMessageId?: ResourceId;
  setCurrentMessageId: (id: ResourceId) => void;
  /** App-global viewer prefs — threaded to message viewers and the composer controls. */
  prefs: ViewerPrefs;
  /** The active session's log; App owns the sessions store and persists it. */
  entries: LogEntry[];
  setEntries: (updater: (prev: LogEntry[]) => LogEntry[]) => void;
  /** Fired when this pane creates a resource (a finished answer, an upload) so the
   *  document list can refresh itself. */
  onResourcesChanged: () => void;
  /** Open a referenced/uploaded resource in the main pane; bound to this KB by the caller. */
  onOpenResource: (id: string, name: string) => void;
  onNewDocument: () => void;
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
        .filter((r) => !isDesktopChatResource(r.name))
        .map((r) => ({ id: String(r['@id']), name: r.name ?? String(r['@id']) })),
    [resources],
  );

  // The mention composer owns all `@`-authoring (contenteditable chips, picker, hovercard —
  // see MentionComposer). ChatPane keeps only a handle (for the @ button + Send) and an
  // is-empty flag for Send's disabled state — no per-keystroke state, so typing no longer
  // re-renders the chat log.
  const composerRef = useRef<MentionComposerHandle>(null);
  const [composerEmpty, setComposerEmpty] = useState(true);
  const [turnRunning, setTurnRunning] = useState(false);
  const [showResourceDiscovery, setShowResourceDiscovery] = useState(false);

  // This session's past questions, newest-first, for the composer's Up/Down recall. Each
  // entry points at its question RESOURCE (the persisted questionId) — the composer
  // rebuilds chips from that resource's own annotations.
  const history = useMemo(
    () => questionHistory(entries.filter((e): e is Turn & { question: string } => e.kind === 'qna' && typeof e.question === 'string')),
    [entries],
  );

  // history.json carries Resource IDs only. Hydrate the visible chat from those KB
  // Resources when a session opens; the KB remains the source of message content.
  useEffect(() => {
    const missing = entries.filter((entry): entry is Turn =>
      entry.kind === 'qna' && ((entry.questionId !== undefined && entry.question === undefined) || (entry.answerId !== undefined && entry.answerText === undefined)),
    );
    if (missing.length === 0) return;
    let cancelled = false;
    void Promise.all(missing.map(async (entry) => {
      const [question, answerText] = await Promise.all([
        entry.questionId !== undefined && entry.question === undefined
          ? session.client.browse.resourceContent(entry.questionId).catch(() => '')
          : Promise.resolve(entry.question),
        entry.answerId !== undefined && entry.answerText === undefined
          ? session.client.browse.resourceContent(entry.answerId).catch(() => '')
          : Promise.resolve(entry.answerText),
      ]);
      return { id: entry.id, question, answerText };
    })).then((loaded) => {
      if (cancelled) return;
      setEntries((prev) => prev.map((entry) => {
        const hydrated = loaded.find((item) => item.id === entry.id);
        if (entry.kind !== 'qna' || hydrated === undefined) return entry;
        return {
          ...entry,
          ...(hydrated.question !== undefined ? { question: hydrated.question } : {}),
          ...(hydrated.answerText !== undefined ? { answerText: hydrated.answerText } : {}),
        };
      }));
    });
    return () => { cancelled = true; };
  }, [entries, session, setEntries]);

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
    if (turnRunning) return;
    setTurnRunning(true);
    const id = crypto.randomUUID();
    stickToBottom.current = true; // a new question — scroll to it
    suppressPinUntil.current = 0; // sending overrides any in-log interaction hold
    holdScrollTop.current = null;
    setEntries((prev) => [
      ...prev,
      { kind: 'qna', id, question: text, status: 'running', phase: 'thinking', phaseStartedAt: Date.now() },
    ]);

    // Patch the matching Q&A entry by id (upload entries are left untouched).
    const update = (patch: Partial<Turn>) =>
      setEntries((prev) => prev.map((e) => (e.kind === 'qna' && e.id === id ? { ...e, ...patch } : e)));

    try {
      // Each @-mention becomes a resolved reference annotation on the user-message Resource.
      const previousMessageId = currentMessageId ?? [...entries].reverse().find(
        (entry): entry is Turn => entry.kind === 'qna' && entry.answerId !== undefined,
      )?.answerId;
      const run = chatTurn(session, {
        question: text,
        provider,
        model,
        references: mentions,
        conversationId: sessionId,
        kbDid,
        ...(previousMessageId !== undefined ? { previousMessageId } : {}),
      }, setCurrentMessageId);
      const { questionId, answerId, answerText } = await run((event) => {
        if (event.kind === 'phase') update({ phase: event.phase, phaseStartedAt: Date.now() });
        else if (event.kind === 'question') update({ questionId: event.questionId });
      });

      if (answerId === undefined) {
        update({ status: 'error', error: 'The model produced no answer resource.' });
        return;
      }

      // Paint the answer and rest here. Finding its references (and the question's) is on
      // demand — delegated to the KB AI from each message's annotate cluster (DELEGATION.md).
      // A KB usually has many entity types, and marking all every turn is slow.
      update({
        status: 'answered',
        answerId,
        answerText,
        questionId,
        phaseStartedAt: Date.now(),
      });
      onResourcesChanged(); // the answer is a new resource — refresh the document list
    } catch (err) {
      update({ status: 'error', error: err instanceof Error ? err.message : String(err) });
    } finally {
      setTurnRunning(false);
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

  return (
    <>
      <section
        className="chat"
      >
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

      <form
        className="chat__compose"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          composerRef.current?.submit();
        }}
      >
        <div className="chat__composer">
          <MentionComposer
            ref={composerRef}
            session={session}
            docs={mentionDocs}
            history={history}
            onSubmit={(text, mentions) => void send(text, mentions)}
            onEmptyChange={setComposerEmpty}
          />
          <div className="chat__composer-tools">
            <div className="chat__composer-actions">
              <button
                type="button"
                className="chat__composer-add"
                onClick={onNewDocument}
                aria-label="Create or add a resource"
                title="Create or add a resource"
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
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
              <button
                type="button"
                className="chat__attach"
                onClick={() => setShowResourceDiscovery(true)}
                aria-label="Search resources"
                title="Search resources"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-4-4" />
                </svg>
              </button>
              <button
                type="button"
                className="chat__mention"
                onClick={() => composerRef.current?.insertMentionTrigger()}
                aria-label="Reference a document"
                title="Reference a document"
              >
                @
              </button>
            </div>
            <div className="chat__model-controls">
              <label className="chat__model-select">
                <select
                  aria-label="Provider"
                  value={provider}
                  onChange={(event) => {
                    const selected = AGENT_PROVIDERS.find((candidate) => candidate.id === event.currentTarget.value);
                    if (selected !== undefined) onProviderChange(selected.id);
                  }}
                >
                  {AGENT_PROVIDERS.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
                </select>
              </label>
              <label className="chat__model-select">
                <select
                  aria-label="Model"
                  value={model}
                  onChange={(event) => {
                    const selected = AGENT_MODELS.find((candidate) => candidate.id === event.currentTarget.value);
                    if (selected !== undefined) onModelChange(selected.id);
                  }}
                >
                  {AGENT_MODELS.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
                </select>
              </label>
              <button
                type="submit"
                className="chat__send"
                disabled={composerEmpty || turnRunning}
                aria-label="Send message"
                title="Send message (Enter)"
              >
                ↵
              </button>
            </div>
          </div>
        </div>
      </form>
      </section>
      {showResourceDiscovery && (
        <ResourceDiscoveryModal
          session={session}
          onClose={() => setShowResourceDiscovery(false)}
          onOpenResource={(id, name) => {
            setShowResourceDiscovery(false);
            onOpenResource(id, name);
          }}
        />
      )}
    </>
  );
}
