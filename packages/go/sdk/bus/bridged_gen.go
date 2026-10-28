// Code generated from specs/src/bus/registry.json — DO NOT EDIT.
//
// Regenerate: node scripts/bus/generate-go.mjs

package bus

// BridgedBroadcasts: channels with no owning operation — job lifecycle, KB
// vocabulary changes, attention signals, SSE infrastructure. These are what a
// client subscribes to when it wants to watch a KB rather than await a reply.
var BridgedBroadcasts = []Channel{
	"job:report-progress",
	"job:complete",
	"job:fail",
	"smelt:settled",
	"frame:entity-type-added",
	"frame:tag-schema-added",
	"yield:created",
	"yield:updated",
	"yield:cloned",
	"yield:moved",
	"beckon:focus",
	"beckon:sparkle",
	"bus:resume-gap",
	"browse:resource-open",
	"browse:resource-viewed",
	"session:joined",
	"session:left",
	"browse:click",
}

// BridgedChannels: everything a transport delivers — the broadcasts plus
// every operation's reply channels. Derived from Operations, so a reply can
// never be missing from the set (the recurring unbridged-reply bug).
var BridgedChannels = func() []Channel {
	out := append([]Channel(nil), BridgedBroadcasts...)
	for _, op := range Operations {
		out = append(out, op.Result, op.Failure)
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

// ResourceScopedChannels: the channels a resource's scope carries, which a
// client holding the scope names in that scope's entry of its subscription.
// Disjoint from BridgedChannels: a channel in both would reach a client twice,
// under two ids.
var ResourceScopedChannels = []Channel{
	"mark:body-updated",
	"yield:representation-added",
	"yield:representation-removed",
	"mark:added",
	"mark:removed",
	"mark:entity-tag-added",
	"mark:entity-tag-removed",
	"mark:archived",
	"mark:unarchived",
	"job:started",
	"job:assigned",
	"job:completed",
	"job:failed",
}

// PersistedEventTypes: the channels of the events of the record, each named
// for the event it carries: every event the event log holds. A follower of the
// record receives each of them (docs/protocol/TRANSPORT-CONTRACT.md § What
// repairs a passing frame).
var PersistedEventTypes = []Channel{
	"yield:created",
	"yield:cloned",
	"yield:updated",
	"yield:moved",
	"yield:representation-added",
	"yield:representation-removed",
	"mark:added",
	"mark:removed",
	"mark:body-updated",
	"mark:entity-tag-added",
	"mark:entity-tag-removed",
	"mark:archived",
	"mark:unarchived",
	"frame:entity-type-added",
	"frame:tag-schema-added",
	"person:profiled",
	"job:started",
	"job:assigned",
	"job:completed",
	"job:failed",
}
