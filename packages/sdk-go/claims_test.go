package semiont

// Job.Claim: a worker's claims and the jobs it comes to hold.
//
// The rules are docs/protocol/WORKER-CONTRACT.md's, and the worker
// conformance suite (tests/conformance/worker) holds them on the wire. These
// are the same rules over a transport the test answers by hand: the stand-in
// dispatcher below answers each job:claim with what a test offered, refused,
// or with nothing pending, and the stand-in record answers each commit and
// each question asked about one. Two tables are run here too: whether a job
// matches a filter, and whether a failed job is retried.

import (
	"context"
	"encoding/json"
	"errors"
	"iter"
	"maps"
	"os"
	"reflect"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

// workerWire is a transport a test answers by hand: every request goes to
// answer, and every other emit is kept, in order.
type workerWire struct {
	hub    *FrameHub
	router *ReplyRouter
	state  *Variable[ConnectionState]
	// channels is what its stream names; nil names every channel.
	channels []bus.Channel
	// answer is what a request is answered with: the reply's payload, whether
	// it is the failure, and whether any reply comes at all.
	answer func(request bus.Channel, payload map[string]any) (reply string, refused, answered bool)
	// replyTrace is the trace every reply arrives in.
	replyTrace TraceContext

	mu    sync.Mutex
	said  []sentFrame
	asked []sentFrame
	done  chan struct{}
	once  sync.Once
}

// sentFrame is one emit, as the wire carried it.
type sentFrame struct {
	channel bus.Channel
	payload string
}

var _ Transport = (*workerWire)(nil)

func newWorkerWire() *workerWire {
	return &workerWire{hub: NewFrameHub(), router: NewReplyRouter(), state: NewVariable(ConnectionStateOpen), done: make(chan struct{})}
}

func (w *workerWire) BaseURL() string { return "http://worker.test" }

func (w *workerWire) Emit(_ context.Context, channel bus.Channel, payload map[string]any, envelope Envelope) (int, bool, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return 0, false, err
	}
	w.mu.Lock()
	sent := sentFrame{channel, string(encoded)}
	if envelope.CorrelationID == "" {
		w.said = append(w.said, sent)
	} else {
		w.asked = append(w.asked, sent)
	}
	w.mu.Unlock()
	replies, isRequest := bus.Operations[channel]
	if envelope.CorrelationID == "" || !isRequest {
		return 0, false, nil
	}
	reply, refused, answered := w.answer(channel, payload)
	if !answered {
		return 0, false, nil
	}
	frame := Frame{Channel: replies.Result, Envelope: Envelope{CorrelationID: envelope.CorrelationID}, Payload: json.RawMessage(reply), Trace: w.replyTrace}
	if refused {
		frame.Channel = replies.Failure
	}
	w.router.Route(frame)
	w.hub.Deliver(frame)
	return 0, false, nil
}

func (w *workerWire) Frames(channels ...bus.Channel) (iter.Seq[Frame], error) {
	return w.hub.Frames(channels...), nil
}

func (w *workerWire) IsSubscribed(channel bus.Channel) bool {
	return w.channels == nil || slices.Contains(w.channels, channel)
}

func (w *workerWire) SubscribeToResource(api.ResourceId) (release func()) { return func() {} }

func (w *workerWire) TrackReply(correlationID string, channels ...bus.Channel) *PendingReply {
	return w.router.Track(correlationID, channels)
}

func (w *workerWire) State() Watched[ConnectionState] { return w.state }

func (w *workerWire) BridgeInto(sink FrameSink) { w.hub.Bridge(sink) }

func (w *workerWire) Failures() iter.Seq[*TransportError] {
	return func(func(*TransportError) bool) { <-w.done }
}

func (w *workerWire) Close() {
	w.once.Do(func() {
		w.state.Set(ConnectionStateClosed)
		w.router.Close()
		w.hub.Close()
		close(w.done)
	})
}

// relay is a broadcast the gateway relays to this worker.
func (w *workerWire) relay(channel bus.Channel, payload string) {
	w.hub.Deliver(Frame{Channel: channel, Payload: json.RawMessage(payload)})
}

// sent is the payload of every emit on channel so far, in order.
func (w *workerWire) sent(channel bus.Channel) []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	var payloads []string
	for _, frame := range slices.Concat(w.asked, w.said) {
		if frame.channel == channel {
			payloads = append(payloads, frame.payload)
		}
	}
	return payloads
}

// lifecycle is everything said that is no request, in order.
func (w *workerWire) lifecycle() []sentFrame {
	w.mu.Lock()
	defer w.mu.Unlock()
	return slices.Clone(w.said)
}

// claimWorld is a client, a stand-in dispatcher that answers its claims, and
// a stand-in record that answers its commits. The record acknowledges every
// commit, and answers every question about an annotation with that
// annotation, unless a test has it do otherwise.
type claimWorld struct {
	wire   *workerWire
	client *Client

	mu       sync.Mutex
	offered  []string
	refusals []string
	// refusingCommits has the record refuse each commit.
	refusingCommits bool
	// unacknowledged is how many of the next commits no acknowledgement
	// reaches.
	unacknowledged int
	// unanswered is how many of the next questions no answer reaches.
	unanswered int
	// askedOf is the failure the record answers a question about an
	// annotation with, by the annotation's id.
	askedOf map[string]string
}

func newClaimWorld(t *testing.T, timing Timing) *claimWorld {
	t.Helper()
	w := &claimWorld{wire: newWorkerWire(), askedOf: map[string]string{}}
	w.wire.answer = w.answer
	w.client = NewClient(ClientConfig{Transport: w.wire, Timing: timing})
	t.Cleanup(func() {
		w.client.Close()
		w.wire.Close()
	})
	return w
}

// quick is the client's timing with a commit's wait a test can sit out.
func quick() Timing {
	timing := DefaultTiming()
	timing.MarkCommitTimeout = 100 * time.Millisecond
	return timing
}

func (w *claimWorld) offer(jobs ...string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.offered = append(w.offered, jobs...)
}

func (w *claimWorld) answer(request bus.Channel, payload map[string]any) (string, bool, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	switch request {
	case bus.JobClaim.Request().Channel():
		if len(w.refusals) > 0 {
			refusal := w.refusals[0]
			w.refusals = w.refusals[1:]
			return refusal, true, true
		}
		if len(w.offered) == 0 {
			return `{"message": "No pending job matches", "code": "none-pending"}`, true, true
		}
		job := w.offered[0]
		w.offered = w.offered[1:]
		return `{"response": ` + job + `}`, false, true
	case bus.MarkCommit.Request().Channel():
		if w.unacknowledged > 0 {
			w.unacknowledged--
			return "", false, false
		}
		if w.refusingCommits {
			return `{"message": "the record could not append"}`, true, true
		}
		return `{"response": {"persisted": 1, "annotationIds": ["ann-1"]}}`, false, true
	case bus.BrowseAnnotationRequested.Request().Channel():
		if w.unanswered > 0 {
			w.unanswered--
			return "", false, false
		}
		id, _ := payload["annotationId"].(string)
		if refusal, ok := w.askedOf[id]; ok {
			return refusal, true, true
		}
		return `{"response": {"annotation": ` + annotationJSON(id) + `, "resource": null, "resolvedResource": null}}`, false, true
	}
	return `{"message": "nothing is scripted to answer this"}`, true, true
}

// running is a running job as the dispatcher returns one from a claim, its
// metadata and params given as JSON members to add.
func running(jobID, jobType, metadata, params string) string {
	if metadata != "" {
		metadata = ", " + metadata
	}
	if params != "" {
		params = ", " + params
	}
	return `{"status": "running", "metadata": {"id": "` + jobID + `", "type": "` + jobType + `", "userId": "did:web:kb.example:users:u",
		"created": "2026-01-01T00:00:00.000Z", "retryCount": 0, "maxRetries": 1` + metadata + `},
		"params": {"resourceId": "res-1"` + params + `}, "startedAt": "2026-01-01T00:00:01.000Z", "progress": {}}`
}

// queuedOf is an announcement of a mark job of motivation. It states less
// than the spec has a job state, on purpose: an announcement is compared with
// a claim as it came.
func queuedOf(motivation string) string {
	return `{"jobId": "job-announced", "jobType": "mark", "resourceId": "res-9", "userId": "did:web:kb.example:users:u", "params": {"motivation": "` + motivation + `"}}`
}

func annotationJSON(id string) string {
	return `{"@context": "http://www.w3.org/ns/anno.jsonld", "type": "Annotation", "id": "` + id + `", "motivation": "highlighting",
		"target": {"source": "res-1", "selector": {"type": "TextQuoteSelector", "exact": "the words of ` + id + `"}}, "created": "2026-01-01T00:00:00.000Z"}`
}

func readJSON[T any](t *testing.T, text string) T {
	t.Helper()
	var value T
	if err := json.Unmarshal([]byte(text), &value); err != nil {
		t.Fatalf("%s does not read: %v", text, err)
	}
	return value
}

// sameJSON is whether got and want are one JSON value, however each was
// written.
func sameJSON(t *testing.T, got, want string) bool {
	t.Helper()
	return reflect.DeepEqual(readJSON[any](t, got), readJSON[any](t, want))
}

func filters(t *testing.T, text string) []api.JobFilter {
	return readJSON[[]api.JobFilter](t, text)
}

const everything = `[{"jobType": "mark", "params": {"motivation": "highlighting"}}, {"jobType": "mark", "params": {"motivation": "commenting"}},
	{"jobType": "mark", "params": {"motivation": "assessing"}}, {"jobType": "mark", "params": {"motivation": "linking"}},
	{"jobType": "mark", "params": {"motivation": "tagging"}}, {"jobType": "yield"}]`

// handed is the claims, pulled one at a time.
type handed struct {
	next func() (HeldJob, error, bool)
	stop func()
}

func pulling(t *testing.T, claims *Claims) *handed {
	next, stop := iter.Pull2(claims.All())
	t.Cleanup(stop)
	return &handed{next, stop}
}

type pulled struct {
	job HeldJob
	err error
	ok  bool
}

// take is what the claims hand out next, within two seconds.
func (h *handed) take(t *testing.T) pulled {
	t.Helper()
	came := make(chan pulled, 1)
	go func() {
		job, err, ok := h.next()
		came <- pulled{job, err, ok}
	}()
	select {
	case one := <-came:
		return one
	case <-time.After(2 * time.Second):
		t.Fatal("nothing was handed out")
		return pulled{}
	}
}

// held is the job the claims hand out next.
func (h *handed) held(t *testing.T) HeldJob {
	t.Helper()
	one := h.take(t)
	if !one.ok || one.err != nil {
		t.Fatalf("a job was not handed out: ended %v, refused %v", !one.ok, one.err)
	}
	return one.job
}

// eventually waits, two seconds at most, for seen.
func eventually(t *testing.T, what string, seen func() bool) {
	t.Helper()
	for range 400 {
		if seen() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("%s did not happen", what)
}

// settledFor is long enough for what a test waits not to happen.
func settledFor() { time.Sleep(50 * time.Millisecond) }

func finish(t *testing.T, job HeldJob) {
	t.Helper()
	mark, ok := job.(*HeldMarkJob)
	if !ok {
		t.Fatalf("%T is no mark job", job)
	}
	if err := mark.Complete(context.Background(), readJSON[api.MarkJobResult](t, `{"found": 0, "persisted": 0}`)); err != nil {
		t.Fatal(err)
	}
}

func specCases(t *testing.T, path string) []json.RawMessage {
	t.Helper()
	text, err := os.ReadFile("../../specs/src/" + path)
	if err != nil {
		t.Fatal(err)
	}
	var table struct {
		Cases []json.RawMessage `json:"cases"`
	}
	if err := json.Unmarshal(text, &table); err != nil {
		t.Fatal(err)
	}
	return table.Cases
}

func TestWhetherAJobMatchesAFilterIsTheTablesAnswer(t *testing.T) {
	asked := map[bool]bool{}
	for _, raw := range specCases(t, "jobs/filter-cases.json") {
		var c struct {
			Why     string `json:"why"`
			Filter  any    `json:"filter"`
			Job     any    `json:"job"`
			Matches bool   `json:"matches"`
		}
		if err := json.Unmarshal(raw, &c); err != nil {
			t.Fatal(err)
		}
		if got := jobMatchesFilter(c.Filter, c.Job); got != c.Matches {
			t.Errorf("%s: matched %v", c.Why, got)
		}
		asked[c.Matches] = true
	}
	if len(asked) != 2 {
		t.Error("the table asks both ways")
	}
}

func TestWhetherAFailedJobIsRetriedIsTheTablesAnswer(t *testing.T) {
	cases := specCases(t, "jobs/retry-cases.json")
	if len(cases) == 0 {
		t.Fatal("the table has no case")
	}
	for _, raw := range cases {
		var c struct {
			Why          string            `json:"why"`
			RetryCount   int               `json:"retryCount"`
			MaxRetries   int               `json:"maxRetries"`
			FailureClass *api.FailureClass `json:"failureClass"`
			Retries      bool              `json:"retries"`
		}
		if err := json.Unmarshal(raw, &c); err != nil {
			t.Fatal(err)
		}
		if got := WillRetryAfter(c.RetryCount, c.MaxRetries, c.FailureClass); got != c.Retries {
			t.Errorf("%s: retried %v", c.Why, got)
		}
	}
}

// Every class of failure, and every observation of a commit, the spec names
// has its answer here, and nothing the spec does not name does.
func TestEveryFailureClassAndEveryObservationTheSpecNamesIsAnswered(t *testing.T) {
	var classes, evidence []string
	for class := range maps.Keys(retriedClasses) {
		classes = append(classes, string(class))
	}
	for observed := range maps.Keys(weakness) {
		evidence = append(evidence, string(observed))
	}
	for schema, answered := range map[string][]string{"FailureClass": classes, "DurabilityEvidence": evidence} {
		slices.Sort(answered)
		text, err := os.ReadFile("../../specs/src/components/schemas/" + schema + ".json")
		if err != nil {
			t.Fatal(err)
		}
		var stated struct {
			Enum []string `json:"enum"`
		}
		if err := json.Unmarshal(text, &stated); err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(slices.Sorted(slices.Values(stated.Enum)), answered) {
			t.Errorf("%s names %v, and this SDK answers %v", schema, stated.Enum, answered)
		}
	}
}

func TestClaimsNothingUntilRangedThenHoldsTheJobAsTheRecordStatesIt(t *testing.T) {
	w := newClaimWorld(t, DefaultTiming())
	cursor := `{"next": 1200, "size": 800, "found": 4, "emitted": 3, "errors": 0}`
	w.offer(running("job-1", "mark", `"retryCount": 1, "maxRetries": 3, "completedUnits": ["Person"], "unitCursors": {"Place": `+cursor+`}`,
		`"motivation": "highlighting", "density": 3`))
	claims := w.client.Job.Claim(filters(t, `[{"jobType": "mark", "params": {"motivation": "highlighting"}}]`))
	defer claims.Close()
	settledFor()
	if sent := w.wire.sent(bus.JobClaim.Request().Channel()); len(sent) != 0 {
		t.Fatalf("claimed before the claims were ranged over: %v", sent)
	}
	job := pulling(t, claims).held(t)
	sent := w.wire.sent(bus.JobClaim.Request().Channel())
	if len(sent) != 1 || !sameJSON(t, sent[0], `{"accepts": [{"jobType": "mark", "params": {"motivation": "highlighting"}}]}`) {
		t.Fatalf("the claim sent %v", sent)
	}
	if job.JobId().String() != "job-1" || job.JobType() != api.JobTypeMark || job.ResourceId().String() != "res-1" {
		t.Errorf("held %s, a %s job of %s", job.JobId(), job.JobType(), job.ResourceId())
	}
	if job.RetryCount() != 1 || job.MaxRetries() != 3 || job.Attempt() != 2 {
		t.Errorf("retries %d of %d, attempt %d", job.RetryCount(), job.MaxRetries(), job.Attempt())
	}
	if !slices.Equal(job.CompletedUnits(), []string{"Person"}) || job.UnitCursors()["Place"].Next != 1200 {
		t.Errorf("resumes from %v and %v", job.CompletedUnits(), job.UnitCursors())
	}
	if !job.AnnotationId().IsZero() || job.Cancelled().Value() || job.Settled() {
		t.Errorf("anchored to %q, cancelled %v, settled %v", job.AnnotationId(), job.Cancelled().Value(), job.Settled())
	}
	finish(t, job)
}

func TestClaimsAgainWhenAJobIsSettledAndAnAnnouncementWhileOneIsHeldIsIgnored(t *testing.T) {
	w := newClaimWorld(t, DefaultTiming())
	w.offer(running("job-1", "mark", "", ""), running("job-2", "mark", "", ""), running("job-3", "mark", "", ""))
	claims := w.client.Job.Claim(filters(t, everything))
	defer claims.Close()
	pull := pulling(t, claims)
	claimsSent := func() int { return len(w.wire.sent(bus.JobClaim.Request().Channel())) }
	first := pull.held(t)
	w.wire.relay(bus.JobQueued.Channel(), queuedOf("highlighting"))
	settledFor()
	if claimsSent() != 1 {
		t.Fatalf("%d claims while holding a job", claimsSent())
	}
	finish(t, first)
	second := pull.held(t)
	if claimsSent() != 2 || second.JobId().String() != "job-2" {
		t.Fatalf("%d claims, holding %s", claimsSent(), second.JobId())
	}
	if err := second.Fail(context.Background(), "kaboom", JobFailure{}); err != nil {
		t.Fatal(err)
	}
	third := pull.held(t)
	if err := third.Cancel(context.Background(), nil, nil); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the settle asks, and is told nothing is pending", func() bool { return claimsSent() == 4 })
}

func TestAMatchingAnnouncementClaimsAndOneThatMatchesNoFilterDoesNot(t *testing.T) {
	w := newClaimWorld(t, DefaultTiming())
	claims := w.client.Job.Claim(filters(t, `[{"jobType": "mark", "params": {"motivation": "tagging"}}]`))
	defer claims.Close()
	claimsSent := func() int { return len(w.wire.sent(bus.JobClaim.Request().Channel())) }
	pull := pulling(t, claims)
	reading := make(chan HeldJob, 1)
	go func() {
		job, _, _ := pull.next()
		reading <- job
	}()
	eventually(t, "the first claim, answered with nothing pending", func() bool { return claimsSent() == 1 })
	w.wire.relay(bus.JobQueued.Channel(), queuedOf("highlighting"))
	settledFor()
	if claimsSent() != 1 {
		t.Fatal("a round trip for a job this worker does not take")
	}
	w.offer(running("job-1", "mark", "", `"motivation": "tagging"`))
	w.wire.relay(bus.JobQueued.Channel(), queuedOf("tagging"))
	select {
	case job := <-reading:
		finish(t, job)
	case <-time.After(2 * time.Second):
		t.Fatal("the matching announcement claimed nothing")
	}
	eventually(t, "the settle asks", func() bool { return claimsSent() == 3 })
}

func TestClaimsWhenTheStreamOpensAndWhenItOpensAgain(t *testing.T) {
	w := newClaimWorld(t, DefaultTiming())
	w.wire.state.Set(ConnectionStateConnecting)
	claims := w.client.Job.Claim(filters(t, everything))
	defer claims.Close()
	claimsSent := func() int { return len(w.wire.sent(bus.JobClaim.Request().Channel())) }
	go func() {
		for range claims.All() {
		}
	}()
	settledFor()
	if claimsSent() != 0 {
		t.Fatal("a claim on a closed stream would only be refused here")
	}
	w.wire.state.Set(ConnectionStateOpen)
	eventually(t, "the stream opening asks", func() bool { return claimsSent() == 1 })
	w.wire.state.Set(ConnectionStateReconnecting)
	settledFor()
	if claimsSent() != 1 {
		t.Fatal("losing the stream claimed")
	}
	w.wire.state.Set(ConnectionStateOpen)
	eventually(t, "regaining it asks", func() bool { return claimsSent() == 2 })
}

func TestARefusalIsHandedOutWithItsCodeAndAReplyThatNamesNoJobIsRefusedHere(t *testing.T) {
	w := newClaimWorld(t, DefaultTiming())
	w.refusals = append(w.refusals, `{"message": "the caller is not a worker for this knowledge base", "code": "unauthorized"}`)
	claims := w.client.Job.Claim(filters(t, everything))
	defer claims.Close()
	pull := pulling(t, claims)
	var refused *ClaimRefusal
	if one := pull.take(t); !errors.As(one.err, &refused) || refused.Code == nil || *refused.Code != BusRequestErrorCodeUnauthorized ||
		refused.Message != "the caller is not a worker for this knowledge base" {
		t.Fatalf("handed out %+v", one)
	}
	settledFor()
	if sent := w.wire.sent(bus.JobClaim.Request().Channel()); len(sent) != 1 {
		t.Fatalf("it asked again by itself: %d claims", len(sent))
	}
	// WORKER-CONTRACT C9: a worker must not run what it cannot read, and goes on claiming.
	w.offer(`{"status": "running"}`)
	w.wire.relay(bus.JobQueued.Channel(), queuedOf("highlighting"))
	if one := pull.take(t); !errors.As(one.err, &refused) || refused.Code != nil {
		t.Fatalf("a reply that names no job was handed out as %+v", one)
	}
	w.offer(running("job-1", "mark", "", ""))
	w.wire.relay(bus.JobQueued.Channel(), queuedOf("highlighting"))
	finish(t, pull.held(t))
}

func TestAStreamThatDoesNotNameWhatClaimingReadsCannotCarryAWorkersClaims(t *testing.T) {
	names := []bus.Channel{"job:claimed", "job:claim-failed", "job:queued", "job:cancel-requested"}
	if !slices.Equal(JobClaimChannels, names) {
		t.Fatalf("JobClaimChannels is %v", JobClaimChannels)
	}
	if want := []bus.Channel{"mark:commit-ok", "mark:commit-failed", "browse:annotation-result", "browse:annotation-failed"}; !slices.Equal(JobCommitChannels, want) {
		t.Fatalf("JobCommitChannels is %v", JobCommitChannels)
	}
	w := newClaimWorld(t, DefaultTiming())
	// A worker on such a stream would claim once and never be woken, with nothing to show for it.
	w.wire.channels = []bus.Channel{"job:claimed", "job:claim-failed"}
	claims := w.client.Job.Claim(filters(t, everything))
	defer claims.Close()
	one := pulling(t, claims).take(t)
	var refused *BusRequestError
	if !errors.As(one.err, &refused) || refused.Code != BusRequestErrorCodeUnsubscribed {
		t.Fatalf("handed out %+v", one)
	}
	if sent := w.wire.sent(bus.JobClaim.Request().Channel()); len(sent) != 0 {
		t.Fatalf("it claimed: %v", sent)
	}
}

func TestAHeldJobSaysItsWholeLifecycleItself(t *testing.T) {
	w := newClaimWorld(t, DefaultTiming())
	w.offer(running("job-1", "mark", `"retryCount": 1`, ""))
	cursor := `{"next": 1200, "size": 800, "found": 4, "emitted": 3, "errors": 0}`
	claims := w.client.Job.Claim(filters(t, everything))
	job, ok := pulling(t, claims).held(t).(*HeldMarkJob)
	if !ok {
		t.Fatal("a mark job is held as a *HeldMarkJob")
	}
	ctx := context.Background()
	if err := job.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if err := job.Progress(ctx, api.JobProgress{Percentage: 40}); err != nil {
		t.Fatal(err)
	}
	if err := job.Checkpoint(ctx, []string{"Person"}, map[string]api.UnitCursor{"Place": readJSON[api.UnitCursor](t, cursor)}); err != nil {
		t.Fatal(err)
	}
	if err := job.Commit(ctx, job.ResourceId(), []api.Annotation{readJSON[api.Annotation](t, annotationJSON("ann-1"))}); err != nil {
		t.Fatal(err)
	}
	if err := job.Complete(ctx, readJSON[api.MarkJobResult](t, `{"found": 9, "persisted": 7}`)); err != nil {
		t.Fatal(err)
	}
	if err := job.Fail(ctx, "too late", JobFailure{}); err == nil {
		t.Fatal("a settled job settled again")
	}
	claims.Close()
	identity := `"resourceId": "res-1", "jobId": "job-1", "jobType": "mark", "attempt": 2`
	want := []sentFrame{
		{"job:start", `{` + identity + `}`},
		{"job:report-progress", `{` + identity + `, "percentage": 40, "progress": {"percentage": 40}}`},
		{"job:checkpoint", `{"jobId": "job-1", "completedUnits": ["Person"], "unitCursors": {"Place": ` + cursor + `}}`},
		{"job:complete", `{` + identity + `, "result": {"found": 9, "persisted": 7}, "durability": "acknowledged"}`},
	}
	said := w.wire.lifecycle()
	if len(said) != len(want) {
		t.Fatalf("said %v", said)
	}
	for i := range want {
		if said[i].channel != want[i].channel || !sameJSON(t, said[i].payload, want[i].payload) {
			t.Errorf("said %s %s, not %s %s", said[i].channel, said[i].payload, want[i].channel, want[i].payload)
		}
	}
}

func TestAYieldJobFocusedOnAnAnnotationIsAnchoredToItAndSaysSo(t *testing.T) {
	w := newClaimWorld(t, DefaultTiming())
	w.offer(running("job-1", "yield", `"maxRetries": 0`, `"context": {"focus": {"kind": "annotation", "annotation": {"id": "ann-7"}}}`))
	claims := w.client.Job.Claim(filters(t, everything))
	defer claims.Close()
	job, ok := pulling(t, claims).held(t).(*HeldYieldJob)
	if !ok {
		t.Fatal("a yield job is held as a *HeldYieldJob")
	}
	if job.AnnotationId().String() != "ann-7" {
		t.Fatalf("anchored to %q", job.AnnotationId())
	}
	ctx := context.Background()
	if err := job.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if err := job.Start(ctx); err == nil {
		t.Fatal("job:start was said twice")
	}
	if err := job.Progress(ctx, api.JobProgress{Percentage: 5}); err != nil {
		t.Fatal(err)
	}
	if err := job.Complete(ctx, readJSON[api.YieldJobResult](t, `{"resourceId": "res-1", "resourceName": "Ouranos", "truncated": false}`)); err != nil {
		t.Fatal(err)
	}
	identity := `"resourceId": "res-1", "jobId": "job-1", "jobType": "yield", "attempt": 1, "annotationId": "ann-7"`
	said := w.wire.lifecycle()
	if len(said) != 3 || !sameJSON(t, said[0].payload, `{`+identity+`}`) ||
		!sameJSON(t, said[1].payload, `{`+identity+`, "percentage": 5, "progress": {"percentage": 5, "annotationId": "ann-7"}}`) ||
		!sameJSON(t, said[2].payload, `{`+identity+`, "result": {"resourceId": "res-1", "resourceName": "Ouranos", "truncated": false}}`) {
		t.Fatalf("said %v", said)
	}
}

func TestAFailureSaysWhetherItWillBeRetriedAndACancelSaysOnlyWhatItsCommandNames(t *testing.T) {
	w := newClaimWorld(t, DefaultTiming())
	w.offer(running("job-1", "mark", `"retryCount": 0, "maxRetries": 1`, ""), running("job-2", "mark", `"retryCount": 1, "maxRetries": 1`, ""),
		running("job-3", "mark", "", ""))
	claims := w.client.Job.Claim(filters(t, everything))
	pull := pulling(t, claims)
	ctx := context.Background()
	if err := pull.held(t).Fail(ctx, "the model timed out", JobFailure{CompletedUnits: []string{"Person"}}); err != nil {
		t.Fatal(err)
	}
	if err := pull.held(t).Fail(ctx, "the model timed out", JobFailure{}); err != nil {
		t.Fatal(err)
	}
	if err := pull.held(t).Cancel(ctx, []string{"Person"}, nil); err != nil {
		t.Fatal(err)
	}
	claims.Close()
	base := `"resourceId": "res-1", "jobType": "mark"`
	failed := w.wire.sent(bus.JobFail.Channel())
	// A class the worker does not know is not stated.
	if len(failed) != 2 ||
		!sameJSON(t, failed[0], `{`+base+`, "jobId": "job-1", "attempt": 1, "error": "the model timed out", "completedUnits": ["Person"], "willRetry": true}`) ||
		!sameJSON(t, failed[1], `{`+base+`, "jobId": "job-2", "attempt": 2, "error": "the model timed out", "willRetry": false}`) {
		t.Fatalf("failed %v", failed)
	}
	if cancelled := w.wire.sent(bus.JobCancel.Channel()); len(cancelled) != 1 || !sameJSON(t, cancelled[0], `{`+base+`, "jobId": "job-3", "completedUnits": ["Person"]}`) {
		t.Fatalf("cancelled %v", cancelled)
	}
}

func TestACancellationThatNamesTheHeldJobIsSignalledAndAnyOtherIsNot(t *testing.T) {
	w := newClaimWorld(t, DefaultTiming())
	w.offer(running("job-1", "mark", "", ""))
	claims := w.client.Job.Claim(filters(t, everything))
	defer claims.Close()
	job := pulling(t, claims).held(t)
	w.wire.relay(bus.JobCancelRequested.Request().Channel(), `{"jobId": "job-7"}`)
	settledFor()
	if job.Cancelled().Value() {
		t.Fatal("a cancellation of another job was signalled")
	}
	w.wire.relay(bus.JobCancelRequested.Request().Channel(), `{"jobId": "job-1"}`)
	eventually(t, "the cancellation", job.Cancelled().Value)
	if err := job.Cancel(context.Background(), nil, nil); err != nil {
		t.Fatal(err)
	}
	// Settled: whoever watches for a cancellation is told there is no more.
	for range job.Cancelled().Changes(context.Background()) {
	}
}

// WORKER-CONTRACT L8.
func TestAWorkerThatClosesFailsTheJobItHoldsAndClaimsNothingMore(t *testing.T) {
	w := newClaimWorld(t, DefaultTiming())
	w.offer(running("job-1", "mark", "", ""))
	claims := w.client.Job.Claim(filters(t, everything))
	pull := pulling(t, claims)
	job := pull.held(t)
	claims.Close()
	if failed := w.wire.sent(bus.JobFail.Channel()); len(failed) != 1 || !sameJSON(t, failed[0],
		`{"resourceId": "res-1", "jobId": "job-1", "jobType": "mark", "attempt": 1, "error": "The worker stopped while it held the job", "willRetry": true}`) {
		t.Fatalf("failed %v", failed)
	}
	if !job.Settled() {
		t.Fatal("the job is not settled")
	}
	if one := pull.take(t); one.ok {
		t.Fatalf("closed claims handed out %+v", one)
	}
	if sent := w.wire.sent(bus.JobClaim.Request().Channel()); len(sent) != 1 {
		t.Fatalf("%d claims", len(sent))
	}
	claims.Close()
}

func TestACommitIsEstablishedWhenTheRecordAcknowledgesItOrSaysItsLastAnnotationIsThere(t *testing.T) {
	ctx := context.Background()
	batch := func(t *testing.T) []api.Annotation {
		return []api.Annotation{readJSON[api.Annotation](t, annotationJSON("ann-0")), readJSON[api.Annotation](t, annotationJSON("ann-1"))}
	}
	held := func(t *testing.T, w *claimWorld) (*HeldMarkJob, *Claims) {
		w.offer(running("job-1", "mark", "", ""))
		claims := w.client.Job.Claim(filters(t, everything))
		return pulling(t, claims).held(t).(*HeldMarkJob), claims
	}

	t.Run("acknowledged, citing the job", func(t *testing.T) {
		w := newClaimWorld(t, quick())
		job, claims := held(t, w)
		defer claims.Close()
		if err := job.Commit(ctx, job.ResourceId(), batch(t)); err != nil {
			t.Fatal(err)
		}
		committed := w.wire.sent(bus.MarkCommit.Request().Channel())
		if len(committed) != 1 || readJSON[map[string]any](t, committed[0])["jobId"] != "job-1" {
			t.Fatalf("committed %v", committed)
		}
		if asked := w.wire.sent(bus.BrowseAnnotationRequested.Request().Channel()); len(asked) != 0 {
			t.Fatalf("asked %v", asked)
		}
	})

	t.Run("a batch of no annotations is no commit, and a job that committed nothing states nothing", func(t *testing.T) {
		w := newClaimWorld(t, quick())
		job, claims := held(t, w)
		defer claims.Close()
		if err := job.Commit(ctx, job.ResourceId(), nil); err != nil {
			t.Fatal(err)
		}
		if err := job.Complete(ctx, readJSON[api.MarkJobResult](t, `{"found": 0, "persisted": 0}`)); err != nil {
			t.Fatal(err)
		}
		if committed := w.wire.sent(bus.MarkCommit.Request().Channel()); len(committed) != 0 {
			t.Fatalf("committed %v", committed)
		}
		if _, stated := readJSON[map[string]any](t, w.wire.sent(bus.JobComplete.Channel())[0])["durability"]; stated {
			t.Fatal("the completion states durability")
		}
	})

	t.Run("refused by the record: its reason, and nothing is asked", func(t *testing.T) {
		w := newClaimWorld(t, quick())
		w.refusingCommits = true
		job, claims := held(t, w)
		defer claims.Close()
		var refused *BusRequestError
		if err := job.Commit(ctx, job.ResourceId(), batch(t)); !errors.As(err, &refused) || refused.Message != "the record could not append" {
			t.Fatalf("committed with %v", err)
		}
		if asked := w.wire.sent(bus.BrowseAnnotationRequested.Request().Channel()); len(asked) != 0 {
			t.Fatalf("asked %v", asked)
		}
	})

	t.Run("unacknowledged, and its last annotation is there", func(t *testing.T) {
		w := newClaimWorld(t, quick())
		w.unacknowledged = 1
		job, claims := held(t, w)
		defer claims.Close()
		if err := job.Commit(ctx, job.ResourceId(), batch(t)); err != nil {
			t.Fatal(err)
		}
		asked := w.wire.sent(bus.BrowseAnnotationRequested.Request().Channel())
		if len(asked) != 1 || !sameJSON(t, asked[0], `{"resourceId": "res-1", "annotationId": "ann-1"}`) {
			t.Fatalf("asked %v", asked)
		}
		if err := job.Complete(ctx, readJSON[api.MarkJobResult](t, `{"found": 2, "persisted": 2}`)); err != nil {
			t.Fatal(err)
		}
		if durability := readJSON[map[string]any](t, w.wire.sent(bus.JobComplete.Channel())[0])["durability"]; durability != "probe-confirmed" {
			t.Fatalf("the completion states %v", durability)
		}
	})

	t.Run("unacknowledged, and answered that it is not there", func(t *testing.T) {
		w := newClaimWorld(t, quick())
		w.unacknowledged = 1
		w.askedOf["ann-1"] = `{"message": "Annotation not found"}`
		job, claims := held(t, w)
		defer claims.Close()
		var timedOut *BusRequestError
		if err := job.Commit(ctx, job.ResourceId(), batch(t)); !errors.As(err, &timedOut) || timedOut.Code != BusRequestErrorCodeTimeout {
			t.Fatalf("committed with %v", err)
		}
		if err := job.Fail(ctx, "a commit was not established", JobFailure{}); err != nil {
			t.Fatal(err)
		}
		if durability := readJSON[map[string]any](t, w.wire.sent(bus.JobFail.Channel())[0])["durability"]; durability != "probe-refused" {
			t.Fatalf("the failure states %v", durability)
		}
	})

	t.Run("unacknowledged, and nobody answers the question", func(t *testing.T) {
		w := newClaimWorld(t, quick())
		w.unacknowledged, w.unanswered = 1, 1
		job, claims := held(t, w)
		defer claims.Close()
		if err := job.Commit(ctx, job.ResourceId(), batch(t)); err == nil {
			t.Fatal("a commit nobody answered was established")
		}
		if err := job.Fail(ctx, "a commit was not established", JobFailure{}); err != nil {
			t.Fatal(err)
		}
		if durability := readJSON[map[string]any](t, w.wire.sent(bus.JobFail.Channel())[0])["durability"]; durability != "probe-unreachable" {
			t.Fatalf("the failure states %v", durability)
		}
	})

	t.Run("a stream that names no reply to a commit carries none of its commits", func(t *testing.T) {
		w := newClaimWorld(t, quick())
		w.wire.channels = JobClaimChannels
		job, claims := held(t, w)
		defer claims.Close()
		var refused *BusRequestError
		if err := job.Commit(ctx, job.ResourceId(), batch(t)); !errors.As(err, &refused) || refused.Code != BusRequestErrorCodeUnsubscribed {
			t.Fatalf("committed with %v", err)
		}
		if committed := w.wire.sent(bus.MarkCommit.Request().Channel()); len(committed) != 0 {
			t.Fatalf("committed %v", committed)
		}
	})
}

func TestVitalsSayWhatTheWorkerHoldsAndHasDoneAndASilentHeldJobIsStalled(t *testing.T) {
	timing := DefaultTiming()
	timing.HeldJobStall = 50 * time.Millisecond
	timing.HeldJobStallCheck = 10 * time.Millisecond
	w := newClaimWorld(t, timing)
	w.offer(running("job-1", "mark", "", ""))
	claims := w.client.Job.Claim(filters(t, everything))
	defer claims.Close()
	if vitals := claims.Vitals(); vitals.ActiveJob != nil || !vitals.LastClaimAt.IsZero() || vitals.JobsCompleted != 0 {
		t.Fatalf("before any claim, %+v", vitals)
	}
	pull := pulling(t, claims)
	job := pull.held(t)
	vitals := claims.Vitals()
	if vitals.ActiveJob == nil || vitals.ActiveJob.JobId != job.JobId() || vitals.LastClaimAt.IsZero() {
		t.Fatalf("holding a job, %+v", vitals)
	}
	w.wire.relay(bus.JobQueued.Channel(), queuedOf("tagging"))
	eventually(t, "the announcement is stamped", func() bool { return !claims.Vitals().LastQueuedEventAt.IsZero() })
	eventually(t, "the stall", func() bool { return claims.Stalled().Value() != nil })
	if stall := claims.Stalled().Value(); stall.JobId != job.JobId() || stall.Threshold != timing.HeldJobStall || stall.SilentFor <= timing.HeldJobStall {
		t.Fatalf("stalled %+v", stall)
	}
	finish(t, job)
	if vitals := claims.Vitals(); vitals.ActiveJob != nil || vitals.JobsCompleted != 1 || vitals.LastFinishedAt.IsZero() {
		t.Fatalf("after the settle, %+v", vitals)
	}
}

func TestAHeldJobStatesTheTraceItsReplyArrivedIn(t *testing.T) {
	w := newClaimWorld(t, DefaultTiming())
	w.wire.replyTrace = TraceContext{Traceparent: "00-11111111111111111111111111111111-1111111111111111-01"}
	w.offer(running("job-1", "mark", "", ""))
	claims := w.client.Job.Claim(filters(t, everything))
	defer claims.Close()
	if job := pulling(t, claims).held(t); job.Trace() != w.wire.replyTrace {
		t.Fatalf("the job states %+v", job.Trace())
	}
}
