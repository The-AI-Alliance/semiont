// Command semiont-go-live-driver is the Go SDK's live driver: the program the
// SDK conformance suite talks to in the Go SDK's place for its live layer
// (tests/conformance/sdk/README.md, § The live driver). It holds a client, its
// live queries and their cache, and reaches them only as an application does,
// through what the SDK exports, so what the suite observes is what a caller of
// the SDK gets.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"iter"
	"net/http"
	"sync"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/conformance/internal/protocol"
)

// query is a live query a case names, as this driver reads it: its states,
// its one-shot read, what says it is out of date, and how a state of it is
// written.
type query struct {
	states     func(ctx context.Context) iter.Seq[semiont.CacheState]
	fresh      func(ctx context.Context) (any, error)
	invalidate func()
	written    func(state semiont.CacheState) map[string]any
}

// itself is a query's value as it is: each value of the SDK writes itself as
// the wire had it.
func itself[T any](value T) any { return value }

// liveQuery is q, its values written by show.
func liveQuery[T any](q *semiont.Cached[T], show func(T) any) query {
	return query{
		states: q.States,
		fresh: func(ctx context.Context) (any, error) {
			value, err := q.Fresh(ctx)
			if err != nil {
				return nil, err
			}
			return show(value), nil
		},
		invalidate: q.Invalidate,
		written: func(state semiont.CacheState) map[string]any {
			switch s := state.(type) {
			case semiont.Ready[T]:
				return map[string]any{"status": "ready", "value": show(s.Value)}
			case semiont.Failed:
				return map[string]any{"status": "failed", "error": failure(s.Err)}
			}
			return map[string]any{"status": "pending"}
		},
	}
}

// collaborators is the directory as the wire had it, each entry with its
// model's limits beside its own fields.
func collaborators(listed []semiont.Collaborator) any {
	written := make([]any, 0, len(listed))
	for _, collaborator := range listed {
		encoded, err := json.Marshal(collaborator.Entry)
		var entry map[string]any
		if err != nil || json.Unmarshal(encoded, &entry) != nil {
			written = append(written, collaborator.Entry)
			continue
		}
		if collaborator.Limits != nil {
			entry["limits"] = collaborator.Limits
		}
		written = append(written, entry)
	}
	return written
}

// failure is err as the protocol carries it. An error of none of the SDK's
// vocabularies has no code to say, and the suite fails it for that.
func failure(err error) map[string]any {
	var failed semiont.Error
	if errors.As(err, &failed) {
		return protocol.Failure(failed)
	}
	return map[string]any{"detail": err.Error()}
}

func resourceOf(args protocol.Arguments, name string) (api.ResourceId, error) {
	text, err := protocol.Text(args, name)
	if err != nil {
		return api.ResourceId{}, err
	}
	id, err := api.ParseResourceId(text)
	if err != nil {
		return api.ResourceId{}, protocol.Misused("%s is not a resource's id: %v", name, err)
	}
	return id, nil
}

func annotationOf(args protocol.Arguments, name string) (api.AnnotationId, error) {
	text, err := protocol.Text(args, name)
	if err != nil {
		return api.AnnotationId{}, err
	}
	id, err := api.ParseAnnotationId(text)
	if err != nil {
		return api.AnnotationId{}, protocol.Misused("%s is not an annotation's id: %v", name, err)
	}
	return id, nil
}

// object is the argument name, an object of arguments.
func object(args protocol.Arguments, name string) (protocol.Arguments, error) {
	var inner protocol.Arguments
	if raw, ok := args[name]; !ok || json.Unmarshal(raw, &inner) != nil || inner == nil {
		return nil, protocol.Misused("%s must be an object", name)
	}
	return inner, nil
}

// filters is the filters a case states for a list of resources, or for a
// search: the first hundred when it states no limit.
func filters(q protocol.Arguments) (semiont.ResourceFilters, error) {
	stated := protocol.Arguments{}
	if _, given := q["filters"]; given {
		var err error
		if stated, err = object(q, "filters"); err != nil {
			return semiont.ResourceFilters{}, err
		}
	}
	listed := semiont.ResourceFilters{Limit: 100}
	for name, raw := range stated {
		switch name {
		case "limit":
			n, err := protocol.Count(stated, name)
			if err != nil {
				return listed, err
			}
			listed.Limit = int(n)
		case "archived":
			if string(raw) == "null" {
				continue
			}
			var archived bool
			if json.Unmarshal(raw, &archived) != nil {
				return listed, protocol.Misused("archived must be true or false")
			}
			listed.Archived = &archived
		case "entityType":
			entityType, err := protocol.Text(stated, name)
			if err != nil {
				return listed, err
			}
			listed.EntityType = &entityType
		default:
			return listed, protocol.Misused("a filter by %s, which no query of resources takes", name)
		}
	}
	return listed, nil
}

// queryOf is the live query a case names: a query of
// specs/src/client/refresh.json, by its name there.
func queryOf(c *semiont.Client, q protocol.Arguments) (query, error) {
	name, err := protocol.Text(q, "query")
	if err != nil {
		return query{}, err
	}
	switch semiont.CacheQuery(name) {
	case semiont.CacheQueryResource:
		resource, err := resourceOf(q, "resource")
		if err != nil {
			return query{}, err
		}
		return liveQuery(c.Browse.Resource(resource), itself[api.ResourceDescriptor]), nil
	case semiont.CacheQueryAnnotations:
		resource, err := resourceOf(q, "resource")
		if err != nil {
			return query{}, err
		}
		return liveQuery(c.Browse.Annotations(resource), itself[[]api.Annotation]), nil
	case semiont.CacheQueryAnnotation:
		resource, err := resourceOf(q, "resource")
		if err != nil {
			return query{}, err
		}
		annotation, err := annotationOf(q, "annotation")
		if err != nil {
			return query{}, err
		}
		return liveQuery(c.Browse.Annotation(resource, annotation), itself[api.Annotation]), nil
	case semiont.CacheQueryEvents:
		resource, err := resourceOf(q, "resource")
		if err != nil {
			return query{}, err
		}
		return liveQuery(c.Browse.Events(resource), itself[[]api.AttributedEvent]), nil
	case semiont.CacheQueryReferencedBy:
		resource, err := resourceOf(q, "resource")
		if err != nil {
			return query{}, err
		}
		return liveQuery(c.Gather.ReferencedBy(resource), itself[[]api.GetReferencedByResponseReferencedByItem]), nil
	case semiont.CacheQueryResources:
		listed, err := filters(q)
		if err != nil {
			return query{}, err
		}
		return liveQuery(c.Browse.Resources(listed), itself[api.ListResourcesResponse]), nil
	case semiont.CacheQueryMatchedResources:
		search, err := protocol.Text(q, "search")
		if err != nil {
			return query{}, err
		}
		listed, err := filters(q)
		if err != nil {
			return query{}, err
		}
		return liveQuery(c.Match.Resources(search, listed), itself[api.MatchResourcesResponse]), nil
	case semiont.CacheQueryEntityTypes:
		return liveQuery(c.Browse.EntityTypes(), itself[[]string]), nil
	case semiont.CacheQueryTagSchemas:
		return liveQuery(c.Browse.TagSchemas(), itself[[]api.TagSchema]), nil
	case semiont.CacheQueryAgents:
		return liveQuery(c.Browse.Agents(), collaborators), nil
	}
	return query{}, protocol.Misused("no live query %s", name)
}

// timing is the client's timing, with what the case overrides, each entry by
// its name in specs/src/client/timing.json.
func timing(args protocol.Arguments) (semiont.Timing, error) {
	timing := semiont.DefaultTiming()
	if _, given := args["timing"]; !given {
		return timing, nil
	}
	stated, err := object(args, "timing")
	if err != nil {
		return timing, err
	}
	for name := range stated {
		n, err := protocol.Count(stated, name)
		if err != nil {
			return timing, err
		}
		ms := time.Duration(n) * time.Millisecond
		switch name {
		case "reconnectMs":
			timing.Reconnect = ms
		case "lazyRemoveMs":
			timing.LazyRemove = ms
		case "lingerMs":
			timing.Linger = ms
		case "busRequestTimeoutMs":
			timing.BusRequestTimeout = ms
		case "invalidationWindowMs":
			timing.InvalidationWindow = ms
		case "jobSilenceMs":
			timing.JobSilence = ms
		case "jobStatusPollMs":
			timing.JobStatusPoll = ms
		default:
			return timing, protocol.Misused("this driver cannot override %s", name)
		}
	}
	return timing, nil
}

// live is one client, and what the suite asked it to report.
type live struct {
	// storage is what a cache is kept in, across close and the next open: a
	// reload, to the client.
	storage *semiont.MemoryStorage

	mu        sync.Mutex
	transport *semiont.HTTPTransport
	// client is the client, kept once closed: what a closed client does is
	// part of what the suite asks.
	client *semiont.Client
	closed bool
	// observers is what stops each observer, by the name the suite gave it.
	observers map[string]context.CancelFunc
	// reported is the state last reported.
	reported semiont.ConnectionState
	// reporters is what reports what the client observes.
	reporters sync.WaitGroup
}

func (l *live) Operations() []string {
	return []string{"open", "close", "observe", "unobserve", "fresh", "invalidate", "markDelegate", "yieldDelegate", "delete", "sync"}
}

func (l *live) opened() (*semiont.Client, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.client == nil {
		return nil, protocol.Misused("no client is open")
	}
	return l.client, nil
}

// report reports the state the transport is in, unless it is the one last
// reported.
func (l *live) report(state semiont.ConnectionState) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.reported != state {
		l.reported = state
		protocol.Say(map[string]string{"state": string(state)})
	}
}

func (l *live) Run(ctx context.Context, _ uint64, op string, args protocol.Arguments) (any, error) {
	switch op {
	case "open":
		return nil, l.open(args)
	case "close":
		return nil, l.close()
	case "observe":
		return nil, l.observe(args)
	case "unobserve":
		return nil, l.unobserve(args)
	case "fresh":
		c, err := l.opened()
		if err != nil {
			return nil, err
		}
		q, err := l.named(c, args)
		if err != nil {
			return nil, err
		}
		value, err := q.fresh(ctx)
		if err != nil {
			return nil, err
		}
		return map[string]any{"value": value}, nil
	case "invalidate":
		c, err := l.opened()
		if err != nil {
			return nil, err
		}
		q, err := l.named(c, args)
		if err != nil {
			return nil, err
		}
		q.invalidate()
		return nil, nil
	case "markDelegate":
		return nil, l.markDelegate(args)
	case "yieldDelegate":
		return nil, l.yieldDelegate(args)
	case "delete":
		c, err := l.opened()
		if err != nil {
			return nil, err
		}
		resource, err := resourceOf(args, "resource")
		if err != nil {
			return nil, err
		}
		annotation, err := annotationOf(args, "annotation")
		if err != nil {
			return nil, err
		}
		return nil, c.Mark.Delete(ctx, resource, annotation)
	case "sync":
		// Answers after everything the client reported before it: the
		// suite's way to know it has read every state an observer was in.
		l.mu.Lock()
		transport := l.transport
		l.mu.Unlock()
		if transport != nil {
			l.report(transport.State())
		}
		return nil, nil
	}
	return nil, protocol.Misused("%s is not an operation of this driver", op)
}

// named is the live query the case's `query` argument names.
func (l *live) named(c *semiont.Client, args protocol.Arguments) (query, error) {
	q, err := object(args, "query")
	if err != nil {
		return query{}, err
	}
	return queryOf(c, q)
}

func (l *live) open(args protocol.Arguments) error {
	l.mu.Lock()
	reopening := l.client != nil && !l.closed
	l.mu.Unlock()
	if reopening {
		return protocol.Misused("a client is already open")
	}
	timing, err := timing(args)
	if err != nil {
		return err
	}
	baseURL, err := protocol.Text(args, "baseUrl")
	if err != nil {
		return err
	}
	token, err := protocol.Text(args, "token")
	if err != nil {
		return err
	}
	var persist bool
	if raw, given := args["persist"]; given && json.Unmarshal(raw, &persist) != nil {
		return protocol.Misused("persist must be true or false")
	}
	transport := semiont.NewHTTPTransport(semiont.HTTPTransportConfig{
		BaseURL: baseURL, Token: semiont.NewWatched(token), Channels: bus.BridgedChannels, HTTP: &http.Client{}, Timing: timing,
	})
	// Taken at once, so every failure from the first request on is heard.
	failures := transport.Failures()
	config := semiont.ClientConfig{Transport: transport, Content: semiont.NewHTTPContentTransport(transport), Gateway: transport, Timing: timing}
	if persist {
		config.Persistence = &semiont.CachePersistence{Storage: l.storage, KeyPrefix: "conformance"}
	}
	c := semiont.NewClient(config)
	l.mu.Lock()
	l.transport, l.client, l.closed = transport, c, false
	l.observers = map[string]context.CancelFunc{}
	l.reported = ""
	l.mu.Unlock()
	l.reporters.Add(2)
	go func() {
		defer l.reporters.Done()
		for state := range transport.StateChanges(context.Background()) {
			l.report(state)
			if state == semiont.ConnectionStateClosed {
				return
			}
		}
	}()
	go func() {
		defer l.reporters.Done()
		for failed := range failures {
			protocol.Say(map[string]any{"error": protocol.Failure(failed)})
		}
	}()
	return nil
}

func (l *live) close() error {
	c, err := l.opened()
	if err != nil {
		return err
	}
	l.mu.Lock()
	transport := l.transport
	l.mu.Unlock()
	c.Close()
	transport.Close()
	l.mu.Lock()
	l.closed = true
	l.mu.Unlock()
	return nil
}

// free claims the observer a case names, which is nobody's yet, and gives
// the context that observing it runs in.
func (l *live) free(args protocol.Arguments) (string, context.Context, error) {
	observer, err := protocol.Text(args, "observer")
	if err != nil {
		return "", nil, err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, taken := l.observers[observer]; taken {
		return "", nil, protocol.Misused("%s is already observing", observer)
	}
	ctx, stop := context.WithCancel(context.Background())
	l.observers[observer] = stop
	return observer, ctx, nil
}

func emission(observer string, state map[string]any) {
	protocol.Say(map[string]any{"emission": map[string]any{"observer": observer, "state": state}})
}

func (l *live) observe(args protocol.Arguments) error {
	c, err := l.opened()
	if err != nil {
		return err
	}
	q, err := l.named(c, args)
	if err != nil {
		return err
	}
	observer, ctx, err := l.free(args)
	if err != nil {
		return err
	}
	next, stop := iter.Pull(q.states(ctx))
	// The state an observer is given at once, the query's state now, is said
	// here, before this is answered, and only the states after it from a
	// goroutine of their own: a case that reads what the observer holds
	// straight after `observe` finds it there. None means the query
	// completed before it gave one.
	now, observing := next()
	if observing {
		emission(observer, q.written(now))
	}
	l.reporters.Add(1)
	go func() {
		defer l.reporters.Done()
		defer stop()
		if observing {
			for {
				state, more := next()
				if !more {
					break
				}
				emission(observer, q.written(state))
			}
		}
		// An observer the suite stopped has ended, not completed: only a
		// query that ended by itself, its client closed, is said to.
		if ctx.Err() == nil {
			protocol.Say(map[string]any{"completed": observer})
		}
	}()
	return nil
}

func (l *live) unobserve(args protocol.Arguments) error {
	observer, err := protocol.Text(args, "observer")
	if err != nil {
		return err
	}
	l.mu.Lock()
	stop, observing := l.observers[observer]
	delete(l.observers, observer)
	l.mu.Unlock()
	if !observing {
		return protocol.Misused("%s is not observing", observer)
	}
	stop()
	return nil
}

// following reports a delegated job, followed to its end, as an observer:
// each event it reports a ready state, its failure a failed one, its end a
// completion.
func following[C any](observer string, job *semiont.Delegation[C], done func()) {
	defer done()
	for event, err := range job.Events() {
		if err != nil {
			var failed semiont.Error
			if errors.As(err, &failed) {
				emission(observer, map[string]any{"status": "failed", "error": failure(err)})
			}
			break
		}
		emission(observer, map[string]any{"status": "ready", "value": event})
	}
	protocol.Say(map[string]any{"completed": observer})
}

func (l *live) markDelegate(args protocol.Arguments) error {
	c, err := l.opened()
	if err != nil {
		return err
	}
	resource, err := resourceOf(args, "resource")
	if err != nil {
		return err
	}
	var params api.MarkJobParams
	if raw, given := args["params"]; !given || params.UnmarshalJSON(raw) != nil {
		return protocol.Misused("params must be what a mark job is created with")
	}
	observer, _, err := l.free(args)
	if err != nil {
		return err
	}
	job := c.Mark.Delegate(resource, params)
	l.reporters.Add(1)
	go following(observer, job, func() { l.reporters.Done() })
	return nil
}

func (l *live) yieldDelegate(args protocol.Arguments) error {
	c, err := l.opened()
	if err != nil {
		return err
	}
	var params api.GenerationJobParams
	if raw, given := args["params"]; !given || json.Unmarshal(raw, &params) != nil {
		return protocol.Misused("params must be what a yield job is created with")
	}
	stall, err := protocol.Count(args, "stallDeadlineMs")
	if err != nil {
		return err
	}
	observer, _, err := l.free(args)
	if err != nil {
		return err
	}
	job := c.Yield.Delegate(params, time.Duration(stall)*time.Millisecond)
	l.reporters.Add(1)
	go following(observer, job, func() { l.reporters.Done() })
	return nil
}

func (l *live) Finish() {
	l.mu.Lock()
	c, transport, closed := l.client, l.transport, l.closed
	for _, stop := range l.observers {
		stop()
	}
	l.mu.Unlock()
	if c != nil && !closed {
		c.Close()
		transport.Close()
	}
	l.reporters.Wait()
}

func main() {
	flush, exporting := protocol.Exporting()
	protocol.Serve(func(protocol.Abandoner) protocol.Driver {
		return &live{storage: semiont.NewMemoryStorage(), observers: map[string]context.CancelFunc{}}
	})
	if exporting {
		flush()
	}
}
