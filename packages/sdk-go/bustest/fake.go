// Package bustest provides a fake bus.Transport for tests — the Go counterpart
// of core's FaultyTransport, and the reason `bus.Transport` exists as an
// interface at all.
//
// Named for the `net/http/httptest` convention: a testing companion beside the
// package it doubles, kept out of that package's own surface.
//
// It records what was sent and answers with what the test scripted. Consumers
// that would otherwise need a live HTTP server — the launcher's verbs — can be
// exercised in process with no binary, no socket, and no ports.
package bustest

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

// Emitted is one recorded call to Emit.
type Emitted struct {
	Channel bus.Channel
	Payload any
	Scope   string
}

// Fake implements bus.Transport. The zero value is not ready — use NewFake, so
// Subscribers defaults to the honest "unknown" rather than a silent 0 that
// would read as "nobody is listening".
type Fake struct {
	mu sync.Mutex

	// Base is what BaseURL reports.
	Base string
	// Token is whatever the constructor was handed — asserted by tests that
	// care the credential reached the transport at all.
	Token string

	// Subscribers is what Emit returns. -1 (the default from NewFake) is
	// "unknown", 0 is a genuine empty room; tests choose deliberately.
	Subscribers int
	// EmitErr, when set, is returned by Emit instead of a count.
	EmitErr error

	// Replies scripts Request: operation channel → raw reply payload.
	Replies map[bus.Channel]json.RawMessage
	// RequestErr, when set, is returned by Request instead of a reply.
	RequestErr error

	// Emits records every Emit in order — a fan-out verb that drops its
	// second command is invisible to a last-call-only assertion.
	Emits []Emitted
	// Requests records every Request's operation, in order.
	Requests []bus.Channel
}

func NewFake() *Fake {
	return &Fake{
		Base:        "http://fake.test",
		Subscribers: -1, // unknown until a test says otherwise
		Replies:     map[bus.Channel]json.RawMessage{},
	}
}

func (f *Fake) BaseURL() string { return f.Base }

func (f *Fake) Emit(_ context.Context, ch bus.Channel, payload any, scope string) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Emits = append(f.Emits, Emitted{Channel: ch, Payload: payload, Scope: scope})
	if f.EmitErr != nil {
		return -1, f.EmitErr
	}
	return f.Subscribers, nil
}

func (f *Fake) Subscribe(context.Context, []bus.Channel, []bus.Channel, string) (*bus.Subscription, error) {
	// Streaming is not modelled: a fake that returned an empty, never-closing
	// stream would make a `listen` test hang rather than fail. Say so instead.
	return nil, fmt.Errorf("bustest.Fake does not implement Subscribe — use the fake runtime for streaming verbs")
}

func (f *Fake) Request(_ context.Context, op bus.Channel, _ any, _ *bus.RequestOptions) (json.RawMessage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Requests = append(f.Requests, op)
	if f.RequestErr != nil {
		return nil, f.RequestErr
	}
	if reply, ok := f.Replies[op]; ok {
		return reply, nil
	}
	// An unscripted operation is a test bug, and a silent empty reply would let
	// the verb under test "pass" against a reply it never received.
	return nil, fmt.Errorf("bustest.Fake has no scripted reply for %q", op)
}

var _ bus.Transport = (*Fake)(nil)
