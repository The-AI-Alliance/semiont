// The component a recorded event is, by its channel's registry entry. One
// derivation, which every generator that names the payload of a `storedEvent`
// channel asks: generate-ts.mjs, generate-go.mjs and generate-python.mjs for
// each SDK's bus types, packages/codegen/schemas/generate-required.mjs for the
// shape every SDK holds a channel's payload to, and
// packages/codegen/schemas/cache-refresh-table.mjs for the ways the client's
// refresh table reads in it.

/** The component an event on the `storedEvent` channel `entry` is: enriched where the registry says its events are. */
export const storedEventComponent = (entry) => (entry.enriched === true ? 'EnrichedResourceEvent' : 'StoredEventResponse');
