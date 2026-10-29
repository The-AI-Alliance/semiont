package semiont

// The transport contract (docs/protocol/TRANSPORT-CONTRACT.md): what a client
// needs of whatever carries the bus. The client holds it without naming what
// carries it.

import (
	"context"
	"fmt"
	"iter"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
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
	// order they were delivered, until the loop stops, ctx is done or the
	// transport closes. A channel the transport can never deliver is refused,
	// as unsubscribed.
	Frames(ctx context.Context, channels ...bus.Channel) (iter.Seq[Frame], error)
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
	// State is the connection's state: what it is now, and each state it
	// moves to. A slow reader may see the latest state in place of the ones
	// it missed.
	State() Watched[ConnectionState]
	// BridgeInto delivers into sink, the client's own bus, every frame the
	// transport delivers from now on, each published to everyone there
	// whichever scope it came on. The bus is the client's: a transport never
	// makes one (docs/protocol/TRANSPORT-CONTRACT.md § The bus belongs to the
	// client).
	BridgeInto(sink FrameSink)
	// Failures is the failures the transport meets from now on, each as it is
	// returned to its caller. A listener taken as soon as the transport is
	// made hears every one, from its first request.
	Failures() iter.Seq[*TransportError]
	// Close stops the transport: the state becomes closed, every sequence
	// ends, and every request still pending fails as closed. Closing twice is
	// closing once.
	Close()
}

// Unsubscribed is the refusal a transport gives for a channel it can never
// deliver.
func Unsubscribed(channel bus.Channel) *BusRequestError {
	return &BusRequestError{
		Code:    BusRequestErrorCodeUnsubscribed,
		Message: fmt.Sprintf("Transport is not subscribed to %s: a frame on it can never arrive on this connection. Add the channel to this client's channels.", channel),
	}
}
