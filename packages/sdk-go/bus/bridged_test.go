package bus

// The Go counterpart of packages/core/src/__tests__/bus-invariants.test.ts.
//
// TypeScript catches most of these at compile time through `satisfies`
// clauses; Go has no equivalent, so the same properties are asserted at test
// time. Both languages generate from specs/src/bus/registry.json, so today
// these are a second opinion rather than the only guard — which is the point.
// A generated artifact checked only against the thing that generated it can
// agree with a mistake indefinitely.

import "testing"

// A duplicate in the bridged set makes the backend SSE forwarder subscribe
// twice — it maps `?channel=` entries 1:1 with no dedup — so every event on
// that channel arrives twice (.plans/bugs/BRIDGE-GAPS.md).
func TestBridgedChannelsHasNoDuplicates(t *testing.T) {
	seen := map[Channel]bool{}
	for _, c := range BridgedChannels {
		if seen[c] {
			t.Errorf("%q appears more than once in BridgedChannels — it would be delivered twice", c)
		}
		seen[c] = true
	}
}

// Every operation's reply must be receivable. A reply that isn't bridged is
// never delivered, so the caller waits out the full timeout with no error —
// the silent failure the derivation exists to make impossible.
func TestEveryOperationReplyIsBridged(t *testing.T) {
	for req, op := range Operations {
		for _, ch := range []Channel{op.Result, op.Failure} {
			if !Bridged(ch) {
				t.Errorf("operation %q: reply %q is not bridged — a caller would hang until timeout", req, ch)
			}
		}
		if op.Streaming() && !Bridged(op.Progress) {
			t.Errorf("operation %q: progress %q is not bridged — streaming updates would be dropped", req, op.Progress)
		}
	}
}

// A broadcast is by definition a channel no operation owns. One that is also
// a reply is bridged twice: once listed, once derived.
func TestBroadcastsAreDisjointFromOperationReplies(t *testing.T) {
	replies := map[Channel]Channel{} // reply → owning request
	for req, op := range Operations {
		replies[op.Result] = req
		replies[op.Failure] = req
		if op.Streaming() {
			replies[op.Progress] = req
		}
	}
	for _, b := range BridgedBroadcasts {
		if owner, isReply := replies[b]; isReply {
			t.Errorf("broadcast %q is the reply of operation %q — it is already bridged by derivation", b, owner)
		}
	}
}

// Every operation must be emittable: busRequest sends on the request channel,
// and /bus/emit validates it against the schema ChannelSchemas names.
func TestEveryOperationRequestIsEmittable(t *testing.T) {
	for req := range Operations {
		if !req.Emittable() {
			t.Errorf("operation %q has no entry in ChannelSchemas — Emit refuses it, so the operation can never be invoked", req)
		}
	}
}

// Bridged() is the predicate callers use; it must agree with the slice
// BridgedChannels exposes, or `listen` warns about channels it then receives.
func TestBridgedAgreesWithTheChannelList(t *testing.T) {
	for _, c := range BridgedChannels {
		if !Bridged(c) {
			t.Errorf("%q is in BridgedChannels but Bridged() says otherwise", c)
		}
	}
	if Bridged("definitely:not-a-channel") {
		t.Error("Bridged() accepted a channel that does not exist")
	}
}
