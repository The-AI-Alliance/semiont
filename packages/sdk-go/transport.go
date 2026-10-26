package semiont

// The transport contract (docs/protocol/TRANSPORT-CONTRACT.md): what a client
// needs of whatever carries the bus. The client holds it without naming what
// carries it.

import (
	"context"
	"iter"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

// Transport is the bus: an emit out, frames in, the connection's state, the
// failures it met, the resource scopes it holds and the replies it awaits.
type Transport interface {
	// BaseURL is where the transport is connected to.
	BaseURL() string
	// Emit sends one frame, and resolves when it is accepted: with the number
	// of subscribers it reached, or with counted false when there is no count.
	Emit(ctx context.Context, channel bus.Channel, payload map[string]any, envelope Envelope) (subscribers int, counted bool, err error)
	// Frames is the frames delivered on any of channels from now on, in the
	// order they were delivered. A channel the transport can never deliver is
	// refused, as unsubscribed.
	Frames(channels ...bus.Channel) (iter.Seq[Frame], error)
	// IsSubscribed reports whether the transport delivers channel globally:
	// whether a reply published there can reach this client.
	IsSubscribed(channel bus.Channel) bool
	// SubscribeToResource takes one hold on a resource's scope; release lets
	// it go. The scope is on the stream from its first hold to its last
	// release.
	SubscribeToResource(resource api.ResourceId) (release func())
	// TrackReply awaits the reply to correlationID on one of channels. A
	// request calls it before it emits, so its reply cannot arrive unawaited.
	TrackReply(correlationID string, channels ...bus.Channel) *PendingReply
	// State is the connection's state now.
	State() ConnectionState
	// StateChanges is the connection's state now and each state it moves to,
	// until ctx is done or the loop over it stops.
	StateChanges(ctx context.Context) iter.Seq[ConnectionState]
	// Failures is the failures the transport meets from now on, each as it is
	// returned to its caller. A listener taken as soon as the transport is
	// made hears every one, from its first request.
	Failures() iter.Seq[*TransportError]
	// Close stops the transport: the state becomes closed, every sequence
	// ends, and every request still pending fails as closed. Closing twice is
	// closing once.
	Close()
}
