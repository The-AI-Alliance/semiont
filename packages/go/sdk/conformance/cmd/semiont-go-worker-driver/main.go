// Command semiont-go-worker-driver is the Go SDK's worker driver: a worker
// written on the SDK, as the worker conformance suite drives it
// (tests/conformance/worker/README.md, § The worker driver).
//
// It reaches the worker's surface only as a worker's author does: Job.Claim on
// the SDK's client, the claims it returns, and the held jobs they hand out.
//
// As a worker's code does, it runs each job it is handed in a span of its own,
// job:{jobType} carrying the job's id as job.id: opened in the trace the job
// states, where the job is handed to it, and ended once it has settled the
// job. Everything it does for the job it does in that span. Started with
// OTEL_EXPORTER_OTLP_ENDPOINT in its environment, it exports its telemetry
// there over OTLP/HTTP, and has exported all of it by the time it exits.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"sync"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/conformance/internal/protocol"
)

// timing is the client's timing, with what the case overrides, each entry by
// its name in specs/src/client/timing.json: the transport's, and a worker's.
func timing(args protocol.Arguments) (semiont.Timing, error) {
	timing := semiont.DefaultTiming()
	if _, given := args["timing"]; !given {
		return timing, nil
	}
	var stated protocol.Arguments
	if json.Unmarshal(args["timing"], &stated) != nil || stated == nil {
		return timing, protocol.Misused("timing must be an object")
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
		case "jobClaimTimeoutMs":
			timing.JobClaimTimeout = ms
		case "heldJobStallMs":
			timing.HeldJobStall = ms
		case "heldJobStallCheckMs":
			timing.HeldJobStallCheck = ms
		case "markCommitTimeoutMs":
			timing.MarkCommitTimeout = ms
		default:
			return timing, protocol.Misused("this driver cannot override %s", name)
		}
	}
	return timing, nil
}

// asTheSuiteWroteIt is what a case states as the wire carries it, as the
// SDK's type for it. One the type refuses is the suite's mistake.
func asTheSuiteWroteIt[T any](args protocol.Arguments, name string) (T, error) {
	var value T
	raw, given := args[name]
	if !given {
		return value, protocol.Misused("%s is not given", name)
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return value, protocol.Misused("%s: %v", name, err)
	}
	return value, nil
}

// cursors is the cursors a case states for the units a job is part-way
// through; nil when it states none.
func cursors(args protocol.Arguments) (map[string]api.UnitCursor, error) {
	if _, given := args["unitCursors"]; !given {
		return nil, nil
	}
	return asTheSuiteWroteIt[map[string]api.UnitCursor](args, "unitCursors")
}

// units is the units a case states as finished; nil when it states none.
func units(args protocol.Arguments) ([]string, error) {
	if _, given := args["completedUnits"]; !given {
		return nil, nil
	}
	return protocol.Texts(args, "completedUnits")
}

// iso is a time as the protocol carries one; nil for one that has not
// happened.
func iso(at time.Time) any {
	if at.IsZero() {
		return nil
	}
	return at.UTC().Format("2006-01-02T15:04:05.000Z07:00")
}

// running is the held job, and the span it is run in.
type running struct {
	job  semiont.HeldJob
	span trace.Span
}

// worker is one worker, and what the suite asked it to report.
type worker struct {
	// life ends when the driver is done: what tells the suite of the
	// claims stops with it.
	life context.Context
	end  context.CancelFunc

	mu        sync.Mutex
	transport *semiont.HTTPTransport
	client    *semiont.Client
	closed    bool
	claims    *semiont.Claims
	// held is the job the worker last came to hold, as its claims handed it
	// out.
	held     *running
	releases []func()
	reported semiont.ConnectionState
	// reporters is what says what the worker observes.
	reporters sync.WaitGroup
}

func (w *worker) Operations() []string {
	return []string{"open", "close", "subscribe-resource", "claim", "start", "progress", "checkpoint", "commit", "complete", "fail", "cancel", "vitals", "sync"}
}

func (w *worker) opened() (*semiont.Client, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.client == nil {
		return nil, protocol.Misused("no transport is open")
	}
	return w.client, nil
}

func (w *worker) claiming() (*semiont.Claims, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.claims == nil {
		return nil, protocol.Misused("the worker is not claiming")
	}
	return w.claims, nil
}

// working is the held job, for something done for it, and the context it is
// done in: the job's span.
func (w *worker) working(ctx context.Context) (*running, context.Context, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.held == nil {
		return nil, nil, protocol.Misused("the worker has held no job")
	}
	return w.held, trace.ContextWithSpan(ctx, w.held.span), nil
}

// settling is working, for the job's settle: done says it is done, however
// it went, and ends the job's span.
func (w *worker) settling(ctx context.Context) (*running, context.Context, func(), error) {
	held, inSpan, err := w.working(ctx)
	if err != nil {
		return nil, nil, nil, err
	}
	return held, inSpan, func() { held.span.End() }, nil
}

// report says the state the transport is in, unless it is the one last
// said.
func (w *worker) report(state semiont.ConnectionState) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.reported != state {
		w.reported = state
		protocol.Say(map[string]string{"state": string(state)})
	}
}

func (w *worker) Run(ctx context.Context, _ uint64, op string, args protocol.Arguments) (any, error) {
	switch op {
	case "open":
		return nil, w.open(args)
	case "close":
		return nil, w.close()
	case "subscribe-resource":
		return nil, w.subscribeResource(args)
	case "claim":
		return nil, w.claim(args)
	case "start":
		held, inSpan, err := w.working(ctx)
		if err != nil {
			return nil, err
		}
		return nil, held.job.Start(inSpan)
	case "progress":
		return nil, w.progress(ctx, args)
	case "checkpoint":
		return nil, w.checkpoint(ctx, args)
	case "commit":
		return nil, w.commit(ctx, args)
	case "complete":
		return nil, w.complete(ctx, args)
	case "fail":
		return nil, w.fail(ctx, args)
	case "cancel":
		return nil, w.cancel(ctx, args)
	case "vitals":
		return w.vitals()
	case "sync":
		// Answers after everything the worker reported before it.
		return nil, nil
	}
	return nil, protocol.Misused("%s is not an operation of this driver", op)
}

func (w *worker) open(args protocol.Arguments) error {
	w.mu.Lock()
	open := w.client != nil
	w.mu.Unlock()
	if open {
		return protocol.Misused("a transport is already open")
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
	var commits bool
	if raw, given := args["commits"]; given && json.Unmarshal(raw, &commits) != nil {
		return protocol.Misused("commits must be a boolean")
	}
	// What a worker's stream names for its claims, and for its commits when
	// it will make any, and no more: this worker awaits nothing else.
	channels := slices.Clone(semiont.JobClaimChannels)
	if commits {
		channels = append(channels, semiont.JobCommitChannels...)
	}
	transport := semiont.NewHTTPTransport(semiont.HTTPTransportConfig{
		BaseURL: baseURL, Token: semiont.NewVariable(token), Channels: channels, HTTP: &http.Client{}, Timing: timing,
	})
	// Taken at once, so every failure from the first request on is heard.
	failures := transport.Failures()
	c := semiont.NewClient(semiont.ClientConfig{Transport: transport, Content: semiont.NewHTTPContentTransport(transport), Gateway: transport, Timing: timing})
	w.mu.Lock()
	w.transport, w.client = transport, c
	w.mu.Unlock()
	w.reporters.Add(2)
	go func() {
		defer w.reporters.Done()
		for state := range transport.State().Changes(context.Background()) {
			w.report(state)
			if state == semiont.ConnectionStateClosed {
				return
			}
		}
	}()
	go func() {
		defer w.reporters.Done()
		for failed := range failures {
			protocol.Say(map[string]any{"error": protocol.Failure(failed)})
		}
	}()
	return nil
}

// close is a worker that stops: a job it still holds is failed first.
func (w *worker) close() error {
	c, err := w.opened()
	if err != nil {
		return err
	}
	w.mu.Lock()
	claims, transport := w.claims, w.transport
	w.closed = true
	w.mu.Unlock()
	if claims != nil {
		claims.Close()
	}
	c.Close()
	transport.Close()
	return nil
}

func (w *worker) subscribeResource(args protocol.Arguments) error {
	text, err := protocol.Text(args, "resource")
	if err != nil {
		return err
	}
	resource, err := api.ParseResourceId(text)
	if err != nil {
		return protocol.Misused("resource is not a resource's id: %v", err)
	}
	if _, err := w.opened(); err != nil {
		return err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	w.releases = append(w.releases, w.transport.SubscribeToResource(resource))
	return nil
}

// claim begins claiming, and says what the claims hand out.
func (w *worker) claim(args protocol.Arguments) error {
	c, err := w.opened()
	if err != nil {
		return err
	}
	accepts, err := asTheSuiteWroteIt[[]api.JobFilter](args, "accepts")
	if err != nil {
		return err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.claims != nil {
		return protocol.Misused("the worker is already claiming")
	}
	claims := c.Job.Claim(accepts)
	w.claims = claims
	w.reporters.Add(2)
	go func() {
		defer w.reporters.Done()
		w.reading(claims)
	}()
	go func() {
		defer w.reporters.Done()
		for stall := range claims.Stalled().Changes(w.life) {
			if stall != nil {
				protocol.Say(map[string]string{"stalled": stall.JobId.String()})
			}
		}
	}()
	return nil
}

func (w *worker) reading(claims *semiont.Claims) {
	for job, err := range claims.All() {
		if err != nil {
			var refusal *semiont.ClaimRefusal
			if !errors.As(err, &refusal) {
				protocol.Say(map[string]any{"refused": map[string]any{"detail": err.Error()}})
				continue
			}
			refused := map[string]any{"detail": refusal.Message}
			if refusal.Code != nil {
				refused["code"] = *refusal.Code
			}
			protocol.Say(map[string]any{"refused": refused})
			continue
		}
		w.hold(job)
		w.reporters.Add(1)
		go func() {
			defer w.reporters.Done()
			for cancelled := range job.Cancelled().Changes(w.life) {
				if cancelled {
					protocol.Say(map[string]string{"signalled": job.JobId().String()})
					return
				}
			}
		}()
		protocol.Say(map[string]any{"claimed": map[string]any{
			"jobId":          job.JobId(),
			"jobType":        job.JobType(),
			"resourceId":     job.ResourceId(),
			"params":         job.Params(),
			"completedUnits": job.CompletedUnits(),
			"unitCursors":    job.UnitCursors(),
			"retryCount":     job.RetryCount(),
			"maxRetries":     job.MaxRetries(),
		}})
	}
}

// hold holds job, and opens the span it is run in: in the trace the job
// states.
func (w *worker) hold(job semiont.HeldJob) {
	_, span := otel.Tracer("semiont-conformance-driver").Start(
		semiont.Continuing(context.Background(), job.Trace()), "job:"+string(job.JobType()),
		trace.WithSpanKind(trace.SpanKindConsumer), trace.WithAttributes(attribute.String("job.id", job.JobId().String())),
	)
	w.mu.Lock()
	defer w.mu.Unlock()
	w.held = &running{job: job, span: span}
}

func (w *worker) progress(ctx context.Context, args protocol.Arguments) error {
	stated := protocol.Arguments{}
	for _, name := range []string{"percentage", "message"} {
		if raw, given := args[name]; given {
			stated[name] = raw
		}
	}
	encoded, err := json.Marshal(stated)
	if err != nil {
		return protocol.Misused("progress: %v", err)
	}
	progress, err := asTheSuiteWroteIt[api.JobProgress](protocol.Arguments{"progress": encoded}, "progress")
	if err != nil {
		return err
	}
	held, inSpan, err := w.working(ctx)
	if err != nil {
		return err
	}
	return held.job.Progress(inSpan, progress)
}

func (w *worker) checkpoint(ctx context.Context, args protocol.Arguments) error {
	completed, err := protocol.Texts(args, "completedUnits")
	if err != nil {
		return err
	}
	unitCursors, err := cursors(args)
	if err != nil {
		return err
	}
	held, inSpan, err := w.working(ctx)
	if err != nil {
		return err
	}
	return held.job.Checkpoint(inSpan, completed, unitCursors)
}

// commit is the held job committing for itself: it cites its own id, and
// remembers what the commit observed for its settle. A case states an
// annotation as the wire carries one.
func (w *worker) commit(ctx context.Context, args protocol.Arguments) error {
	text, err := protocol.Text(args, "resourceId")
	if err != nil {
		return err
	}
	resource, err := api.ParseResourceId(text)
	if err != nil {
		return protocol.Misused("resourceId is not a resource's id: %v", err)
	}
	annotations, err := asTheSuiteWroteIt[[]api.Annotation](args, "annotations")
	if err != nil {
		return err
	}
	held, inSpan, err := w.working(ctx)
	if err != nil {
		return err
	}
	return held.job.Commit(inSpan, resource, annotations)
}

// complete settles the held job with its verb's result: the verb is read
// before the result is given. A case states a result as the wire carries
// one, and the gateway refuses one that is the other verb's.
func (w *worker) complete(ctx context.Context, args protocol.Arguments) error {
	if _, err := protocol.Object(args, "result"); err != nil {
		return err
	}
	held, inSpan, done, err := w.settling(ctx)
	if err != nil {
		return err
	}
	defer done()
	switch job := held.job.(type) {
	case *semiont.HeldMarkJob:
		result, err := asTheSuiteWroteIt[api.MarkJobResult](args, "result")
		if err != nil {
			return err
		}
		return job.Complete(inSpan, result)
	case *semiont.HeldYieldJob:
		result, err := asTheSuiteWroteIt[api.YieldJobResult](args, "result")
		if err != nil {
			return err
		}
		return job.Complete(inSpan, result)
	}
	return protocol.Misused("a held job of no verb this driver knows: %T", held.job)
}

func (w *worker) fail(ctx context.Context, args protocol.Arguments) error {
	message, err := protocol.Text(args, "error")
	if err != nil {
		return err
	}
	var failure semiont.JobFailure
	if _, given := args["failureClass"]; given {
		class, err := asTheSuiteWroteIt[api.FailureClass](args, "failureClass")
		if err != nil {
			return err
		}
		failure.FailureClass = &class
	}
	if failure.CompletedUnits, err = units(args); err != nil {
		return err
	}
	if failure.UnitCursors, err = cursors(args); err != nil {
		return err
	}
	held, inSpan, done, err := w.settling(ctx)
	if err != nil {
		return err
	}
	defer done()
	return held.job.Fail(inSpan, message, failure)
}

func (w *worker) cancel(ctx context.Context, args protocol.Arguments) error {
	completed, err := units(args)
	if err != nil {
		return err
	}
	unitCursors, err := cursors(args)
	if err != nil {
		return err
	}
	held, inSpan, done, err := w.settling(ctx)
	if err != nil {
		return err
	}
	defer done()
	return held.job.Cancel(inSpan, completed, unitCursors)
}

func (w *worker) vitals() (any, error) {
	claims, err := w.claiming()
	if err != nil {
		return nil, err
	}
	vitals := claims.Vitals()
	var active any
	if job := vitals.ActiveJob; job != nil {
		active = map[string]any{"jobId": job.JobId, "type": job.JobType, "since": iso(job.Since)}
	}
	return map[string]any{
		"lastQueuedEventAt": iso(vitals.LastQueuedEventAt),
		"lastClaimAt":       iso(vitals.LastClaimAt),
		"lastFinishedAt":    iso(vitals.LastFinishedAt),
		"lastActivityAt":    iso(vitals.LastActivityAt),
		"activeJob":         active,
		"jobsCompleted":     vitals.JobsCompleted,
	}, nil
}

// Finish is the suite done with this worker, which ends as a worker that is
// killed ends. It says nothing more, of a job it holds or of anything else:
// only close stops the worker, and a job failed here would be one no case
// accounts for. So the claims are not closed: the client's closing ends
// them, and what told the suite of them is ended here.
func (w *worker) Finish() {
	w.end()
	w.mu.Lock()
	c, transport, closed := w.client, w.transport, w.closed
	w.mu.Unlock()
	if c != nil && !closed {
		c.Close()
		transport.Close()
	}
	w.reporters.Wait()
}

func main() {
	flush, exporting := protocol.Exporting()
	protocol.Serve(func(protocol.Abandoner) protocol.Driver {
		life, end := context.WithCancel(context.Background())
		return &worker{life: life, end: end}
	})
	if exporting {
		flush()
	}
}
