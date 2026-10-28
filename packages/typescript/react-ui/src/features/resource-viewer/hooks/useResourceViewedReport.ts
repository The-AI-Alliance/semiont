import { useEffect, useRef } from 'react';
import type { ResourceId } from '@semiont/core';
import { useSemiont } from '../../../session/SemiontProvider';
import { useObservable } from '../../../hooks/useObservable';

/**
 * Report a resource arrival on `browse:resource-viewed`, so a remote guide can
 * branch on where the participant went.
 *
 * Fires exactly once per arrival, when the resource has finished loading —
 * however the user got here: a followed cue, an in-app link, the back button,
 * a typed URL. That "any means" property is why this lives at the viewer's
 * load-complete transition rather than on any navigation intent path. A
 * re-render never re-reports; arriving at a different resource does.
 *
 * This is the REPORT half of the tour protocol. The imperative half is
 * `browse:resource-open`; they must never share a channel (the driver would
 * hear its own commands, and one viewer's click would steer another's page).
 *
 * @emits browse:resource-viewed - The resource this page shows, once it has loaded. Payload: { resourceId: string }
 */
export function useResourceViewedReport(rid: ResourceId, loaded: boolean): void {
  const semiont = useSemiont();
  const session = useObservable(semiont.activeSession$);
  // Brand once at the boundary: the caller already holds a ResourceId; this
  // hook never re-brands.
  const reported = useRef<ResourceId | null>(null);

  useEffect(() => {
    if (!loaded || !session) return;
    if (reported.current === rid) return;
    reported.current = rid;
    session.client.browse.resourceViewed(rid);
  }, [rid, loaded, session]);
}
