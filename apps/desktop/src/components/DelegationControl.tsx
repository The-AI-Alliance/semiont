import { useEffect, useMemo, useRef, useState } from 'react';
import { useObservable, type SelectionMotivation } from '@semiont/react-ui';
import {
  isAssessment,
  isComment,
  isHighlight,
  isReference,
  isTag,
  type Annotation,
  type components,
  type ResourceId,
} from '@semiont/core';
import { agentLabel, engineLabel, userLabel } from '../lib/attestation';
import {
  buildTask,
  delegate,
  engineForVerb,
  requesterFor,
  VERB_INFO,
  verbForMotivation,
  type DelegationTask,
  type DelegationVerb,
  type TaskSpec,
} from '../lib/delegation';
import type { ChatSession } from '../lib/session';
import { PhaseIndicator } from './PhaseIndicator';

type Schemas = components['schemas'];
type Agent = Schemas['Agent'];
type AssessTone = NonNullable<Schemas['AssessingJobParams']['tone']>;
type CommentTone = NonNullable<Schemas['CommentingJobParams']['tone']>;

/** Which annotations a verb's pass produces — for reading the worker's attribution back. */
const VERB_RESULT: Record<DelegationVerb, (a: Annotation) => boolean> = {
  'find-references': isReference,
  highlight: isHighlight,
  assess: isAssessment,
  'draft-comments': isComment,
  'suggest-tags': isTag,
};

/** The tones a job of each prose-writing verb takes. The spec states them as types only, so
 *  each list is written out here and held to its type: a tone the spec gains, or one it
 *  drops, stops this from compiling. */
const ASSESS_TONES = Object.keys({
  analytical: true,
  critical: true,
  balanced: true,
  constructive: true,
} satisfies Record<AssessTone, true>) as AssessTone[];
const COMMENT_TONES = Object.keys({
  scholarly: true,
  explanatory: true,
  conversational: true,
  technical: true,
} satisfies Record<CommentTone, true>) as CommentTone[];
const TONES: Partial<Record<DelegationVerb, readonly string[]>> = {
  assess: ASSESS_TONES,
  'draft-comments': COMMENT_TONES,
};

/**
 * The per-resource delegation control (DELEGATION.md): a sparkle badge in the annotate
 * cluster opening a **delegation form** — the engine list entry for the chosen
 * verb ("KB AI" until it loads, or when it declares none), verb (a chooser over the
 * registry), and the verb's own params — running through the `delegate()` seam and
 * streaming to completion.
 * Completed find-references types come back via `onComplete` (the host records provenance)
 * and return as dimmed entries in `delegated`; other verbs have no natural done-set.
 *
 * The done state echoes the Browser's attestation: "By {requester}" always, and
 * "Via {provider model}" when the freshly-fetched annotations carry a `generator`.
 */
export function DelegationControl({
  session,
  resourceId,
  entityTypes,
  delegated,
  motivation,
  onComplete,
  className,
}: {
  session: ChatSession;
  resourceId: ResourceId;
  /** The KB's delegable entity types (Question excluded by the caller). */
  entityTypes: string[];
  /** Types already delegated for find-references on this resource — shown dimmed. */
  delegated: string[];
  /** The app-global selection motivation (the footer control) — the form's default verb
   *  follows it at open time (`verbForMotivation`); an in-form choice wins until reopened. */
  motivation: SelectionMotivation | null;
  /** Completed find-references types — the host records them (per-turn provenance). */
  onComplete?: (entityTypes: string[]) => void;
  /** Placement classes (e.g. `msg__delegctl`). */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [verb, setVerb] = useState<DelegationVerb>(() => verbForMotivation(motivation));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [direction, setDirection] = useState('');
  const [tone, setTone] = useState('');
  const [schemaId, setSchemaId] = useState('');
  const [categories, setCategories] = useState<Set<string>>(new Set());
  const [task, setTask] = useState<DelegationTask | null>(null);
  // Why a task could not be started at all (there is no task to carry the reason).
  const [refusal, setRefusal] = useState<string | null>(null);
  const [via, setVia] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const done = new Set(delegated);
  const tagSchemasState = useObservable(useMemo(() => session.client.browse.tagSchemas(), [session]));
  const tagSchemas = tagSchemasState?.status === 'ready' ? tagSchemasState.value : [];
  const schema = tagSchemas.find((s) => s.id === schemaId) ?? tagSchemas[0];
  // The knowledge base's engine list: which model serves the chosen verb.
  const enginesState = useObservable(useMemo(() => session.client.browse.engines(), [session]));
  const engines = enginesState?.status === 'ready' ? enginesState.value : undefined;
  const running = task?.status === 'running';

  // Click-away closes the popover (a running task keeps running; reopen shows it).
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const pickVerb = (next: DelegationVerb) => {
    setVerb(next);
    setSelected(new Set());
    setDirection('');
    setTone('');
    setCategories(new Set());
  };

  const toggleIn = (set: Set<string>, apply: (next: Set<string>) => void, value: string) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    apply(next);
  };

  // The verb's params from the form — null while the form is incomplete (gates the button).
  const spec = ((): TaskSpec | null => {
    const dir = direction.trim();
    switch (verb) {
      case 'find-references':
        return selected.size > 0 ? { verb, params: { entityTypes: [...selected] } } : null;
      case 'highlight':
        return { verb, params: { ...(dir ? { instructions: dir } : {}) } };
      case 'assess': {
        const chosen = ASSESS_TONES.find((t) => t === tone);
        return { verb, params: { ...(dir ? { instructions: dir } : {}), ...(chosen !== undefined ? { tone: chosen } : {}) } };
      }
      case 'draft-comments': {
        const chosen = COMMENT_TONES.find((t) => t === tone);
        return dir ? { verb, params: { instructions: dir, ...(chosen !== undefined ? { tone: chosen } : {}) } } : null;
      }
      case 'suggest-tags':
        return schema !== undefined && categories.size > 0
          ? { verb, params: { schemaId: schema.id, categories: [...categories] } }
          : null;
    }
  })();

  const run = async () => {
    if (spec === null) return;
    setRefusal(null);
    let requestedBy: DelegationTask['requestedBy'];
    try {
      requestedBy = await requesterFor(session);
    } catch (err) {
      setRefusal(err instanceof Error ? err.message : String(err));
      return;
    }
    const finished = await delegate(session, buildTask(requestedBy, resourceId, spec), setTask);
    if (finished.status !== 'done') return;
    if (spec.verb === 'find-references') {
      onComplete?.(spec.params.entityTypes);
      setSelected(new Set());
    }
    // Fresh fetch paints the new annotations live (the loader subscribes to this cache) and
    // hands us the attribution the worker stamped (`generator` — the engine it ran).
    try {
      const annotations = await session.client.browse.annotations(resourceId).fresh();
      const generators = annotations
        .filter((a) => VERB_RESULT[spec.verb](a))
        .map((a) => (Array.isArray(a.generator) ? a.generator[0] : a.generator))
        .filter((g): g is Agent => g !== undefined);
      const latest = generators[generators.length - 1];
      // Observed attribution beside the declared engine — the same model when all is well.
      setVia(latest !== undefined ? agentLabel(latest) : null);
    } catch {
      // the pass completed; painting arrives via SSE invalidation instead
    }
  };

  // Success OK: the delegation is complete — acknowledge AND close (reopening presents a
  // fresh form). Failure Back: stay open on the form so the user can adjust and retry.
  const dismissResult = () => {
    setTask(null);
    setVia(null);
  };
  const acknowledgeDone = () => {
    dismissResult();
    setOpen(false);
  };

  // The DECLARED engine for the chosen verb — the row changes as the verb does.
  const engine = engineForVerb(engines, verb);
  const runningLabel =
    verb === 'find-references' && task?.progress !== undefined
      ? `Finding ${task.progress} references…`
      : VERB_INFO[task !== null ? task.verb : verb].running;

  return (
    <div className={`deleg${className !== undefined ? ` ${className}` : ''}`} ref={rootRef}>
      <button
        type="button"
        className={`deleg__btn${running ? ' deleg__btn--running' : ''}`}
        onClick={() => {
          // Opening the form (idle): default the verb from the footer motivation — the
          // motivation-shaped verbs should present whatever the user globally selected.
          // (Tag with no registered schemas has no runnable form → keep find-references.)
          if (!open && task === null) {
            const mapped = verbForMotivation(motivation);
            pickVerb(mapped === 'suggest-tags' && tagSchemas.length === 0 ? 'find-references' : mapped);
          }
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        aria-label="Delegate to the KB AI"
        title={running ? runningLabel : 'Delegate to the KB AI'}
      >
        <SparkleGlyph />
      </button>
      {open && (
        <div className="deleg__panel" role="dialog" aria-label="Delegate to the KB AI">
          {engine !== undefined ? (
            <p className="deleg__engine" title="The engine this knowledge base lists for this job">
              <SparkleGlyph /> {engineLabel(engine)}
            </p>
          ) : (
            <p className="deleg__engine" title="The AI provided by this knowledge base">
              <SparkleGlyph /> KB AI
            </p>
          )}
          {task === null || running ? (
            <>
              <select
                className="deleg__verbsel"
                value={verb}
                disabled={running}
                aria-label="What to delegate"
                onChange={(e) => pickVerb(e.target.value as DelegationVerb)}
              >
                {(Object.keys(VERB_INFO) as DelegationVerb[])
                  .filter((v) => v !== 'suggest-tags' || tagSchemas.length > 0)
                  .map((v) => (
                    <option key={v} value={v}>
                      {VERB_INFO[v].title}
                    </option>
                  ))}
              </select>

              {verb === 'find-references' && (
                <ul className="deleg__types">
                  {entityTypes.map((t) => {
                    const already = done.has(t);
                    return (
                      <li key={t}>
                        <label className={`deleg__type${already ? ' deleg__type--done' : ''}`}>
                          <input
                            type="checkbox"
                            checked={already || selected.has(t)}
                            disabled={already || running}
                            onChange={() => !already && toggleIn(selected, setSelected, t)}
                          />
                          <span>{t}</span>
                          {already && (
                            <span className="deleg__check" aria-label="already delegated">
                              ✓
                            </span>
                          )}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}

              {(verb === 'highlight' || verb === 'assess' || verb === 'draft-comments') && (
                <textarea
                  className="deleg__direction"
                  rows={2}
                  placeholder={verb === 'draft-comments' ? 'Direction…' : 'Direction (optional)…'}
                  value={direction}
                  disabled={running}
                  onChange={(e) => setDirection(e.target.value)}
                />
              )}

              {TONES[verb] !== undefined && (
                <select
                  className="deleg__verbsel"
                  value={tone}
                  disabled={running}
                  aria-label="Tone"
                  onChange={(e) => setTone(e.target.value)}
                >
                  <option value="">Default tone</option>
                  {TONES[verb]?.map((t) => (
                    <option key={t} value={t}>
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </option>
                  ))}
                </select>
              )}

              {verb === 'suggest-tags' && schema !== undefined && (
                <>
                  <select
                    className="deleg__verbsel"
                    value={schema.id}
                    disabled={running}
                    aria-label="Tag schema"
                    onChange={(e) => {
                      setSchemaId(e.target.value);
                      setCategories(new Set());
                    }}
                  >
                    {tagSchemas.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  <ul className="deleg__types">
                    {schema.tags.map((c) => (
                      <li key={c.name}>
                        <label className="deleg__type" title={c.description}>
                          <input
                            type="checkbox"
                            checked={categories.has(c.name)}
                            disabled={running}
                            onChange={() => toggleIn(categories, setCategories, c.name)}
                          />
                          <span>{c.name}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {refusal !== null && (
                <p className="deleg__error" role="alert">
                  {refusal}
                </p>
              )}

              {running ? (
                <PhaseIndicator phase="marking" startedAt={task.startedAt} label={runningLabel} />
              ) : (
                <button type="button" className="deleg__go" disabled={spec === null} onClick={() => void run()}>
                  {VERB_INFO[verb].title}
                </button>
              )}
            </>
          ) : task.status === 'done' ? (
            <div className="deleg__result">
              <p>Done — {VERB_INFO[task.verb].title.toLowerCase()}.</p>
              <p className="deleg__attest">
                By {userLabel(task.requestedBy)}
                {via !== null && <> · Via {via}</>}
              </p>
              <button type="button" className="deleg__go" onClick={acknowledgeDone}>
                OK
              </button>
            </div>
          ) : (
            <div className="deleg__result">
              <p className="deleg__error" role="alert">
                {task.error}
              </p>
              <button type="button" className="deleg__go" onClick={dismissResult}>
                Back
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Lucide "sparkles" — the delegated-work glyph.
function SparkleGlyph() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      <path d="M20 3v4" />
      <path d="M22 5h-4" />
    </svg>
  );
}
