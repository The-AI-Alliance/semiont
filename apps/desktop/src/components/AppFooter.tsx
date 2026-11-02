import { ViewerPrefControls, type ViewerPrefs } from './ViewerPrefControls';

/** What the footer shows about the connected KB: its backend identity (project name +
 *  current branch) plus the user's alias when set. */
export interface KbDisplay {
  name: string;
  branch: string | null;
  alias: string | null;
}

/**
 * The main pane's footer — app chrome, not chat chrome: it renders under EVERY main-pane
 * state (chat, open document, empty/connect prompts), so the KB status, the global viewer
 * pref controls, and the Settings gear are always reachable. `kb` is whichever KB the pane
 * is currently showing (the open document's, else the active chat's; null when none).
 */
export function AppFooter({
  kb,
  prefs,
  onOpenSettings,
}: {
  kb: KbDisplay | null;
  prefs: ViewerPrefs;
  onOpenSettings: () => void;
}) {
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
        <button
          type="button"
          className="app__gear"
          onClick={onOpenSettings}
          aria-label="Settings"
          title="Knowledge bases & browsers"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
