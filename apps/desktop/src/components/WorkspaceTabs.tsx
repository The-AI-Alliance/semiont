import type { KbEntry } from '../lib/user-config';
import type { KbConnection } from '../lib/session';

export function WorkspaceTabs({ tabs, activeUri, connections, onSelect, onClose, onAdd }: {
  tabs: KbEntry[];
  activeUri: string | null;
  connections: Record<string, KbConnection>;
  onSelect: (uri: string) => void;
  onClose: (uri: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className="workspace-tabs" role="tablist" aria-label="Open knowledge bases">
      {tabs.map((kb) => {
        const selected = kb.uri === activeUri;
        const connection = connections[kb.uri];
        const label = connection?.description?.name ?? kb.alias ?? hostOf(kb.uri);
        return (
          <div className={`workspace-tab${selected ? ' workspace-tab--active' : ''}`} key={kb.uri}>
            <button
              type="button"
              role="tab"
              aria-selected={selected}
              className="workspace-tab__select"
              onClick={() => onSelect(kb.uri)}
              title={kb.uri}
            >
              <span className={`workspace-tab__status${connection?.opened ? ' workspace-tab__status--connected' : ''}`} aria-hidden="true" />
              <span className="workspace-tab__label">{label}</span>
            </button>
            <button
              type="button"
              className="workspace-tab__close"
              aria-label={`Close ${label} tab`}
              title="Close tab"
              onClick={() => onClose(kb.uri)}
            >
              ×
            </button>
          </div>
        );
      })}
      <button type="button" className="workspace-tabs__add" onClick={onAdd} aria-label="Add a knowledge base tab" title="Add a knowledge base tab">+</button>
    </div>
  );
}

function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}
