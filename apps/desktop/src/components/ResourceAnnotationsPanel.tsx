import { useMemo, useState } from 'react';
import {
  ANNOTATORS,
  AssessmentEntry,
  CommentEntry,
  HighlightEntry,
  ReferenceEntry,
  TagEntry,
  type AnnotationsCollection,
} from '@semiont/react-ui';
import { getAnnotationExactText, type Annotation, type Motivation } from '@semiont/core';
import type { ChatSession } from '../lib/session';

type Annotator = (typeof ANNOTATORS)[keyof typeof ANNOTATORS];

export function ResourceAnnotationsPanel({
  session,
  annotations,
  loading,
  error,
  onRetry,
  onOpenResource,
}: {
  session: ChatSession;
  annotations: AnnotationsCollection;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  onOpenResource: (id: string) => void;
}) {
  const [includedMotivations, setIncludedMotivations] = useState<Set<Motivation> | null>(null);
  const entries = useMemo(() => {
    const unique = new Map<string, Annotation>();
    Object.values(annotations).flat().forEach((annotation) => unique.set(annotation.id, annotation));
    return [...unique.values()]
      .map((annotation) => ({ annotation, annotator: annotatorFor(annotation) }))
      .sort((a, b) => (b.annotation.created ?? '').localeCompare(a.annotation.created ?? ''));
  }, [annotations]);
  const motivations = useMemo(() => {
    const labels = new Map<Motivation, string>();
    Object.values(ANNOTATORS).forEach((annotator) => labels.set(annotator.motivation, annotator.displayName));
    entries.forEach(({ annotation, annotator }) => {
      motivationOf(annotation).forEach((motivation) => {
        if (!labels.has(motivation)) labels.set(motivation, annotator?.displayName ?? formatMotivation(motivation));
      });
    });
    return [...labels.entries()].map(([value, label]) => ({ value, label }));
  }, [entries]);
  const visibleEntries = entries.filter(({ annotation }) =>
    includedMotivations === null || motivationOf(annotation).some((motivation) => includedMotivations.has(motivation)),
  );
  const filterLabel = includedMotivations === null
    ? 'Include all'
    : includedMotivations.size === 0
      ? 'None'
      : includedMotivations.size === 1
        ? motivations.find(({ value }) => includedMotivations.has(value))?.label ?? '1 selected'
        : `${includedMotivations.size} selected`;

  const toggleMotivation = (motivation: Motivation, checked: boolean) => {
    setIncludedMotivations((current) => {
      const next = current === null ? new Set(motivations.map(({ value }) => value)) : new Set(current);
      if (checked) next.add(motivation);
      else next.delete(motivation);
      return next;
    });
  };

  return (
    <aside className="rview-annotations" aria-label="Annotations for this resource">
      <header className="rview-annotations__header">
        <h2>Annotations</h2>
        <span className="rview-annotations__count" aria-label={`${entries.length} annotations`}>{entries.length}</span>
      </header>

      <details className="rview-annotations__filter">
        <summary>
          <span>Motivation</span>
          <strong>{filterLabel}</strong>
          <Chevron />
        </summary>
        <div className="rview-annotations__filter-options">
          <label>
            <input
              type="checkbox"
              checked={includedMotivations === null}
              onChange={(event) => setIncludedMotivations(event.target.checked ? null : new Set())}
            />
            <span>Include all</span>
          </label>
          {motivations.map(({ value, label }) => (
            <label key={value}>
              <input
                type="checkbox"
                checked={includedMotivations === null || includedMotivations.has(value)}
                onChange={(event) => toggleMotivation(value, event.target.checked)}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </details>

      <div className="rview-annotations__list" aria-live="polite">
        {error !== null ? (
          <div className="rview-annotations__message" role="alert">
            <p>Could not load annotation data.</p>
            <button type="button" onClick={onRetry}>Retry</button>
          </div>
        ) : loading ? (
          <p className="rview-annotations__message">Loading annotations…</p>
        ) : entries.length === 0 ? (
          <p className="rview-annotations__message">No annotations on this resource.</p>
        ) : visibleEntries.length === 0 ? (
          <p className="rview-annotations__message">No annotations match these motivations.</p>
        ) : (
          visibleEntries.map(({ annotation, annotator }) => (
            <AnnotationCard
              key={annotation.id}
              session={session}
              annotation={annotation}
              annotator={annotator}
              onOpenResource={onOpenResource}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function AnnotationCard({
  session,
  annotation,
  annotator,
  onOpenResource,
}: {
  session: ChatSession;
  annotation: Annotation;
  annotator: Annotator | undefined;
  onOpenResource: (id: string) => void;
}) {
  const motivation = motivationOf(annotation)[0];
  const entry = (() => {
    switch (motivation) {
      case 'highlighting':
        return <HighlightEntry session={session} highlight={annotation} isFocused={false} />;
      case 'linking':
        return <ReferenceEntry session={session} reference={annotation} isFocused={false} annotateMode={false} onOpenResource={onOpenResource} />;
      case 'assessing':
        return <AssessmentEntry session={session} assessment={annotation} isFocused={false} />;
      case 'commenting':
        return <CommentEntry session={session} comment={annotation} isFocused={false} annotateMode={false} />;
      case 'tagging':
        return <TagEntry session={session} tag={annotation} isFocused={false} />;
      default:
        return <UnknownAnnotation annotation={annotation} />;
    }
  })();

  return (
    <article className="rview-annotations__item" data-motivation={motivation}>
      <span className="rview-annotations__motivation" title={annotator?.displayName ?? formatMotivation(motivation)}>
        {annotator?.iconEmoji && <span aria-hidden="true">{annotator.iconEmoji}</span>}
        <span>{annotator?.displayName ?? formatMotivation(motivation)}</span>
      </span>
      {entry}
    </article>
  );
}

function UnknownAnnotation({ annotation }: { annotation: Annotation }) {
  const text = getAnnotationExactText(annotation);
  return (
    <div className="semiont-annotation-entry" data-type="unknown">
      {text.length > 0 && <p className="semiont-annotation-entry__quote">“{text}”</p>}
      <code>{annotation.id}</code>
    </div>
  );
}

function annotatorFor(annotation: Annotation): Annotator | undefined {
  return Object.values(ANNOTATORS).find((annotator) => annotator.matchesAnnotation(annotation));
}

function motivationOf(annotation: Annotation): Motivation[] {
  return Array.isArray(annotation.motivation) ? annotation.motivation : [annotation.motivation];
}

function formatMotivation(motivation: Motivation | undefined): string {
  if (motivation === undefined) return 'Other';
  return motivation.replaceAll('-', ' ').replace(/^./u, (letter) => letter.toLocaleUpperCase());
}

function Chevron() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
