package launcher

// transport.go — where verbs get their bus transport.
//
// Every knowledge verb used to construct its own `bus.Client`,
// which meant the only way to observe one was to run the real binary against a
// real HTTP server. One construction point, behind a swappable function, makes
// a verb testable in process (SDK-GO-TRANSPORT P1).
//
// This is the seam, not a factory: production has exactly one implementation
// and the indirection exists for substitutability, which is why it is a plain
// package-level func rather than a registry.

import (
	"context"
	"encoding/json"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

// newTransport builds the transport a verb talks to. Tests replace it via
// UseTransport.
var newTransport = func(base, token string) bus.Transport { return bus.NewClient(base, token) }

// UseTransport swaps the constructor and returns a restore func. Test-only by
// intent; it lives in the non-test file because the variable it closes over
// does, and Go has no narrower visibility that keeps them together.
func UseTransport(f func(base, token string) bus.Transport) (restore func()) {
	prev := newTransport
	newTransport = f
	return func() { newTransport = prev }
}

// sessionTransport is the transport every verb actually holds: the seam's
// client, each call run under the session's renew-and-retry policy
// (session.authorized). The inner client is rebuilt whenever the token
// changes — a bus.Client is bound to the token it was built with — and
// rebuilt THROUGH newTransport, which keeps the seam honest: a test sees
// exactly which token each client was built for, in order.
type sessionTransport struct {
	base  string
	sess  *Session
	token string
	inner bus.Transport
}

var _ bus.Transport = (*sessionTransport)(nil)

func (t *sessionTransport) BaseURL() string { return t.base }

// under is the inner client for a token: built on first use, rebuilt after a
// renewal.
func (t *sessionTransport) under(token string) bus.Transport {
	if t.inner == nil || t.token != token {
		t.inner, t.token = newTransport(t.base, token), token
	}
	return t.inner
}

func (t *sessionTransport) Emit(ctx context.Context, ch bus.Channel, payload any, scope string) (int, error) {
	var n int
	err := t.sess.Authorized(func(token string) (err error) {
		n, err = t.under(token).Emit(ctx, ch, payload, scope)
		return err
	})
	return n, err
}

func (t *sessionTransport) Subscribe(ctx context.Context, channels, scoped []bus.Channel, scope string) (*bus.Subscription, error) {
	var sub *bus.Subscription
	err := t.sess.Authorized(func(token string) (err error) {
		sub, err = t.under(token).Subscribe(ctx, channels, scoped, scope)
		return err
	})
	return sub, err
}

func (t *sessionTransport) Request(ctx context.Context, op bus.Channel, payload any, opts *bus.RequestOptions) (json.RawMessage, error) {
	var reply json.RawMessage
	err := t.sess.Authorized(func(token string) (err error) {
		reply, err = t.under(token).Request(ctx, op, payload, opts)
		return err
	})
	return reply, err
}
