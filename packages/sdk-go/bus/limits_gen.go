// Code generated from specs/src/paths/bus_emit.json — DO NOT EDIT.
//
// Regenerate: node scripts/bus/generate-go.mjs

package bus

// maxEmitBytes is POST /bus/emit's x-semiont-limits.maxBodyBytes: the largest
// body the gateway takes, and so the largest payload a frame on the event
// stream carries.
const maxEmitBytes = 4194304
