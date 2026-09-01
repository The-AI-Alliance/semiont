'use client';

import { useEffect, useRef } from 'react';
import type { SemiontBrowser } from '@semiont/sdk';

/**
 * A newly live session opens the Knowledge Base panel.
 *
 * The panel is restored from `localStorage` and the ShellStateUnit is app-scoped,
 * so it survived the signed-out → signed-in transition untouched — nothing in the
 * app reacted to a session appearing. Signing in interactively hid that, because
 * you reach the sign-in control through the KB panel and so happen to already be
 * on it. A session restored at launch never touches it, and lands you on whatever
 * panel you closed the app with.
 *
 * Fires on the transition into a session, which covers both: the first render of
 * an already-restored session, and a later sign-in. Not on every render while
 * signed in — that would fight the resource viewer, which opens the annotations
 * panel on its own.
 *
 * Emits on the bus rather than taking a `ShellStateUnit`, because that is all
 * `openPanel` does and every unit mirrors the bus — so this needs no unit of its
 * own, and the layout does not have to construct one it would otherwise not use.
 */
export function useKbPanelOnLogin(signedIn: boolean, browser: SemiontBrowser): void {
  const wasSignedIn = useRef(false);
  useEffect(() => {
    if (signedIn && !wasSignedIn.current) browser.emit('panel:open', { panel: 'knowledge-base' });
    wasSignedIn.current = signedIn;
  }, [signedIn, browser]);
}
