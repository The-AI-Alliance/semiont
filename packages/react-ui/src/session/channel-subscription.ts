/**
 * A channel read by name, for the hooks that take their channel as a
 * parameter (`useEventSubscription`, `useSessionEventSubscriptions`,
 * `useResourceEventSubscriptions`). Everything else calls the client's typed
 * namespace methods. Not exported from the package.
 *
 * A channel of a resource's scope (`RESOURCE_SCOPED_CHANNELS`: `mark:added`
 * and the other events of the record) reaches only a connection that holds
 * that resource's scope. So it is read for one resource: the scope is held
 * for as long as the subscription lives, and its handler is given that
 * resource's events and no other's. Read with no resource, such a channel
 * does not compile, and is refused when called; so is any other channel read
 * for a resource.
 */

import { filter } from 'rxjs';
import { isResourceScopedChannel } from '@semiont/core';
import type { EventMap, ResourceId, ResourceScopedChannel, UnscopedChannel } from '@semiont/core';
import type { SemiontClient } from '@semiont/sdk';

/** Hear a channel of no resource's scope. Returns what stops hearing it. */
export function subscribeChannel<K extends UnscopedChannel>(
  client: SemiontClient,
  channel: K,
  handler: (payload: EventMap[K]) => void,
): () => void {
  if (isResourceScopedChannel(channel)) {
    throw new Error(
      `${channel} is delivered on a resource's scope, so a subscription with no resource would hear nothing: subscribeResourceChannel(client, channel, resourceId, handler)`,
    );
  }
  const sub = client.bus.on(channel).subscribe(handler);
  return () => sub.unsubscribe();
}

/** Hear one resource's events on a channel of a resource's scope. Returns what stops hearing them and lets go of the scope. */
export function subscribeResourceChannel<K extends ResourceScopedChannel>(
  client: SemiontClient,
  channel: K,
  resourceId: ResourceId,
  handler: (payload: EventMap[K]) => void,
): () => void {
  if (!isResourceScopedChannel(channel)) {
    throw new Error(
      `${channel} is no resource's channel, so a subscription for a resource would hold a scope and hear nothing: subscribeChannel(client, channel, handler)`,
    );
  }
  const leave = client.transport.subscribeToResource(resourceId);
  // A stream delivers every scope it holds on the one channel, and another
  // reader may hold another resource's.
  const sub = client.bus
    .on(channel)
    .pipe(filter((event) => event.resourceId === resourceId))
    .subscribe(handler);
  return () => {
    sub.unsubscribe();
    leave();
  };
}
