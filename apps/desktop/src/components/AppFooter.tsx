import { ViewerPrefControls, type ViewerPrefs } from './ViewerPrefControls';

/** Main-pane app chrome: global resource-view preferences. */
export function AppFooter({ prefs }: { prefs: ViewerPrefs }) {
  return (
    <div className="appfooter">
      <div className="appfooter__right">
        <ViewerPrefControls prefs={prefs} />
      </div>
    </div>
  );
}
