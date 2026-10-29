package semiont

// A client of one knowledge base: its eleven namespaces over a transport, the
// bytes that never ride the bus, and the gateway's own answers.

import (
	"context"
	"errors"
	"sync"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
)

// ClientConfig is what a client is made over. Every field is required.
type ClientConfig struct {
	// Transport is the bus.
	Transport Transport
	// Content carries the bytes, which never ride the bus.
	Content ContentTransport
	// Gateway answers for itself. Over HTTP the transport is all three.
	Gateway GatewayOperations
	// Timing is the waits the client keeps: DefaultTiming(), unless a caller
	// that must not wait them out says otherwise.
	Timing Timing
	// Persistence is where the client keeps what its queries hold, so the
	// next client of the same knowledge base shows it at once; nil for a
	// client that keeps nothing.
	Persistence *CachePersistence
}

// Client is a client of one knowledge base. Its namespaces are its fields:
// c.Browse, c.Mark, and so on.
//
// A client owns a bus of its own (Bus). Its transport delivers into that bus
// every frame it receives, and what the client's own parts say to each other
// (a viewer's signals) goes through it and never reaches the wire.
//
// A client does not open or close its transport: whoever opened that closes
// it, after the client.
type Client struct {
	// Transport is the transport the client was made over, for what the
	// namespaces do not cover: a frame on a channel by name, a hold on a
	// resource's scope.
	Transport Transport
	// Bus is the client's own bus: every frame the transport delivered, and
	// every signal the client's parts gave each other.
	Bus *EventBus
	// Wire is the bus over the transport, typed by channel: an emit, a
	// channel's frames, a request (Emit, Frames, FramesOf, Request).
	Wire *Wire

	// Frame is the vocabulary: what kinds of things exist.
	Frame *FrameNamespace
	// Browse is reads, and this viewer's own signals.
	Browse *BrowseNamespace
	// Mark is annotations, a resource's own metadata, and the annotating of
	// a resource delegated as a job.
	Mark *MarkNamespace
	// Bind is linking a reference to what it refers to.
	Bind *BindNamespace
	// Gather is assembling the context a model is given, and what refers to
	// a resource.
	Gather *GatherNamespace
	// Match is searching: for what a reference could refer to, and for
	// resources by text.
	Match *MatchNamespace
	// Yield is creating resources.
	Yield *YieldNamespace
	// Beckon is attention: driving the other participants' viewers.
	Beckon *BeckonNamespace
	// Job is jobs: their lifecycle, their status, their cancellation, and a
	// worker's claiming of them.
	Job *JobNamespace
	// Auth is the gateway's view of who is signed in.
	Auth *AuthNamespace
	// System is what the knowledge base says about itself.
	System *SystemNamespace

	links     *links
	live      *live
	refresher *refresher
}

// NewClient is a client over config's transport, content and gateway.
func NewClient(config ClientConfig) *Client {
	own := NewEventBus()
	wire := NewWire(config.Transport)
	life, end := context.WithCancel(context.Background())
	l := &links{transport: config.Transport, wire: wire, own: own, timing: config.Timing, life: life, end: end}
	config.Transport.BridgeInto(own)
	queries := newLive(l, config.Content, config.Persistence)
	keeping := newRefresher(l, queries)
	keeping.start()
	return &Client{
		Transport: config.Transport,
		Bus:       own,
		Wire:      wire,
		Frame:     &FrameNamespace{links: l},
		Browse:    &BrowseNamespace{links: l, content: config.Content, live: queries},
		Mark:      &MarkNamespace{links: l},
		Bind:      &BindNamespace{links: l},
		Gather:    &GatherNamespace{links: l, live: queries},
		Match:     &MatchNamespace{links: l, live: queries},
		Yield:     &YieldNamespace{links: l, content: config.Content},
		Beckon:    &BeckonNamespace{links: l},
		Job:       &JobNamespace{links: l},
		Auth:      &AuthNamespace{gateway: config.Gateway},
		System:    &SystemNamespace{gateway: config.Gateway},
		links:     l,
		live:      queries,
		refresher: keeping,
	}
}

// PersistenceSettled reports whether every cache the client keeps is at rest:
// none is fetching, and none owes a save.
func (c *Client) PersistenceSettled() bool { return c.live.persistenceSettled() }

// Close ends the client. Its queries end first: every watcher's states end,
// and a read asked for after is refused as closed. Then its own bus ends, so
// every reader of it and every followed job does, and then the work it
// started has ended. Closing twice is closing once.
func (c *Client) Close() {
	c.refresher.dispose()
	c.live.dispose()
	c.Bus.Close()
	c.links.close()
}

// links is what every namespace reaches the knowledge base through: the
// client's transport, the bus over it, the client's own bus, the waits the
// client keeps, and the work it runs.
type links struct {
	transport Transport
	wire      *Wire
	own       *EventBus
	timing    Timing
	// life is the client's: done once the client has closed.
	life context.Context
	end  context.CancelFunc
	work sync.WaitGroup
}

// run runs work as the client's: given the client's life, and ended by the
// time the client has closed.
func (l *links) run(work func(ctx context.Context)) {
	l.work.Add(1)
	go func() {
		defer l.work.Done()
		work(l.life)
	}()
}

// within is ctx, also done once the client has closed; stop lets it go.
func (l *links) within(ctx context.Context) (inner context.Context, stop func()) {
	inner, cancel := context.WithCancel(ctx)
	unhook := context.AfterFunc(l.life, cancel)
	return inner, func() {
		unhook()
		cancel()
	}
}

// closedUnder is err as its caller hears it: work that ended because the
// client closed, while its caller still waited, failed as closed.
func (l *links) closedUnder(caller context.Context, err error) error {
	if errors.Is(err, context.Canceled) && l.life.Err() != nil && caller.Err() == nil {
		return &BusRequestError{Code: BusRequestErrorCodeClosed, Message: "The client closed before the operation ended"}
	}
	return err
}

// close ends the client's life and waits for the work it started.
func (l *links) close() {
	l.end()
	l.work.Wait()
}

// ask is a request of op, within the client's deadline.
func ask[Q, R, F any](ctx context.Context, l *links, op bus.Operation[Q, R, F], payload Q) (R, error) {
	return Request(ctx, l.wire, op, payload, l.timing.BusRequestTimeout)
}

// drive is a drive at the other participants: one frame over the wire, and
// how many of them the gateway reached, or counted false when it kept no
// count.
func drive[P any](ctx context.Context, l *links, c bus.Emittable[P], payload P) (subscribers int, counted bool, err error) {
	return Emit(ctx, l.wire, c, payload, Envelope{})
}

// signal is a signal to the client's own parts. It never reaches the wire.
// A payload of the registry's types always encodes, so it is always
// published.
func signal[P any](l *links, c bus.Global[P], payload P, envelope Envelope) {
	_ = Publish(l.own, c, payload, envelope)
}

// report is a report over the wire that nobody awaits. The transport tells
// its failures of an emit it could not send, which is where a failure of
// this one is heard.
func report[P any](l *links, c bus.Emittable[P], payload P) {
	l.run(func(ctx context.Context) {
		_, _, _ = Emit(ctx, l.wire, c, payload, Envelope{})
	})
}
