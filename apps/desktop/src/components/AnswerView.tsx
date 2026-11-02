import { useCallback, useRef } from 'react';
import type { ChatSession } from '../lib/session';
import type { ViewerPrefs } from './ViewerPrefControls';
import type { Turn } from './ChatPane';
import { MessageView } from './MessageView';
import { PhaseIndicator } from './PhaseIndicator';

/**
 * One Q&A turn. Both the question and the answer are resources, rendered through the
 * embeddable `ResourceViewer` (via `MessageView`), which owns content rendering, the
 * annotation overlay, reference clicks/hovers, selection-linking, and the annotate-mode
 * cluster (delegation / shape / pencil). This component is just the chrome around them:
 * the bubbles, the phase indicator, and the error state.
 */
export function AnswerView({
  turn,
  session,
  prefs,
  markableEntityTypes,
  onDelegated,
  onQuestionDelegated,
  onOpenResource,
}: {
  turn: Turn;
  /** The connected session — feeds both message viewers. */
  session: ChatSession;
  /** App-global click action + motivation for the viewers. */
  prefs: ViewerPrefs;
  /** The KB's entity types (minus Question) delegable for find-references. */
  markableEntityTypes: string[];
  /** A find-references delegation on the answer completed — record the types on the turn. */
  onDelegated: (turn: Turn, entityTypes: string[]) => void;
  /** Same, on the question resource (tracked separately from the answer's). */
  onQuestionDelegated: (turn: Turn, entityTypes: string[]) => void;
  /** A reference opens its target in the main pane; bound to this KB by the caller. */
  onOpenResource: (id: string, name: string) => void;
}) {
  // A referentially-stable open handler so the memo'd MessageViews don't re-render when the
  // parent passes a fresh closure.
  const openRef = useRef(onOpenResource);
  openRef.current = onOpenResource;
  const openResource = useCallback((id: string, name: string) => openRef.current(id, name), []);

  const answerText = turn.answerText;

  return (
    <article className="turn">
      {turn.questionId !== undefined ? (
        // The question rendered as what it is — a resource — with its reference annotations.
        <div className="turn__q turn__q--viewer">
          <MessageView
            session={session}
            resourceId={String(turn.questionId)}
            content={turn.question}
            prefs={prefs}
            markableEntityTypes={markableEntityTypes}
            delegatedEntityTypes={turn.questionMarkedEntityTypes ?? []}
            onDelegated={(entityTypes) => onQuestionDelegated(turn, entityTypes)}
            onOpenResource={openResource}
          />
        </div>
      ) : (
        // Not a resource yet (turn still running) or a legacy pre-viewer turn: plain text.
        <p className="turn__q">{turn.question}</p>
      )}

      {turn.status === 'running' && (
        <PhaseIndicator phase={turn.phase === 'yielding' ? 'yielding' : 'gathering'} startedAt={turn.phaseStartedAt} />
      )}

      {turn.status === 'error' && (
        <p className="turn__error" role="alert">
          {turn.error}
        </p>
      )}

      {turn.status === 'answered' &&
        answerText !== undefined &&
        (turn.answerId !== undefined ? (
          <div className="turn__answer turn__answer--viewer">
            <MessageView
              session={session}
              resourceId={String(turn.answerId)}
              content={answerText}
              prefs={prefs}
              markableEntityTypes={markableEntityTypes}
              delegatedEntityTypes={turn.markedEntityTypes ?? []}
              onDelegated={(entityTypes) => onDelegated(turn, entityTypes)}
              onOpenResource={openResource}
            />
          </div>
        ) : (
          // Legacy persisted turn without an answer resource id: plain text.
          <div className="turn__answer turn__answer--plain">{answerText}</div>
        ))}

      {turn.status === 'answered' && turn.answerTruncated === true && (
        // Quiet, not an error — the answer above is real and cited, just clipped
        // at the generation length limit (YieldJobDone.truncated).
        <p className="turn__truncated">This answer was cut off at the generation length limit.</p>
      )}
    </article>
  );
}
