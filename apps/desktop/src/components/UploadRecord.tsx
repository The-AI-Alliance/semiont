import type { ChatSession } from '../lib/session';
import type { ViewerPrefs } from './ViewerPrefControls';
import type { UploadEntry } from './ChatPane';
import { MessageView } from './MessageView';
import { ResourceChip } from './ResourceChip';

/**
 * A compact, durable record of a completed upload in the chat log — so an upload is a
 * visible event in the conversation, not just a transient panel that vanishes. The filename
 * opens the new resource in the main pane. The document itself renders inline via
 * `MessageView`, whose annotate-mode cluster (delegation / shape / pencil) is where
 * find-references delegation lives (the uploaded resource is created plain, so nothing is
 * marked until the user asks).
 */
export function UploadRecord({
  record,
  session,
  prefs,
  markableEntityTypes,
  onDelegated,
  onOpenResource,
}: {
  record: UploadEntry;
  /** The connected session — powers the file chip's hover preview. */
  session: ChatSession;
  /** App-global click action + motivation for the inline viewer. */
  prefs: ViewerPrefs;
  /** The KB's entity types (minus Question) delegable for find-references. */
  markableEntityTypes: string[];
  /** A find-references delegation on this upload completed — record the types. */
  onDelegated: (entry: UploadEntry, entityTypes: string[]) => void;
  /** Open the uploaded document in the main pane. */
  onOpenResource: (id: string, name: string) => void;
}) {
  return (
    <div className="uprec">
      <div className="uprec__row">
        <svg
          className="uprec__icon"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
        <span className="uprec__text">
          Uploaded{' '}
          {record.resourceId !== undefined ? (
            <ResourceChip
              label={record.name}
              session={session}
              resourceId={String(record.resourceId)}
              fileUri={record.fileUri}
              onOpen={() => onOpenResource(String(record.resourceId), record.name)}
            />
          ) : (
            <ResourceChip label={record.name} />
          )}
        </span>
      </div>

      {record.resourceId !== undefined && (
        // The uploaded document itself, inline via the embeddable viewer (image/pdf through a
        // media-token URL; text fetched) — the message IS the resource.
        <div className="uprec__viewer">
          <MessageView
            session={session}
            resourceId={String(record.resourceId)}
            prefs={prefs}
            markableEntityTypes={markableEntityTypes}
            delegatedEntityTypes={record.markedEntityTypes ?? []}
            onDelegated={(entityTypes) => onDelegated(record, entityTypes)}
            onOpenResource={onOpenResource}
          />
        </div>
      )}
    </div>
  );
}
