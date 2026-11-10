import type { KbConnection } from '../lib/session';

export function WorkspaceTabs({ tabs, activeUri, connections, onSelect, onClose, onAdd }: {
  tabs: { id: string; label: string; uri?: string }[];
  activeUri: string | null;
  connections: Record<string, KbConnection>;
  onSelect: (uri: string) => void;
  onClose: (uri: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className="workspace-tabs" role="tablist" aria-label="Open knowledge bases">
      {tabs.map((tab) => {
        const selected = tab.id === activeUri;
        const connection = tab.uri === undefined ? undefined : connections[tab.uri];
        const label = connection?.description?.name ?? tab.label;
        return (
          <div className={`workspace-tab${selected ? ' workspace-tab--active' : ''}`} key={tab.id}>
            <button
              type="button"
              role="tab"
              aria-selected={selected}
              className="workspace-tab__select"
              onClick={() => onSelect(tab.id)}
              title={tab.uri ?? label}
            >
              <span className={`workspace-tab__status${connection?.opened ? ' workspace-tab__status--connected' : ''}`} aria-hidden="true" />
              <span className="workspace-tab__label">{label}</span>
            </button>
            <button
              type="button"
              className="workspace-tab__close"
              aria-label={`Close ${label} tab`}
              title="Close tab"
              onClick={() => onClose(tab.id)}
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

export function localRootTabId(path: string): string {
  return `local-root:${path}`;
}

export function localRootPathFromTabId(id: string): string | null {
  return id.startsWith('local-root:') ? id.slice('local-root:'.length) : null;
}
