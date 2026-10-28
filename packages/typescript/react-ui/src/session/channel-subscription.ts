/**
 * A channel of no scope read by name, on the client's own bus, for the hooks
 * that take their channel as a parameter (`useEventSubscription`,
 * `useSessionEventSubscriptions`). The client's own bus carries its
 * in-process signals and the wire's events alike. Everything else calls the
 * client's typed namespace methods. Not exported from the package.
 *
 * A channel of a resource's scope (`RESOURCE_SCOPED_CHANNELS`: `mark:added`
 * and the other events of the record) is not read here: it reaches only a
 * connection that holds that resource's scope, so it is read on the client's
 * wire for one resource (`wire.frames(channel, resourceId)`), as
 * `useResourceEventSubscriptions` does. Read here, such a channel does not
 * compile, and is refused when called.
 */

import { isResourceScopedChannel } from '@semiont/core';
import type { EventMap, UnscopedChannel } from '@semiont/core';
import type { SemiontClient } from '@semiont/sdk';

/** Hear a channel of no resource's scope. Returns what stops hearing it. */
export function subscribeChannel<K extends UnscopedChannel>(
  client: SemiontClient,
  channel: K,
  handler: (payload: EventMap[K]) => void,
): () => void {
  if (isResourceScopedChannel(channel)) {
    throw new Error(
      `${channel} is delivered on a resource's scope, so a subscription with no resource would hear nothing: client.wire.frames(channel, resourceId)`,
    );
  }
  const sub = client.bus.on(channel).subscribe(handler);
  return () => sub.unsubscribe();
}

