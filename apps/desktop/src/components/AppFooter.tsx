import { ViewerPrefControls, type ViewerPrefs } from './ViewerPrefControls';

/** What the footer shows about the connected KB. */
export interface KbDisplay {
  name: string;
  branch: string | null;
  alias: string | null;
}

/** Main-pane app chrome: the current KB and global resource-view preferences. */
export function AppFooter({ kb, prefs }: { kb: KbDisplay | null; prefs: ViewerPrefs }) {
  return (
    <div className="appfooter">
      {kb !== null && (
        <p className="appfooter__kb" title="Connected knowledge base">
          <span className="appfooter__kb-dot" aria-hidden="true" />
          <span className="appfooter__kb-name">{kb.name}</span>
          {kb.branch !== null && <span className="appfooter__kb-branch">{kb.branch}</span>}
          {kb.alias !== null && <span className="appfooter__kb-alias">“{kb.alias}”</span>}
        </p>
      )}
      <div className="appfooter__right">
        <ViewerPrefControls prefs={prefs} />
      </div>
    </div>
  );
}
