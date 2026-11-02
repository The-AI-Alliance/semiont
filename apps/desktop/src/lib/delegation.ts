import type { components, ResourceId } from '@semiont/core';
import type { SelectionMotivation } from '@semiont/react-ui';
import type { ChatSession } from './session';

/**
 * The delegation seam (DELEGATION.md): every "ask the knowledge base's AI to do work on a
 * resource" flows through here as a Task — verb + scope + params, asked by whoever is
 * signed in. Every verb is a `mark` job of one motivation, which the knowledge base's
 * workers take; the SHAPE is what the future is built on: durable SDK tasks re-target
 * `delegate()`, and composer-parsed delegation utterances construct the same Tasks.
 *
 * Who did the work is the record's to say: a worker writes under its own account, and each
 * annotation's `generator` names the engine it ran. Before the work, the knowledge base's
 * engine list declares which model serves each job (`engineForVerb`).
 */
type Schemas = components['schemas'];
type User = Schemas['UserResponse'];
type EngineEntry = Schemas['EngineEntry'];
type Engine = EngineEntry['engine'];
type MarkJobParams = Schemas['MarkJobParams'];

/** Who is asking: whoever is signed in to this session, as the knowledge base knows them
 *  (`auth.me()`): their DID, and their name when the knowledge base holds one. Asked when a
 *  task is delegated. */
export async function requesterFor(session: ChatSession): Promise<User> {
  // `auth` is the client's when it was built against a gateway, as every session here is.
  const auth = session.client.auth;
  if (auth === undefined) throw new Error('This session has no gateway to ask who is signed in.');
  return auth.me();
}

/** Verb + params, one union branch per verb. Every verb is a `mark` job of one motivation,
 *  and its params are the ones that motivation's job takes (the spec's `*JobParams`), less
 *  the ones chat does not offer. `instructions` (the direction string) is offered wherever
 *  the Browser offers it (highlight/assess/comment), and drafting comments requires it;
 *  `tone` where prose is produced (assess/comment). */
export type TaskSpec =
  | { verb: 'find-references'; params: Pick<Schemas['LinkingJobParams'], 'entityTypes'> }
  | { verb: 'highlight'; params: Pick<Schemas['HighlightingJobParams'], 'instructions'> }
  | { verb: 'assess'; params: Pick<Schemas['AssessingJobParams'], 'instructions' | 'tone'> }
  | {
      verb: 'draft-comments';
      params: Required<Pick<Schemas['CommentingJobParams'], 'instructions'>> & Pick<Schemas['CommentingJobParams'], 'tone'>;
    }
  | { verb: 'suggest-tags'; params: Pick<Schemas['TaggingJobParams'], 'schemaId' | 'categories'> };

export type DelegationVerb = TaskSpec['verb'];

/** The motivation of each verb's `mark` job. The one statement of it: the job a verb
 *  becomes, the agent declared to serve it and the form's default verb all read this. */
export const VERB_MOTIVATION = {
  'find-references': 'linking',
  highlight: 'highlighting',
  assess: 'assessing',
  'draft-comments': 'commenting',
  'suggest-tags': 'tagging',
} as const satisfies Record<DelegationVerb, MarkJobParams['motivation']>;

/**
 * The engine the knowledge base declares for a verb (`browse.engines()`): the
 * entry whose `jobs` names `mark` jobs of the verb's motivation, as a worker's claim
 * would. Undefined while the engine list loads, and when no entry declares the job.
 */
export function engineForVerb(engines: EngineEntry[] | undefined, verb: DelegationVerb): Engine | undefined {
  const motivation = VERB_MOTIVATION[verb];
  const entry = engines?.find((e) =>
    e.jobs?.some((job) => job.jobType === 'mark' && job.params.motivation === motivation),
  );
  return entry?.engine;
}

const VERBS = Object.keys(VERB_MOTIVATION) as DelegationVerb[];

/** A motivation some verb's job has. */
type TakenMotivation = (typeof VERB_MOTIVATION)[DelegationVerb];

/**
 * The delegation form's DEFAULT verb follows the app-global selection motivation (the
 * footer control): the verbs are motivation-shaped, so opening the ✨ form with the footer
 * on Highlight should present the highlight verb, and so on. No motivation set → the
 * find-references verb (chat's founding verb).
 */
export function verbForMotivation(motivation: SelectionMotivation | null): DelegationVerb {
  if (motivation === null) return 'find-references';
  // Typed as a motivation some verb takes: a selection motivation react-ui adds that no
  // verb takes stops the build here.
  const taken: TakenMotivation = motivation;
  const verb = VERBS.find((v) => VERB_MOTIVATION[v] === taken);
  if (verb === undefined) throw new Error(`No delegation verb takes the motivation "${taken}"`);
  return verb;
}

/** Display language per verb (Decisions: action-flavored, and NEUTRAL — no editorializing
 *  about what the AI will find "key" or treat as "claims"; "draft"/"suggest" still flag
 *  AI-authored material inviting review). */
export const VERB_INFO: Record<DelegationVerb, { title: string; running: string }> = {
  'find-references': { title: 'Find references', running: 'Finding references…' },
  highlight: { title: 'Highlight', running: 'Highlighting…' },
  assess: { title: 'Assess', running: 'Assessing…' },
  'draft-comments': { title: 'Draft comments', running: 'Drafting comments…' },
  'suggest-tags': { title: 'Suggest tags', running: 'Suggesting tags…' },
};

/** The `mark` job a task is: its verb's motivation, and its params as they are. The switch
 *  narrows the verb, so each branch is checked against that motivation's own schema. */
function jobParamsFor(spec: TaskSpec): MarkJobParams {
  switch (spec.verb) {
    case 'find-references':
      return { motivation: VERB_MOTIVATION[spec.verb], ...spec.params };
    case 'highlight':
      return { motivation: VERB_MOTIVATION[spec.verb], ...spec.params };
    case 'assess':
      return { motivation: VERB_MOTIVATION[spec.verb], ...spec.params };
    case 'draft-comments':
      return { motivation: VERB_MOTIVATION[spec.verb], ...spec.params };
    case 'suggest-tags':
      return { motivation: VERB_MOTIVATION[spec.verb], ...spec.params };
  }
}

export type DelegationTask = TaskSpec & {
  id: string;
  scope: ResourceId;
  requestedBy: User;
  status: 'running' | 'done' | 'failed';
  /** While running: what the executor is working on right now (entity type / stage message). */
  progress?: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
};

let taskCounter = 0;

export function buildTask(
  /** Who is asking (`requesterFor`). */
  requestedBy: User,
  scope: ResourceId,
  spec: TaskSpec,
): DelegationTask {
  return {
    ...spec,
    id: `task-${Date.now()}-${++taskCounter}`,
    scope,
    requestedBy,
    status: 'running',
    startedAt: Date.now(),
  };
}

/**
 * This session's delegated tasks, in order — the in-memory seed of the Phase-2 "your work"
 * queue (nothing renders it yet; a footer indicator / queue panel becomes a rendering
 * exercise). Deliberately NOT persisted: the durable record of delegated work belongs in
 * the KB (Phase 2 task domain), and per-resource provenance persists on the turn.
 */
export const sessionTaskLog: DelegationTask[] = [];

/**
 * Run a Task to completion: every verb is delegated as a `mark` job (`mark.delegate`, see
 * `jobParamsFor`). A job that fails, and one that declines because the resource could not
 * be read, resolve as a `failed` task (callers render, they don't catch).
 */
export async function delegate(
  session: ChatSession,
  task: DelegationTask,
  onUpdate: (task: DelegationTask) => void,
): Promise<DelegationTask> {
  let latest = task;
  const update = (next: DelegationTask) => {
    latest = next;
    onUpdate(next);
  };

  const settle = (outcome: Pick<DelegationTask, 'status'> & { error?: string }): DelegationTask => {
    const base = { ...latest };
    delete base.progress;
    const settled: DelegationTask = { ...base, ...outcome, completedAt: Date.now() };
    update(settled);
    sessionTaskLog.push(settled);
    return settled;
  };

  try {
    const completion = await session.client.mark.delegate(task.scope, jobParamsFor(task)).run((event) => {
      // A failure the queue will try again is a setback, not the end: the stream stays open.
      if (event.kind === 'failed') update({ ...latest, progress: 'retrying' });
      if (event.kind !== 'progress') return;
      // What the run is on right now (an entity type, a tag category), shown as it is;
      // otherwise the progress code (the client renders the code, terse but honest).
      const detail = event.data.current?.value ?? event.data.message?.code;
      if (detail !== undefined && detail.length > 0) update({ ...latest, progress: detail });
    });
    const result = completion.result;
    if (result !== undefined && 'declined' in result) {
      return settle({ status: 'failed', error: `The resource could not be read (${result.reason}).` });
    }
    return settle({ status: 'done' });
  } catch (err) {
    return settle({ status: 'failed', error: err instanceof Error ? err.message : String(err) });
  }
}
