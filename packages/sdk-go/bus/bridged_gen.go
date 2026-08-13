// Code generated from specs/src/bus/registry.json — DO NOT EDIT.
//
// Regenerate: node scripts/bus/generate-go.mjs
// The TypeScript side (packages/core/src/bus-protocol.ts) generates from the
// same registry, so the two languages cannot drift apart by hand.

package bus

// BridgedBroadcasts: channels with no owning operation — job lifecycle, KB
// vocabulary changes, attention signals, SSE infrastructure. These are what a
// client subscribes to when it wants to watch a KB rather than await a reply.
var BridgedBroadcasts = []Channel{
	JobReportProgress,
	JobComplete,
	JobFail,
	FrameEntityTypeAdded,
	FrameTagSchemaAdded,
	BeckonFocus,
	BeckonSparkle,
	BusResumeGap,
	BrowseResourceOpen,
	BrowseResourceViewed,
	SessionJoined,
	SessionLeft,
}

// BridgedChannels: everything a transport delivers — the broadcasts plus
// every operation's reply channels. Derived from Operations, so a reply can
// never be missing from the set (the recurring unbridged-reply bug).
var BridgedChannels = func() []Channel {
	out := append([]Channel(nil), BridgedBroadcasts...)
	for _, op := range Operations {
		out = append(out, op.Result, op.Failure)
		if op.Streaming() {
			out = append(out, op.Progress)
		}
	}
	return out
}()

// Bridged reports whether a channel can be received over a transport at all.
// Subscribing to anything else delivers nothing, silently — the trap the bus
// docs warn about.
func Bridged(c Channel) bool {
	for _, b := range BridgedChannels {
		if b == c {
			return true
		}
	}
	return false
}
