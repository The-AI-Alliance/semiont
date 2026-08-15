package bus

// transport.go — the seam. `Transport` is what a consumer needs from the bus,
// stated as an interface so it can be substituted: an HTTP client in
// production, a fake in a test, something else later.
//
// It mirrors the TypeScript `ITransport` (packages/core/src/transport.ts) in
// CONTRACT, deliberately not in shape. That interface carries `on`, `stream`,
// `bridgeInto`, `subscribeToResource` — rxjs Observables and browser
// connection lifecycle. Reproducing them here would be cargo-culting a foreign
// idiom into a language that has channels and `context`. What must match, and
// what the comments below pin, are the wire operations and their semantics:
// the -1 sentinel, and Request's subscribe-before-emit ordering.
//
// Sized for its consumer, per Go practice — four methods, not twelve.

import (
	"context"
	"encoding/json"
)

type Transport interface {
	// BaseURL is what this transport speaks to. For HTTP, an origin; other
	// implementations may return an opaque identifier.
	BaseURL() string

	// Emit publishes one event and reports how many subscribers the target
	// subject had AT DISPATCH.
	//
	// -1 means UNKNOWN — an older backend, an unreadable body, or a transport
	// where the question does not apply. It is deliberately distinct from 0,
	// which means the server counted zero: reporting "nobody is listening" on
	// the strength of a parse failure would be a lie, and it is the same
	// sentinel `ITransport.emit` returns on the TypeScript side. Callers that
	// render this to a human must keep the three cases apart.
	Emit(ctx context.Context, ch Channel, payload any, scope string) (int, error)

	// Subscribe opens a live stream. It returns once the server has ANSWERED,
	// which is the only "you are subscribed" signal the protocol offers.
	Subscribe(ctx context.Context, channels, scoped []Channel, scope string) (*Subscription, error)

	// Request performs the correlated request/reply exchange. The ordering is
	// part of the contract, not an implementation detail: subscribe to the
	// reply channels FIRST, then emit. Emitting first races the subscription
	// and loses fast replies.
	Request(ctx context.Context, op Channel, payload any, opts *RequestOptions) (json.RawMessage, error)
}

// Client is the HTTP implementation. Asserted at compile time so a signature
// change on either side is a build failure rather than a runtime surprise.
var _ Transport = (*Client)(nil)

// BaseURL reports the origin this client was built against.
func (c *Client) BaseURL() string { return c.base }
