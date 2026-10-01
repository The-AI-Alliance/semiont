// The delivery class of every channel that crosses the wire, derived from the
// registry's axes. One derivation: generate-ts.mjs prints it into
// CHANNEL_ATTRS (and the JSON the Rust services embed), and
// scripts/spec/generate-cache-refresh.mjs holds the client's refresh table to
// it.
//
// A frame's guarantee comes from its identity
// (docs/protocol/TRANSPORT-CONTRACT.md § Delivery):
//
//   positioned — a recorded event delivered on its resource's scope. Its id
//                is its place in that resource's record, so a client that
//                names the last one it holds is sent what it missed.
//   correlated — the reply to a claimed request. Its id is the request's, so
//                the client that asked can recognise it, and be sent it again
//                while it is retained.
//   passing    — every other frame. Nothing replays it.

export const DELIVERY_CLASSES = ['positioned', 'correlated', 'passing'];

/** Each wire-crossing channel's class. A channel that never crosses (`inProcess`) has none. */
export function deliveryClasses(registry) {
  const recorded = new Set(registry.channels.filter((entry) => entry.event).map((entry) => entry.channel));
  const classes = new Map();
  const set = (channel, delivery) => {
    const prior = classes.get(channel);
    if (prior !== undefined && prior !== delivery) throw new Error(`registry: "${channel}" is delivered as both ${prior} and ${delivery}`);
    classes.set(channel, delivery);
  };
  for (const operation of registry.operations) {
    set(operation.request, 'passing');
    set(operation.result, 'correlated');
    set(operation.failure, 'correlated');
  }
  // A position is a place in a resource's record: it takes both a record and a scope.
  for (const channel of registry.audience.scoped) set(channel, recorded.has(channel) ? 'positioned' : 'passing');
  for (const channel of [...registry.audience.everyone, ...registry.audience.declared]) set(channel, 'passing');
  return classes;
}
