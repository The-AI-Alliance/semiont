package semiont

// The replies a transport's requests still await. A reply is routed by its
// correlation id to the one request that awaits it, on a channel of its own,
// so no amount of other traffic can cost a request its reply; and the ids
// here are what a transport names when it opens a stream, so a reply
// published while the stream was down is sent again.

import (
	"slices"
	"sync"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

type awaitedReply struct {
	channels []bus.Channel
	// reply takes the one frame that answers; closed, no reply will come.
	reply chan Frame
}

type replyRouter struct {
	mu      sync.Mutex
	awaited map[string]*awaitedReply
	closed  bool
}

func newReplyRouter() *replyRouter {
	return &replyRouter{awaited: map[string]*awaitedReply{}}
}

// PendingReply is a reply a request awaits. Release stops the wait: the
// transport names the reply no more, and one that comes anyway reaches
// nobody.
type PendingReply struct {
	router        *replyRouter
	correlationID string
	reply         chan Frame
}

// Reply gives the frame that answers, once; it is closed without one when
// the transport closed first.
func (p *PendingReply) Reply() <-chan Frame { return p.reply }

// Release stops the wait.
func (p *PendingReply) Release() { p.router.release(p.correlationID, p.reply) }

// track awaits the reply to correlationID on one of channels, until the
// PendingReply is released.
func (r *replyRouter) track(correlationID string, channels []bus.Channel) *PendingReply {
	pending := &PendingReply{router: r, correlationID: correlationID, reply: make(chan Frame, 1)}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		close(pending.reply)
		return pending
	}
	r.awaited[correlationID] = &awaitedReply{channels: channels, reply: pending.reply}
	return pending
}

func (r *replyRouter) release(correlationID string, reply chan Frame) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if awaited, ok := r.awaited[correlationID]; ok && awaited.reply == reply {
		delete(r.awaited, correlationID)
	}
}

// route hands frame to the request that awaits it, if one does.
func (r *replyRouter) route(frame Frame) {
	if frame.CorrelationID == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	awaited, ok := r.awaited[frame.CorrelationID]
	if !ok || !slices.Contains(awaited.channels, frame.Channel) {
		return
	}
	delete(r.awaited, frame.CorrelationID)
	awaited.reply <- frame
}

// ids is the correlation ids still awaited, in name order.
func (r *replyRouter) ids() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	ids := make([]string, 0, len(r.awaited))
	for id := range r.awaited {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	return ids
}

// close ends every wait: each request still pending learns no reply will
// come.
func (r *replyRouter) close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closed = true
	for id, awaited := range r.awaited {
		close(awaited.reply)
		delete(r.awaited, id)
	}
}
