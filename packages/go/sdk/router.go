package semiont

// The replies a transport's requests still await. A reply is routed by its
// correlation id to the one request that awaits it, on a channel of its own,
// so no amount of other traffic can cost a request its reply; and the ids
// here are what a transport names when it opens a stream, so a reply
// published while the stream was down is sent again. The refusal of a reply
// that carries the correlation id a request awaits is routed to it the same
// way.

import (
	"slices"
	"sync"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
)

type awaitedReply struct {
	channels []bus.Channel
	// reply takes the one frame that answers; closed, no reply will come.
	reply chan Frame
	// refused takes the refusal of the frame that would have answered.
	refused chan *FrameRefusal
}

// ReplyRouter is the replies a transport's requests still await. A test double
// of a transport routes its replies through one, as a transport does.
type ReplyRouter struct {
	mu      sync.Mutex
	awaited map[string]*awaitedReply
	closed  bool
}

// NewReplyRouter is a router awaiting nothing.
func NewReplyRouter() *ReplyRouter {
	return &ReplyRouter{awaited: map[string]*awaitedReply{}}
}

// PendingReply is a reply a request awaits. Release stops the wait: the
// transport names the reply no more, and one that comes anyway reaches
// nobody.
type PendingReply struct {
	router        *ReplyRouter
	correlationID string
	reply         chan Frame
	refused       chan *FrameRefusal
}

// Reply gives the frame that answers, once; it is closed without one when
// the transport closed first.
func (p *PendingReply) Reply() <-chan Frame { return p.reply }

// Refused gives, once and in place of a Reply, the refusal of the frame
// that would have answered: its transport refused it, and could read its
// correlation id.
func (p *PendingReply) Refused() <-chan *FrameRefusal { return p.refused }

// Release stops the wait.
func (p *PendingReply) Release() { p.router.release(p.correlationID, p.reply) }

// Track awaits the reply to correlationID on one of channels, until the
// PendingReply is released.
func (r *ReplyRouter) Track(correlationID string, channels []bus.Channel) *PendingReply {
	pending := &PendingReply{router: r, correlationID: correlationID, reply: make(chan Frame, 1), refused: make(chan *FrameRefusal, 1)}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		close(pending.reply)
		return pending
	}
	r.awaited[correlationID] = &awaitedReply{channels: channels, reply: pending.reply, refused: pending.refused}
	return pending
}

func (r *ReplyRouter) release(correlationID string, reply chan Frame) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if awaited, ok := r.awaited[correlationID]; ok && awaited.reply == reply {
		delete(r.awaited, correlationID)
	}
}

// Route hands frame to the request that awaits it, if one does.
func (r *ReplyRouter) Route(frame Frame) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if awaited, ok := r.take(frame.CorrelationID, frame.Channel); ok {
		awaited.reply <- frame
	}
}

// RouteRefusal hands refusal to the request awaiting the reply it was
// refused in place of, if one does: the request awaiting the correlation id
// the refusal carries, on its channel. A refusal that carries none reaches
// no request.
func (r *ReplyRouter) RouteRefusal(refusal *FrameRefusal) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if awaited, ok := r.take(refusal.CorrelationID, refusal.Channel); ok {
		awaited.refused <- refusal
	}
}

// take ends the wait for the reply to correlationID on channel, and gives
// it; false when no request awaits that reply. It is called with r.mu held.
func (r *ReplyRouter) take(correlationID string, channel bus.Channel) (*awaitedReply, bool) {
	if correlationID == "" {
		return nil, false
	}
	awaited, ok := r.awaited[correlationID]
	if !ok || !slices.Contains(awaited.channels, channel) {
		return nil, false
	}
	delete(r.awaited, correlationID)
	return awaited, true
}

// IDs is the correlation ids still awaited, in name order.
func (r *ReplyRouter) IDs() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	ids := make([]string, 0, len(r.awaited))
	for id := range r.awaited {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	return ids
}

// Close ends every wait: each request still pending learns no reply will
// come.
func (r *ReplyRouter) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closed = true
	for id, awaited := range r.awaited {
		close(awaited.reply)
		delete(r.awaited, id)
	}
}
