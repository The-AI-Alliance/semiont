package semiont

// The stream (docs/protocol/TRANSPORT-HTTP.md § The client): one goroutine
// that owns the subscription, the connections that carry it, and the state
// they add up to.
//
// A client holds one live stream. Two things replace it, and they are
// different things:
//
//   - A drop: the stream ended, or a connect failed with none live. For a
//     while frames are not delivered, the state leaves open, and the stream is
//     opened again on a backoff, naming each scope's last position and the
//     replies still awaited.
//   - A handoff: the subscription changed. A second connection is opened
//     beside the live one and takes over once it is open; the old one keeps
//     being read for the linger and is closed then. Nothing is missed, so the
//     state stays open.
//
// While both connections of a handoff are read, a frame with an identity of
// its own is delivered once: the ids of the last frames delivered are
// remembered, and a frame whose id is among them is dropped.
//
// Connections are goroutines that only read; everything they read comes back
// to the stream's goroutine in order, so the state machine has no locks and
// no races. Nothing the stream knows is touched by any other goroutine.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
)

type commandKind int

const (
	// commandAddScope is a resource's scope getting its first hold.
	commandAddScope commandKind = iota
	// commandRemoveScope is a resource's scope losing its last hold.
	commandRemoveScope
	// commandClose ends the stream.
	commandClose
)

type command struct {
	kind     commandKind
	resource api.ResourceId
}

type eventKind int

const (
	// eventOpened is a subscribe response that is streaming.
	eventOpened eventKind = iota
	// eventFrame is an event of the stream, with the id it came under.
	eventFrame
	// eventRefused is a connect the gateway answered, and not with a stream.
	eventRefused
	// eventEnded is a connect that got no answer, or a stream that ended.
	eventEnded
	// eventRenewed is the refresher's answer: a renewed token, or none.
	eventRenewed
)

// streamEvent is what a connection, or the renewal of a token, reports to the
// stream's goroutine.
type streamEvent struct {
	kind  eventKind
	conn  uint64
	id    string
	hasID bool
	data  string
	err   *TransportError
	// token and renewed are a renewal's answer; keepPrevious, whether the
	// connect it is for was a handoff.
	token        string
	renewed      bool
	keepPrevious bool
}

type connection struct {
	cancel context.CancelFunc
	// token is what the connect sent: what is remembered if it is refused.
	token string
	// keepPrevious is whether it was opened beside a live stream, to take
	// over from it.
	keepPrevious bool
	// previous is the connections it retires once it is open.
	previous []uint64
}

// seenIDs is the ids of the frames delivered last.
type seenIDs struct {
	order    []string
	ids      map[string]struct{}
	capacity int
}

// remember remembers id; false when it was already remembered.
func (s *seenIDs) remember(id string) bool {
	if _, ok := s.ids[id]; ok {
		return false
	}
	s.ids[id] = struct{}{}
	s.order = append(s.order, id)
	if len(s.order) > s.capacity {
		delete(s.ids, s.order[0])
		s.order = s.order[1:]
	}
	return true
}

type lingering struct {
	at    time.Time
	conns []uint64
}

type retry struct {
	at           time.Time
	keepPrevious bool
}

type stream struct {
	shared   *transportShared
	state    *Variable[ConnectionState]
	commands chan command
	events   chan streamEvent
	// ctx is cancelled when the stream closes; every goroutine it starts ends
	// with it, and wg counts them.
	ctx     context.Context
	cancel  context.CancelFunc
	wg      sync.WaitGroup
	running bool

	// scoped is the subscription's scoped half: each scope held, and its
	// channels.
	scoped map[api.ResourceId][]string
	// watermarks is the last recorded event delivered on each scope, begun
	// from the bookmarks' places. A scope keeps its position after it is let
	// go: taken again, it resumes from there.
	watermarks map[api.ResourceId]string
	seen       seenIDs

	nextConn    uint64
	connections map[uint64]*connection
	// live is the connection whose stream is the client's own; while there
	// is one the state is open.
	live    uint64
	hasLive bool
	// connecting is the connect not yet answered. Changes of subscription
	// asked for meanwhile are served by one follow-up once it opens.
	connecting    uint64
	hasConnecting bool
	reconnectOwed bool
	// superseded is the connections a handoff retired: still read, until
	// their linger ends.
	superseded map[uint64]struct{}
	lingering  []lingering

	// retryAttempt is how many connects have failed since the last open.
	retryAttempt int
	// refusedToken is the token the gateway refused: never sent again.
	refusedToken string
	// refreshBurned is one renewal per outage; a successful open re-arms it.
	refreshBurned bool
	// awaitingCredential is waiting for a credential, with nothing to send
	// until one comes.
	awaitingCredential bool

	retryAt    *retry
	debounceAt *time.Time
	lazyAt     *time.Time
	degradedAt *time.Time
}

func newStream(shared *transportShared, state *Variable[ConnectionState]) *stream {
	ctx, cancel := context.WithCancel(context.Background())
	watermarks := map[api.ResourceId]string{}
	if shared.bookmarks != nil {
		maps.Copy(watermarks, shared.bookmarks.Load())
	}
	return &stream{
		shared:      shared,
		state:       state,
		commands:    make(chan command),
		events:      make(chan streamEvent, 256),
		ctx:         ctx,
		cancel:      cancel,
		scoped:      map[api.ResourceId][]string{},
		watermarks:  watermarks,
		seen:        seenIDs{ids: map[string]struct{}{}, capacity: shared.timing.SeenEventIdsCount},
		connections: map[uint64]*connection{},
		superseded:  map[uint64]struct{}{},
	}
}

func (s *stream) transition(next ConnectionState) {
	current := s.state.Value()
	if current == next || !allowed(current, next) {
		return
	}
	// A stream that stays down is degraded once it has been reconnecting for
	// the threshold: the timer runs while the state is reconnecting.
	s.degradedAt = nil
	if next == ConnectionStateReconnecting {
		at := time.Now().Add(s.shared.timing.DegradedThreshold)
		s.degradedAt = &at
	}
	s.state.Set(next)
}

func (s *stream) scheduleRetry(after time.Duration, keepPrevious bool) {
	if s.running {
		s.retryAt = &retry{at: time.Now().Add(after), keepPrevious: keepPrevious}
	}
}

// backoff is equal-jitter exponential backoff: a wait in [cap/2, cap], where
// cap is the reconnect wait doubled per failure up to MaxReconnect.
func (s *stream) backoff() time.Duration {
	limit := s.shared.timing.MaxReconnect
	wait := s.shared.timing.Reconnect
	for range s.retryAttempt {
		if wait >= limit {
			break
		}
		wait *= 2
	}
	s.retryAttempt++
	return EqualJitter(min(wait, limit))
}

func (s *stream) abort(conn uint64) {
	if c, ok := s.connections[conn]; ok {
		c.cancel()
		delete(s.connections, conn)
	}
	delete(s.superseded, conn)
}

func (s *stream) connect(keepPrevious bool) {
	// A transport that carries nothing opens no stream: one held only for the
	// gateway's own operations, or to ask who a token is, makes no request of
	// the bus. Taking a resource's scope gives it something to carry.
	if len(s.shared.global) == 0 && len(s.scoped) == 0 {
		return
	}
	// A connect with no token cannot succeed, and neither can one that sends
	// again the token the gateway just refused. Neither is attempted: the
	// client waits, with no request, for a different one.
	token := s.shared.token.Value()
	if token == "" || token == s.refusedToken {
		if s.running {
			// With a stream still live the state stays open: only the change
			// of subscription is waiting for a credential.
			if !s.hasLive {
				s.transition(ConnectionStateUnauthenticated)
			}
			s.awaitingCredential = true
			s.scheduleRetry(s.shared.timing.Reconnect, keepPrevious)
		}
		return
	}
	s.refusedToken = ""
	s.awaitingCredential = false

	previous := slices.Sorted(maps.Keys(s.connections))
	if !keepPrevious {
		// An initial connect, or the recovery of a drop: nothing live is
		// worth keeping.
		for _, conn := range previous {
			s.abort(conn)
		}
		s.hasLive = false
		s.lingering = nil
	}
	// Opening beside a live stream is a handoff, and the state stays open.
	// With none, this is connecting.
	if !s.hasLive {
		s.transition(ConnectionStateConnecting)
	}

	body := s.subscription()
	conn := s.nextConn
	s.nextConn++
	ctx, cancel := context.WithCancel(s.ctx)
	c := &connection{cancel: cancel, token: token, keepPrevious: keepPrevious}
	if keepPrevious {
		c.previous = previous
	}
	s.connections[conn] = c
	s.connecting, s.hasConnecting = conn, true
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		s.read(ctx, conn, token, body)
	}()
}

// subscription is the matrix a connect names: the global channels, each scope
// with its position, and the replies still awaited.
func (s *stream) subscription() api.BusSubscribeRequest {
	global := make([]string, len(s.shared.global))
	for i, channel := range s.shared.global {
		global[i] = string(channel)
	}
	type scopedEntry = struct {
		Channels    []string       `json:"channels"`
		LastEventId *string        `json:"lastEventId,omitempty"`
		Scope       api.ResourceId `json:"scope"`
	}
	scoped := []scopedEntry{}
	for _, scope := range slices.SortedFunc(maps.Keys(s.scoped), func(a, b api.ResourceId) int {
		return strings.Compare(a.String(), b.String())
	}) {
		entry := scopedEntry{Channels: s.scoped[scope], Scope: scope}
		if position, ok := s.watermarks[scope]; ok {
			entry.LastEventId = &position
		}
		scoped = append(scoped, entry)
	}
	body := api.BusSubscribeRequest{ClientId: s.shared.clientID, Global: &global, Scoped: &scoped}
	if awaited := s.shared.router.IDs(); len(awaited) > 0 {
		body.PendingReplies = &awaited
	}
	return body
}

// reconnect hands a changed subscription to a new stream. The live one is not
// touched, and the state does not move.
func (s *stream) reconnect() {
	if !s.running {
		return
	}
	if s.hasConnecting {
		s.reconnectOwed = true
		return
	}
	s.retryAt = nil
	s.connect(true)
}

// settleConnect is the connect conn made, answered. Opened, it serves the
// changes asked for while it was in flight with one follow-up; failed, it
// leaves them to the retry, which reads the same subscription.
func (s *stream) settleConnect(conn uint64, opened bool) {
	if !s.hasConnecting || s.connecting != conn {
		return
	}
	s.hasConnecting = false
	owed := s.reconnectOwed
	s.reconnectOwed = false
	if opened && owed && s.running {
		s.reconnect()
	}
}

func (s *stream) opened(conn uint64) {
	c, ok := s.connections[conn]
	if !ok {
		return
	}
	if c.keepPrevious {
		// The new stream is established, so the ones it replaces are retired
		// by drain: read for the linger more, then closed. Closing them now
		// would discard what they have received and not yet delivered.
		var retired []uint64
		for _, previous := range c.previous {
			if _, ok := s.connections[previous]; ok {
				retired = append(retired, previous)
				s.superseded[previous] = struct{}{}
			}
		}
		s.lingering = append(s.lingering, lingering{at: time.Now().Add(s.shared.timing.Linger), conns: retired})
	}
	s.live, s.hasLive = conn, true
	s.transition(ConnectionStateOpen)
	s.retryAttempt = 0
	s.refreshBurned = false
	s.settleConnect(conn, true)
}

// wireFrame is a frame as the stream's data line carries it.
type wireFrame struct {
	Channel       *string         `json:"channel"`
	Payload       json.RawMessage `json:"payload"`
	CorrelationID *string         `json:"correlationId"`
	Scope         *string         `json:"scope"`
}

func (s *stream) frame(conn uint64, id string, hasID bool, data string) {
	if _, ok := s.connections[conn]; !ok {
		return
	}
	if hasID && !s.seen.remember(id) {
		return
	}
	// Read by what it means: a frame a later gateway adds a field to is still
	// a frame. One that is not a frame at all is not delivered.
	var read wireFrame
	if json.Unmarshal([]byte(data), &read) != nil || read.Channel == nil {
		return
	}
	if trimmed := bytes.TrimSpace(read.Payload); len(trimmed) == 0 || trimmed[0] != '{' {
		return
	}
	payload, sentUnder, ok := withoutTrace(read.Payload)
	if !ok {
		return
	}
	frame := Frame{Channel: bus.Channel(*read.Channel), Payload: payload}
	if read.CorrelationID != nil {
		frame.CorrelationID = *read.CorrelationID
	}
	if read.Scope != nil {
		// A scope is a resource's id. One that is not is not a frame.
		scope, err := api.ParseResourceId(*read.Scope)
		if err != nil {
			return
		}
		frame.Scope = scope
	}
	busLog(context.Background(), busRecv, string(frame.Channel), payload, frame.Envelope)
	if _, retired := s.superseded[conn]; retired {
		// What closing a retired connection at once would have lost.
		busNote(busLinger, string(frame.Channel), "delivered on superseded connection")
	}
	frame.Trace = received(frame.Channel, frame.Scope, sentUnder)
	s.shared.router.Route(frame)
	// A scope's position is the last recorded event delivered on it: only a
	// recorded event's id (p-…) is one, and it always comes on its scope.
	recorded := hasID && !frame.Scope.IsZero() && strings.HasPrefix(id, "p-")
	if recorded {
		s.watermarks[frame.Scope] = id
	}
	s.shared.hub.Deliver(frame)
	// Kept only once the event has been given to those it changes: a place is never ahead of what was taken in.
	if recorded && s.shared.bookmarks != nil {
		s.shared.bookmarks.Save(frame.Scope, id)
	}
}

func (s *stream) refused(conn uint64, err *TransportError) {
	c, ok := s.connections[conn]
	if !ok {
		return
	}
	delete(s.connections, conn)
	s.settleConnect(conn, false)
	// A refused connect is a request the gateway refused, reported as one. A
	// connect that got no answer is not: it is a state.
	statedWait, _ := err.RetryAfter()
	credentialRefused := err.Code == TransportErrorCodeUnauthorized
	s.shared.failures.report(err)
	_, superseded := s.superseded[conn]
	delete(s.superseded, conn)
	if credentialRefused && s.running && !superseded {
		// Sending this token again gets the same answer, so it is not sent
		// again: the client waits for a different one, and asks its
		// refresher for one once per outage.
		s.refusedToken = c.token
		s.retryAttempt = 0
		if !s.hasLive {
			s.transition(ConnectionStateUnauthenticated)
		}
		if s.shared.refresher != nil && !s.refreshBurned {
			s.refreshBurned = true
			refused, keepPrevious := c.token, c.keepPrevious
			s.wg.Add(1)
			go func() {
				defer s.wg.Done()
				token, ok := s.shared.refresher.Refresh(s.ctx, refused)
				select {
				case s.events <- streamEvent{kind: eventRenewed, token: token, renewed: ok, keepPrevious: keepPrevious}:
				case <-s.ctx.Done():
				}
			}()
			return
		}
		s.awaitingCredential = true
		s.scheduleRetry(s.shared.timing.Reconnect, c.keepPrevious)
		return
	}
	s.droppedOrFailed(conn, superseded, statedWait)
}

func (s *stream) ended(conn uint64) {
	if _, ok := s.connections[conn]; !ok {
		return
	}
	delete(s.connections, conn)
	s.settleConnect(conn, false)
	_, superseded := s.superseded[conn]
	delete(s.superseded, conn)
	s.droppedOrFailed(conn, superseded, 0)
}

// droppedOrFailed is a stream that ended, or a connect that failed. A
// superseded connection ending is expected and restarts nothing.
func (s *stream) droppedOrFailed(conn uint64, superseded bool, statedWait time.Duration) {
	if !s.running || superseded {
		return
	}
	if s.hasLive && s.live != conn {
		// A handoff that could not open. The stream it was to replace is
		// still live, so nothing has dropped: it is tried again on the
		// backoff, and the state does not move.
		s.scheduleRetry(max(s.backoff(), statedWait), true)
		return
	}
	// A drop.
	s.hasLive = false
	s.transition(ConnectionStateReconnecting)
	if s.hasConnecting {
		// A handoff's connect is in flight: it is the recovery now, and comes
		// back through here if it fails.
		s.transition(ConnectionStateConnecting)
		return
	}
	s.scheduleRetry(max(s.backoff(), statedWait), false)
}

func (s *stream) renewed(token string, renewed, keepPrevious bool) {
	if !s.running {
		return
	}
	if renewed && token != "" && token != s.refusedToken {
		s.scheduleRetry(0, keepPrevious)
		return
	}
	s.awaitingCredential = true
	s.scheduleRetry(s.shared.timing.Reconnect, keepPrevious)
}

func (s *stream) command(c command) {
	switch c.kind {
	case commandAddScope:
		channels := make([]string, len(bus.ResourceScopedChannels))
		for i, channel := range bus.ResourceScopedChannels {
			channels[i] = string(channel)
		}
		s.scoped[c.resource] = channels
		// A new scope needs to be live now: additions are gathered for the
		// debounce, and carry any removal waiting with them.
		s.lazyAt = nil
		at := time.Now().Add(s.shared.timing.ReconnectDebounce)
		s.debounceAt = &at
	case commandRemoveScope:
		if _, held := s.scoped[c.resource]; held {
			delete(s.scoped, c.resource)
			if s.debounceAt == nil && s.lazyAt == nil {
				// A removal only narrows what is delivered, so it waits: a
				// client that brushes past scopes would otherwise reopen its
				// stream at each.
				at := time.Now().Add(s.shared.timing.LazyRemove)
				s.lazyAt = &at
			}
		}
	}
}

// tokenChanged is the token changing: a client waiting for a credential
// tries at once.
func (s *stream) tokenChanged() {
	if !s.running {
		if s.state.Value() == ConnectionStateInitial && s.shared.token.Value() != "" {
			s.running = true
			s.connect(false)
		}
		return
	}
	if s.awaitingCredential && s.retryAt != nil {
		s.retryAt.at = time.Now()
	}
}

func (s *stream) nextDeadline() (time.Time, bool) {
	var deadlines []time.Time
	if s.retryAt != nil {
		deadlines = append(deadlines, s.retryAt.at)
	}
	for _, at := range []*time.Time{s.debounceAt, s.lazyAt, s.degradedAt} {
		if at != nil {
			deadlines = append(deadlines, *at)
		}
	}
	for _, l := range s.lingering {
		deadlines = append(deadlines, l.at)
	}
	if len(deadlines) == 0 {
		return time.Time{}, false
	}
	return slices.MinFunc(deadlines, func(a, b time.Time) int { return a.Compare(b) }), true
}

func (s *stream) timers() {
	now := time.Now()
	due := func(at *time.Time) bool { return at != nil && !at.After(now) }
	if due(s.degradedAt) {
		s.degradedAt = nil
		if s.state.Value() == ConnectionStateReconnecting {
			s.state.Set(ConnectionStateDegraded)
		}
	}
	var still []lingering
	for _, l := range s.lingering {
		if l.at.After(now) {
			still = append(still, l)
			continue
		}
		for _, conn := range l.conns {
			s.abort(conn)
		}
	}
	s.lingering = still
	if due(s.debounceAt) || due(s.lazyAt) {
		s.debounceAt, s.lazyAt = nil, nil
		s.reconnect()
	}
	if s.retryAt != nil && !s.retryAt.at.After(now) {
		keepPrevious := s.retryAt.keepPrevious
		s.retryAt = nil
		if s.running {
			s.connect(keepPrevious)
		}
	}
}

// close ends the stream, and returns once every goroutine it started has.
func (s *stream) close() {
	s.running = false
	s.transition(ConnectionStateClosed)
	s.cancel()
	clear(s.connections)
	clear(s.superseded)
	s.hasLive, s.hasConnecting = false, false
	s.lingering = nil
	s.retryAt, s.debounceAt, s.lazyAt, s.degradedAt = nil, nil, nil, nil
	s.wg.Wait()
	s.shared.hub.Close()
	s.shared.router.Close()
	s.shared.failures.close()
}

// run holds the client's stream until it is closed.
func (s *stream) run(stopped chan<- struct{}) {
	defer close(stopped)
	timer := time.NewTimer(time.Hour)
	defer timer.Stop()
	_, tokenChanged := s.shared.token.watch()
	// The stream starts when there is a token to open it with.
	s.tokenChanged()
	for {
		var fired <-chan time.Time
		if at, ok := s.nextDeadline(); ok {
			timer.Reset(time.Until(at))
			fired = timer.C
		} else {
			timer.Stop()
		}
		select {
		case c := <-s.commands:
			if c.kind == commandClose {
				s.close()
				return
			}
			s.command(c)
		case event := <-s.events:
			switch event.kind {
			case eventOpened:
				s.opened(event.conn)
			case eventFrame:
				s.frame(event.conn, event.id, event.hasID, event.data)
			case eventRefused:
				s.refused(event.conn, event.err)
			case eventEnded:
				s.ended(event.conn)
			case eventRenewed:
				s.renewed(event.token, event.renewed, event.keepPrevious)
			}
		case <-tokenChanged:
			_, tokenChanged = s.shared.token.watch()
			s.tokenChanged()
		case <-fired:
			s.timers()
		}
	}
}

// read is one connection: the subscribe request, and every event its stream
// carries, reported to the stream's goroutine in order.
func (s *stream) read(ctx context.Context, conn uint64, token string, body api.BusSubscribeRequest) {
	report := func(event streamEvent) bool {
		event.conn = conn
		select {
		case s.events <- event:
			return true
		case <-ctx.Done():
			return false
		}
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		report(streamEvent{kind: eventEnded})
		return
	}
	// Only the answer's status and headers are waited for against
	// StreamOpenTimeout: once the stream is open, it may be quiet.
	opening, cancel := context.WithCancel(ctx)
	defer cancel()
	request, err := http.NewRequestWithContext(opening, http.MethodPost, s.shared.baseURL+"/bus/subscribe", bytes.NewReader(encoded))
	if err != nil {
		report(streamEvent{kind: eventEnded})
		return
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "text/event-stream")
	request.Header.Set("Authorization", "Bearer "+token)
	deadline := time.AfterFunc(s.shared.timing.StreamOpenTimeout, cancel)
	response, err := s.shared.http.Do(request)
	answered := deadline.Stop()
	if err != nil {
		report(streamEvent{kind: eventEnded})
		return
	}
	defer response.Body.Close()
	if !answered {
		report(streamEvent{kind: eventEnded})
		return
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		wait, hasWait := RetryAfter(response.Header.Get("Retry-After"))
		said, _ := io.ReadAll(io.LimitReader(response.Body, 1<<16))
		report(streamEvent{kind: eventRefused, err: refusal(fmt.Sprintf("SSE connect failed: %d", response.StatusCode), response.StatusCode, wait, hasWait, said)})
		return
	}
	if !report(streamEvent{kind: eventOpened}) {
		return
	}
	var parser sseParser
	buffer := make([]byte, 32<<10)
	for {
		n, err := response.Body.Read(buffer)
		for _, event := range parser.feed(buffer[:n]) {
			if event.event != "bus-event" || event.data == "" {
				continue
			}
			if !report(streamEvent{kind: eventFrame, id: event.id, hasID: event.hasID, data: event.data}) {
				return
			}
		}
		if err != nil {
			report(streamEvent{kind: eventEnded})
			return
		}
	}
}

// refusal is a refusal as the transport reports it. A refused credential
// (docs/protocol/TRANSPORT-CONTRACT.md § A refused credential) is unauthorized
// with the status the gateway answered, whatever that was. It keeps the wait
// the gateway stated, which nothing waits out: it is renewed, never retried.
// Any other refusal's status decides its code.
func refusal(message string, status int, wait time.Duration, hasWait bool, body []byte) *TransportError {
	refused := transportErrorOfStatus(message, status, wait, hasWait)
	if refusesCredential(status, body) {
		refused.Code = TransportErrorCodeUnauthorized
	}
	return refused
}

// refusesCredential reports whether the gateway refused the request's
// credential: a 401, or a 429 whose body is a LimitRefusal naming
// refusal-rate. A 429 whose body is not one is a limit's, as its status says.
func refusesCredential(status int, body []byte) bool {
	switch status {
	case http.StatusUnauthorized:
		return true
	case http.StatusTooManyRequests:
		var limit api.LimitRefusal
		return json.Unmarshal(body, &limit) == nil && limit.Code == api.LimitRefusalCodeRefusalRate
	default:
		return false
	}
}
