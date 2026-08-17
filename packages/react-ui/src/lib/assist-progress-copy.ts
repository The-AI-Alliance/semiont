import type { components } from '@semiont/core';
import type { AssistProgressTranslations } from '../components/AssistProgress';

type JobProgressMessage = components['schemas']['JobProgressMessage'];

/** The translator shape every call site already holds (`useTranslations(ns)`). */
type Translate = (key: string, params?: Record<string, unknown>) => string;

/**
 * The one code→copy switch (ASSIST-PROGRESS-CONSOLIDATION P3).
 *
 * The wire carries nine codes with typed params; the client owns the sentence.
 * This lives in one place rather than as nine threaded strings, because five
 * call sites would otherwise each hold a copy of the same mapping — which is
 * how the flag sprawl this arc removes got started.
 *
 * **The `switch` is deliberately exhaustive with no `default`.** Adding a code
 * to `JobProgressMessage` makes this a compile error at the `never` assignment,
 * which is the cheapest possible place to learn that copy is missing — earlier
 * than the locale gate, and far earlier than a user seeing a blank status line.
 *
 * Note the code is NOT the copy: `analyzing` renders as "Marking…" because
 * *mark* is this system's domain verb (`client.mark.assist`, the `mark:`
 * channels). The producer reports the phase of work it can honestly know; the
 * client chooses the word. That separation is the point of the coded wire — do
 * not "fix" the divergence by renaming either side.
 */
export function assistProgressCopy(t: Translate): (m: JobProgressMessage) => string {
  return (m) => {
    switch (m.code) {
      case 'loading':
        return t('codeLoading');
      case 'analyzing':
        return t('codeAnalyzing');
      case 'analyzing-tags':
        return t('codeAnalyzingTags');
      case 'generating-resource':
        return t('codeGeneratingResource');
      case 'creating-resource':
        return t('codeCreatingResource');
      case 'complete-generated':
        // Generation's terminal success. Generic by design: the client holds
        // the title it typed, and the outcome (name + link) arrives on
        // job:complete (GENERATE-FROM-RESOURCE D7/D8). A run cut off at the
        // maxTokens ceiling still completes — but never silently (D6): the
        // producer derives the bit, this is where it becomes a sentence.
        return m.truncated ? t('codeCompleteGeneratedTruncated') : t('codeCompleteGenerated');
      case 'detecting-entities':
        // The entity type itself belongs on the subject line beneath, not
        // repeated here — that repetition is defect 2.
        return t('codeDetectingEntities');
      case 'creating-annotations':
        return t('codeCreatingAnnotations', { count: m.count });
      case 'creating-tag-annotations':
        return t('codeCreatingTagAnnotations', { count: m.count });
      case 'complete-created':
        return t('codeCompleteCreated', { count: m.count, kind: t(kindKey(m.kind)) });
      default: {
        const unreachable: never = m;
        return unreachable;
      }
    }
  };
}

/** Annotation kinds are localized too — "7 references" is two translated parts. */
function kindKey(kind: 'highlight' | 'comment' | 'assessment' | 'reference' | 'tag'): string {
  return `kind${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
}

/** What the run is working on — one shape for every flow (CLEAN-PROGRESS D2). */
type Current = components['schemas']['JobProgress']['current'];

/**
 * The subject line: what is being worked on, with its position when known.
 * Separate from the code copy because the subject is structural (every flow has
 * one or has none) while the code copy is per-phase.
 *
 * The wire sends `{ kind, value }`. `kind` is a CODE and gets a localized name;
 * `value` is KB data — an entity type, a tag category — and is shown verbatim.
 * That is the same split as `requestParams`, and it is why the line can read
 * "Entity type: Person (2 of 3)" in any locale without the producer ever
 * composing a sentence.
 */
export function assistSubjectCopy(
  t: Translate,
): (current: NonNullable<Current>, done?: number, total?: number) => string {
  const kindOf = assistSubjectKind(t);
  return (current, done, total) =>
    done === undefined || total === undefined
      ? t('subject', { kind: kindOf(current.kind), label: current.value })
      : t('subjectWithPosition', {
          kind: kindOf(current.kind),
          label: current.value,
          done: done + 1,
          total,
        });
}

/**
 * Localized name for what sort of thing the run is iterating. Exhaustive with a
 * `never` default: a new `kind` on the wire is a compile error here, which is
 * the cheapest place to learn the copy is missing.
 */
function assistSubjectKind(t: Translate): (kind: NonNullable<Current>['kind']) => string {
  return (kind) => {
    switch (kind) {
      case 'entity-type':
        return t('subjectKindEntityType');
      case 'category':
        return t('subjectKindCategory');
      default: {
        const unreachable: never = kind;
        return unreachable;
      }
    }
  };
}

/**
 * Localized NAME for an echoed request parameter. The value beside it is the
 * user's own input and stays verbatim — translating someone's instructions
 * back at them would be absurd.
 *
 * Unknown codes fall back to the code itself: a future parameter shows an ugly
 * name rather than an empty label, and the locale gate will flag the gap.
 */
export function assistParamLabel(t: Translate): (code: string) => string {
  return (code) => {
    switch (code) {
      case 'entity-types': return t('paramEntityTypes');
      case 'instructions': return t('paramInstructions');
      case 'tone': return t('paramTone');
      case 'density': return t('paramDensity');
      default: return code;
    }
  };
}

/**
 * The whole translations object, from one namespace, in one call.
 *
 * Every string `AssistProgress` renders lives in the `AssistProgress` namespace
 * (CLEAN-PROGRESS D3). Before this, four call sites each re-supplied `cancel`
 * and `inProgress` out of their own namespaces — four chances for the widget to
 * read differently depending on which panel you opened, invisible until someone
 * used the app in a locale nobody on the team reads.
 *
 * `found` stays a caller opt-in: only flows that count per-item results pass it,
 * and its copy ("5 found") belongs to the panel that owns those results.
 */
export function assistProgressTranslations(
  t: Translate,
  extra?: Pick<AssistProgressTranslations, 'found'>,
): AssistProgressTranslations {
  return {
    cancel: t('cancel'),
    close: t('close'),
    inProgress: t('inProgress'),
    message: assistProgressCopy(t),
    subject: assistSubjectCopy(t),
    paramLabel: assistParamLabel(t),
    ...(extra?.found ? { found: extra.found } : {}),
  };
}
