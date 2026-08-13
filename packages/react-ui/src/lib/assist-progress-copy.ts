import type { components } from '@semiont/core';

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

/**
 * The subject line: what is being worked on, with its position when known.
 * Separate from the code copy because the subject is structural (every flow has
 * one or has none) while the code copy is per-phase.
 */
export function assistSubjectCopy(
  t: Translate,
): (label: string, done?: number, total?: number) => string {
  return (label, done, total) =>
    done === undefined || total === undefined
      ? t('subject', { label })
      : t('subjectWithPosition', { label, done: done + 1, total });
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
