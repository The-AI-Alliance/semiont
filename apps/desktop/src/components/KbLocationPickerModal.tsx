import { useEffect, useRef, useState } from 'react';
import type { ChatSession } from '../lib/session';
import { isDirectKbDirectory, normalizeKbDirectory } from '../lib/kb-location';

type DirectoryEntry = Awaited<ReturnType<ChatSession['client']['browse']['files']>>['entries'][number];
type Directory = Extract<DirectoryEntry, { type: 'dir' }>;
type FileEntry = Extract<DirectoryEntry, { type: 'file' }>;

type ListingState =
  | { status: 'loading' }
  | { status: 'ready'; entries: DirectoryEntry[] }
  | { status: 'failed'; message: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function KbLocationPickerModal({
  session,
  initialDirectory,
  onChoose,
}: {
  session: ChatSession;
  initialDirectory: string;
  onChoose: (directory: string | null) => void;
}) {
  const initialPath = normalizeKbDirectory(initialDirectory) ?? '';
  const [path, setPath] = useState(initialPath);
  const [listing, setListing] = useState<ListingState>({ status: 'loading' });
  const [retry, setRetry] = useState(0);
  const closeRef = useRef(onChoose);
  closeRef.current = onChoose;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    let current = true;
    setListing({ status: 'loading' });
    void session.client.browse.files(path === '' ? undefined : path, 'name').then((result) => {
      if (current) setListing({ status: 'ready', entries: result.entries });
    }).catch((error: unknown) => {
      if (current) setListing({ status: 'failed', message: errorMessage(error) });
    });
    return () => { current = false; };
  }, [session, path, retry]);

  const segments = path.split('/').filter(Boolean);
  const breadcrumbs = [{ name: 'KB root', path: '' }, ...segments.map((segment, index) => ({
    name: segment,
    path: segments.slice(0, index + 1).join('/'),
  }))];

  const directories: Directory[] = listing.status === 'ready'
    ? listing.entries.filter((entry): entry is Directory => entry.type === 'dir' && isDirectKbDirectory(path, entry.path))
    : [];
  const files: FileEntry[] = listing.status === 'ready'
    ? listing.entries.filter((entry): entry is FileEntry => entry.type === 'file')
    : [];

  return (
    <div className="modal modal--location-picker" onClick={() => onChoose(null)}>
      <section
        className="kb-location-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="kb-location-picker-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="kb-location-picker__header">
          <div>
            <h2 id="kb-location-picker-title">Choose a Knowledge Base location</h2>
            <p>Choose an existing folder in this KB for the new resource.</p>
          </div>
          <button type="button" className="config__close" onClick={() => onChoose(null)} aria-label="Close location picker">×</button>
        </header>

        <nav className="kb-location-picker__breadcrumbs" aria-label="Knowledge Base folder path">
          {breadcrumbs.map((crumb, index) => (
            <span className="kb-location-picker__crumb-wrap" key={crumb.path || 'root'}>
              {index > 0 && <span aria-hidden="true">/</span>}
              <button
                type="button"
                className="kb-location-picker__crumb"
                aria-current={index === breadcrumbs.length - 1 ? 'location' : undefined}
                onClick={() => setPath(crumb.path)}
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </nav>

        <div className="kb-location-picker__listing" aria-live="polite">
          {listing.status === 'loading' && <p className="kb-location-picker__message">Loading folder…</p>}
          {listing.status === 'failed' && (
            <div className="kb-location-picker__failure" role="alert">
              <p>Could not list this folder: {listing.message}</p>
              <button type="button" className="kb__connect" onClick={() => setRetry((value) => value + 1)}>Retry</button>
              {path !== '' && <button type="button" className="kb__connect" onClick={() => setPath('')}>Go to KB root</button>}
            </div>
          )}
          {listing.status === 'ready' && directories.length === 0 && files.length === 0 && (
            <p className="kb-location-picker__message">This folder is empty.</p>
          )}
          {directories.map((directory) => (
            <button
              type="button"
              className="kb-location-picker__entry"
              key={directory.path}
              aria-label={`Open folder ${directory.name}`}
              onClick={() => setPath(directory.path)}
            >
              <span aria-hidden="true">▸</span>
              <span>{directory.name}</span>
              <span aria-hidden="true">›</span>
            </button>
          ))}
          {files.map((file) => (
            <div className="kb-location-picker__entry kb-location-picker__entry--file" key={file.path}>
              <span aria-hidden="true">▤</span>
              <span>{file.name}</span>
              <span className="kb-location-picker__file-kind">{file.tracked ? 'Resource' : 'File'}</span>
            </div>
          ))}
        </div>

        <footer className="kb-location-picker__footer">
          <span>Save in <code>{path || 'KB root'}</code></span>
          <div>
            <button type="button" className="kb__connect kb__connect--on" onClick={() => onChoose(null)}>Cancel</button>
            <button
              type="button"
              className="kb__connect"
              aria-label="Choose this folder"
              disabled={listing.status !== 'ready'}
              onClick={() => onChoose(path)}
            >
              Choose this folder
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
