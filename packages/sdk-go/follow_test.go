package semiont_test

// Following a job (docs/protocol/JOBS.md § Following a job), through the two
// methods that create one: Mark.Delegate and Yield.Delegate.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"iter"
	"reflect"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bustest"
)

// followContext is a gathered context whose focus is res-1.
const followContext = `{"focus":{"kind":"resource","resource":{"@context":"https://schema.org","@id":"res-1","name":"A resource","representations":[]}},"graph":{"nodes":[],"edges":[]},"metadata":{}}`

// generated is what a yield job reports it made.
const generated = `{"resourceId":"res-summary","resourceName":"A summary","truncated":false}`

var (
	jobCreate   = bus.JobCreate.Request().Channel()
	jobStatus   = bus.JobStatusRequested.Request().Channel()
	jobCancel   = bus.JobCancelRequested.Request().Channel()
	jobProgress = bus.JobReportProgress.Channel()
	jobComplete = bus.JobComplete.Channel()
	jobFail     = bus.JobFail.Channel()
)

// jobTiming is the client's waits, with a followed job's silence and status
// poll as stated.
func jobTiming(silence, poll time.Duration) semiont.Timing {
	timing := semiont.DefaultTiming()
	timing.JobSilence, timing.JobStatusPoll = silence, poll
	return timing
}

// jobWorld is a client over a fake whose job:create is answered with job-1,
// or by the test when it is not answered.
func jobWorld(t *testing.T, answered bool, timing semiont.Timing) (*semiont.Client, *bustest.Fake) {
	t.Helper()
	fake := bustest.NewFake()
	if answered {
		fake.Queued[jobCreate] = []json.RawMessage{json.RawMessage(`{"response":{"jobId":"job-1"}}`)}
	} else {
		fake.Unanswered[jobCreate] = true
	}
	c := semiont.NewClient(semiont.ClientConfig{Transport: fake, Content: &bustest.RecordingContent{}, Gateway: &bustest.RecordingGateway{}, Timing: timing})
	t.Cleanup(func() {
		c.Close()
		fake.Close()
	})
	return c, fake
}

func highlighting(t *testing.T, c *semiont.Client) *semiont.Delegation[api.MarkJobCompleteCommand] {
	t.Helper()
	var params api.MarkJobParams
	if err := params.FromHighlightingJobParams(api.HighlightingJobParams{Motivation: api.HighlightingJobParamsMotivationHighlighting}); err != nil {
		t.Fatal(err)
	}
	return c.Mark.Delegate(resourceOf(t, "res-1"), params)
}

func generation(t *testing.T, c *semiont.Client, stall time.Duration, maxTokens *float32) *semiont.Delegation[api.YieldJobCompleteCommand] {
	t.Helper()
	var params api.GenerationJobParams
	if err := json.Unmarshal([]byte(`{"title":"A summary","storageUri":"file://a-summary.md","context":`+followContext+`}`), &params); err != nil {
		t.Fatal(err)
	}
	params.MaxTokens = maxTokens
	return c.Yield.Delegate(params, stall)
}

func resourceOf(t *testing.T, text string) api.ResourceId {
	t.Helper()
	id, err := api.ParseResourceId(text)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// say publishes a frame of the lifecycle of the job jobID, which is of that
// type, on the client's own bus.
func say(t *testing.T, c *semiont.Client, channel bus.Channel, jobID, of string, more map[string]any) {
	t.Helper()
	payload := map[string]any{"resourceId": "res-1", "jobId": jobID, "jobType": of}
	for name, value := range more {
		payload[name] = value
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	c.Bus.Deliver(semiont.Frame{Channel: channel, Payload: encoded})
}

func progressOf(percentage float64) map[string]any {
	return map[string]any{"percentage": percentage, "progress": map[string]any{"percentage": percentage}}
}

// statusOf is a job:status-result answering job-1 with status of, and more.
func statusOf(t *testing.T, of string, more map[string]any) json.RawMessage {
	t.Helper()
	response := map[string]any{"jobId": "job-1", "type": "mark", "status": of, "userId": "did:web:example.org:users:alice", "created": "2026-10-01T00:00:00.000Z"}
	for name, value := range more {
		response[name] = value
	}
	encoded, err := json.Marshal(map[string]any{"response": response})
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

// statuses is n answers of a status.
func statuses(answer json.RawMessage, n int) []json.RawMessage {
	return slices.Repeat([]json.RawMessage{answer}, n)
}

func requestsOn(fake *bustest.Fake, channel bus.Channel) []bustest.Requested {
	_, requests := fake.Sent()
	var on []bustest.Requested
	for _, request := range requests {
		if request.Channel == channel {
			on = append(on, request)
		}
	}
	return on
}

// waitUntil waits, limit at most, for done.
func waitUntil(t *testing.T, what string, limit time.Duration, done func() bool) {
	t.Helper()
	for deadline := time.Now().Add(limit); !done(); time.Sleep(5 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("%s did not happen within %s", what, limit)
		}
	}
}

// created waits for the n-th job:create to have been sent.
func created(t *testing.T, fake *bustest.Fake, n int) bustest.Requested {
	t.Helper()
	waitUntil(t, fmt.Sprintf("job:create number %d", n), time.Second, func() bool { return len(requestsOn(fake, jobCreate)) >= n })
	return requestsOn(fake, jobCreate)[n-1]
}

func kindOf(event semiont.JobEvent) string {
	switch event := event.(type) {
	case semiont.JobCreated:
		return "created " + event.Data.JobId.String()
	case semiont.JobProgressed:
		return fmt.Sprintf("progress %g", event.Data.Percentage)
	case semiont.JobAttemptFailed:
		return "failed"
	case semiont.JobCompleted[api.MarkJobCompleteCommand], semiont.JobCompleted[api.YieldJobCompleteCommand]:
		return "complete"
	}
	return fmt.Sprintf("an event of no kind: %T", event)
}

// codeOf is an error's code, or its words when it has none.
func codeOf(err error) string {
	var coded semiont.Error
	if errors.As(err, &coded) {
		return coded.ErrorCode()
	}
	return err.Error()
}

// followedJob is everything a follower gave: each event's kind, and the code
// of the failure that ended it; and the events themselves.
type followedJob struct {
	kinds []string
	seen  []semiont.JobEvent
}

// following ranges over events on a goroutine of its own.
func following(events iter.Seq2[semiont.JobEvent, error]) <-chan followedJob {
	out := make(chan followedJob, 1)
	go func() {
		var got followedJob
		for event, err := range events {
			if err != nil {
				got.kinds = append(got.kinds, "error "+codeOf(err))
				continue
			}
			got.seen = append(got.seen, event)
			got.kinds = append(got.kinds, kindOf(event))
		}
		out <- got
	}()
	return out
}

func followedWithin(t *testing.T, ch <-chan followedJob, limit time.Duration) followedJob {
	t.Helper()
	select {
	case got := <-ch:
		return got
	case <-time.After(limit):
		t.Fatalf("the follower did not end within %s", limit)
		panic("unreachable")
	}
}

// waited is a delegation's Wait on a goroutine of its own.
type waitedFor[C any] struct {
	done C
	err  error
}

func waiting[C any](d *semiont.Delegation[C]) <-chan waitedFor[C] {
	out := make(chan waitedFor[C], 1)
	go func() {
		done, err := d.Wait(context.Background())
		out <- waitedFor[C]{done, err}
	}()
	return out
}

func waitedWithin[C any](t *testing.T, ch <-chan waitedFor[C], limit time.Duration) waitedFor[C] {
	t.Helper()
	select {
	case got := <-ch:
		return got
	case <-time.After(limit):
		t.Fatalf("the wait did not end within %s", limit)
		panic("unreachable")
	}
}

func TestAJobReportsItsProgressAndEndsWithItsCompletion(t *testing.T) {
	t.Parallel()
	c, fake := jobWorld(t, true, semiont.DefaultTiming())
	followed := following(highlighting(t, c).Events(context.Background()))
	sent := created(t, fake, 1)
	if want := map[string]any{"jobType": "mark", "resourceId": "res-1", "params": map[string]any{"motivation": "highlighting"}}; !reflect.DeepEqual(normal(t, sent.Payload), want) {
		t.Fatalf("job:create sent %v, want %v", normal(t, sent.Payload), want)
	}
	say(t, c, jobProgress, "job-1", "mark", progressOf(10))
	// Another job's frames are not this follower's.
	say(t, c, jobProgress, "job-2", "mark", progressOf(99))
	say(t, c, jobComplete, "job-2", "mark", nil)
	say(t, c, jobProgress, "job-1", "mark", progressOf(60))
	// Progress that states nothing of how far the job is, reports nothing.
	say(t, c, jobProgress, "job-1", "mark", map[string]any{"percentage": 70})
	say(t, c, jobComplete, "job-1", "mark", map[string]any{"result": map[string]any{"found": 3, "persisted": 2, "errors": 1}})
	got := followedWithin(t, followed, time.Second)
	if want := []string{"created job-1", "progress 10", "progress 60", "complete"}; !slices.Equal(got.kinds, want) {
		t.Fatalf("the follower gave %v, want %v", got.kinds, want)
	}
	// Its completion is the last of its events.
	last, ok := got.seen[len(got.seen)-1].(semiont.JobCompleted[api.MarkJobCompleteCommand])
	if !ok {
		t.Fatalf("the last event is a %T", got.seen[len(got.seen)-1])
	}
	if last.Data.JobId.String() != "job-1" || last.Data.ResourceId.String() != "res-1" || last.Data.Result == nil {
		t.Fatalf("the completion is %+v", last.Data)
	}
	if counts, err := last.Data.Result.AsMarkJobDone(); err != nil || counts.Found != 3 || counts.Persisted != 2 || counts.Errors == nil || *counts.Errors != 1 {
		t.Fatalf("the completion's result reads as %+v (%v)", counts, err)
	}
	if asked := requestsOn(fake, jobStatus); len(asked) != 0 {
		t.Fatalf("a job heard from was asked for its status %d times", len(asked))
	}
}

// The id is what Job.Cancel names: the queue's answer to the job's creation,
// a follower's first event.
func TestAJobIsNamedBeforeAnythingElseOfItIsGiven(t *testing.T) {
	t.Parallel()
	c, fake := jobWorld(t, true, semiont.DefaultTiming())
	followed := following(highlighting(t, c).Events(context.Background()))
	created(t, fake, 1)
	say(t, c, jobComplete, "job-1", "mark", nil)
	got := followedWithin(t, followed, time.Second)
	if len(got.kinds) == 0 || got.kinds[0] != "created job-1" {
		t.Fatalf("the follower gave %v first", got.kinds)
	}
	first, err := json.Marshal(got.seen[0])
	if err != nil {
		t.Fatal(err)
	}
	if string(first) != `{"kind":"created","data":{"jobId":"job-1"}}` {
		t.Fatalf("the first event is written %s", first)
	}
}

func TestWaitedForAJobGivesItsCompletion(t *testing.T) {
	t.Parallel()
	c, fake := jobWorld(t, true, semiont.DefaultTiming())
	waited := waiting(highlighting(t, c))
	created(t, fake, 1)
	say(t, c, jobProgress, "job-1", "mark", progressOf(10))
	say(t, c, jobComplete, "job-1", "mark", map[string]any{"result": map[string]any{"found": 2, "persisted": 2}})
	got := waitedWithin(t, waited, time.Second)
	if got.err != nil {
		t.Fatal(got.err)
	}
	// The completion itself: a mark job's, whose result is what a mark job reports.
	if got.done.JobId.String() != "job-1" || got.done.JobType != api.MarkJobCompleteCommandJobTypeMark || got.done.ResourceId.String() != "res-1" || got.done.Result == nil {
		t.Fatalf("the completion is %+v", got.done)
	}
	if counts, err := got.done.Result.AsMarkJobDone(); err != nil || counts.Found != 2 || counts.Persisted != 2 {
		t.Fatalf("the result reads as %+v (%v)", counts, err)
	}
}

func TestWhatAMarkJobReportsIsItsCountsOrADecline(t *testing.T) {
	t.Parallel()
	for name, result := range map[string]map[string]any{
		"counts":    {"found": 4, "persisted": 3},
		"a decline": {"declined": true, "reason": "encrypted"},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			c, fake := jobWorld(t, true, semiont.DefaultTiming())
			waited := waiting(highlighting(t, c))
			created(t, fake, 1)
			say(t, c, jobComplete, "job-1", "mark", map[string]any{"result": result})
			got := waitedWithin(t, waited, time.Second)
			if got.err != nil || got.done.Result == nil {
				t.Fatalf("the completion is %+v (%v)", got.done, got.err)
			}
			written, err := got.done.Result.MarshalJSON()
			if err != nil || !reflect.DeepEqual(normal(t, json.RawMessage(written)), normal(t, result)) {
				t.Fatalf("the result is %s, want %v", written, result)
			}
		})
	}
}

func TestWaitedForAGenerationGivesTheResourceItMade(t *testing.T) {
	t.Parallel()
	c, fake := jobWorld(t, true, semiont.DefaultTiming())
	waited := waiting(generation(t, c, 0, nil))
	created(t, fake, 1)
	var made map[string]any
	if err := json.Unmarshal([]byte(generated), &made); err != nil {
		t.Fatal(err)
	}
	say(t, c, jobComplete, "job-1", "yield", map[string]any{"result": made})
	got := waitedWithin(t, waited, time.Second)
	if got.err != nil || got.done.JobType != api.YieldJobCompleteCommandJobTypeYield || got.done.Result == nil {
		t.Fatalf("the completion is %+v (%v)", got.done, got.err)
	}
	if done, err := got.done.Result.AsYieldJobDone(); err != nil || done.ResourceId.String() != "res-summary" || done.ResourceName != "A summary" || done.Truncated {
		t.Fatalf("the result reads as %+v (%v)", done, err)
	}
}

func TestADelegationIsWaitedForOrRangedOverAndOnce(t *testing.T) {
	t.Parallel()
	c, fake := jobWorld(t, true, semiont.DefaultTiming())
	read := highlighting(t, c)
	followed := following(read.Events(context.Background()))
	created(t, fake, 1)
	say(t, c, jobComplete, "job-1", "mark", nil)
	if got := followedWithin(t, followed, time.Second); !slices.Equal(got.kinds, []string{"created job-1", "complete"}) {
		t.Fatalf("the follower gave %v", got.kinds)
	}
	if _, err := read.Wait(context.Background()); err == nil {
		t.Fatal("a delegation ranged over is waited for too")
	}
	for _, err := range read.Events(context.Background()) {
		if err == nil {
			t.Fatal("a delegation ranged over is ranged over again")
		}
	}

	fake.Queued[jobCreate] = []json.RawMessage{json.RawMessage(`{"response":{"jobId":"job-1"}}`)}
	awaited := highlighting(t, c)
	waited := waiting(awaited)
	created(t, fake, 2)
	for _, err := range awaited.Events(context.Background()) {
		if err == nil {
			t.Fatal("a delegation waited for is ranged over too")
		}
	}
	say(t, c, jobComplete, "job-1", "mark", nil)
	if got := waitedWithin(t, waited, time.Second); got.err != nil {
		t.Fatal(got.err)
	}
	// Each was one job, created once.
	if n := len(requestsOn(fake, jobCreate)); n != 2 {
		t.Fatalf("two delegations created %d jobs", n)
	}
}

func TestNothingIsSentUntilADelegationIsWaitedForOrRangedOver(t *testing.T) {
	t.Parallel()
	c, fake := jobWorld(t, true, semiont.DefaultTiming())
	highlighting(t, c)
	time.Sleep(50 * time.Millisecond)
	if emits, requests := fake.Sent(); len(emits)+len(requests) != 0 {
		t.Fatalf("a delegation nobody consumed sent %d frames", len(emits)+len(requests))
	}
}

func TestFramesThatArriveBeforeTheJobsIdIsKnownAreKeptAndHandledInTheOrderTheyCame(t *testing.T) {
	t.Parallel()
	c, fake := jobWorld(t, false, semiont.DefaultTiming())
	followed := following(highlighting(t, c).Events(context.Background()))
	request := created(t, fake, 1)
	say(t, c, jobProgress, "job-1", "mark", progressOf(10))
	say(t, c, jobProgress, "job-2", "mark", progressOf(99))
	say(t, c, jobComplete, "job-1", "mark", nil)
	time.Sleep(50 * time.Millisecond)
	select {
	case got := <-followed:
		t.Fatalf("the follower ended before its job was named: %v", got.kinds)
	default:
	}
	fake.Deliver(semiont.Frame{Channel: bus.JobCreate.Result().Channel(), Envelope: semiont.Envelope{CorrelationID: request.CorrelationID}, Payload: json.RawMessage(`{"response":{"jobId":"job-1"}}`)})
	if got := followedWithin(t, followed, time.Second); !slices.Equal(got.kinds, []string{"created job-1", "progress 10", "complete"}) {
		t.Fatalf("the follower gave %v", got.kinds)
	}
}

func TestASilentJobIsAskedForItsStatusUntilItsStatusIsAnEnd(t *testing.T) {
	t.Parallel()
	silence, poll := 200*time.Millisecond, 300*time.Millisecond
	c, fake := jobWorld(t, true, jobTiming(silence, poll))
	fake.Queued[jobStatus] = []json.RawMessage{statusOf(t, "running", nil), statusOf(t, "complete", nil)}
	followed := following(highlighting(t, c).Events(context.Background()))
	created(t, fake, 1)
	time.Sleep(silence / 2)
	if asked := requestsOn(fake, jobStatus); len(asked) != 0 {
		t.Fatalf("a job asked for its status before its silence: %d times", len(asked))
	}
	waitUntil(t, "the first status ask", time.Second, func() bool { return len(requestsOn(fake, jobStatus)) >= 1 })
	first := time.Now()
	if asked := requestsOn(fake, jobStatus)[0]; !reflect.DeepEqual(normal(t, asked.Payload), map[string]any{"jobId": "job-1"}) {
		t.Fatalf("the status ask sent %v", normal(t, asked.Payload))
	}
	got := followedWithin(t, followed, 2*time.Second)
	// The second ask comes a poll after the first, and not before.
	if since := time.Since(first); since < poll/2 {
		t.Fatalf("the second status ask came %s after the first, before its poll of %s", since, poll)
	}
	if !slices.Equal(got.kinds, []string{"created job-1", "complete"}) {
		t.Fatalf("the follower gave %v", got.kinds)
	}
	if asked := requestsOn(fake, jobStatus); len(asked) != 2 {
		t.Fatalf("the status was asked for %d times, want 2", len(asked))
	}
	// What the stream did not carry, from the status: which says what the job was, and the follower knows what it was about.
	done, ok := got.seen[1].(semiont.JobCompleted[api.MarkJobCompleteCommand])
	if !ok || done.Data.JobId.String() != "job-1" || done.Data.ResourceId.String() != "res-1" || done.Data.JobType != api.MarkJobCompleteCommandJobTypeMark || done.Data.Result != nil {
		t.Fatalf("the completion learned from the status is %+v", got.seen[1])
	}
}

func TestAStatusCarriesTheResultItsJobWasStoredWithAndAnEmptyOneIsNone(t *testing.T) {
	t.Parallel()
	for name, c := range map[string]struct {
		result map[string]any
		reads  bool
	}{
		"stored": {map[string]any{"found": 3, "persisted": 2}, true},
		"empty":  {map[string]any{}, false},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			client, fake := jobWorld(t, true, jobTiming(50*time.Millisecond, 50*time.Millisecond))
			fake.Queued[jobStatus] = []json.RawMessage{statusOf(t, "complete", map[string]any{"result": c.result})}
			got := followedWithin(t, following(highlighting(t, client).Events(context.Background())), 2*time.Second)
			if !slices.Equal(got.kinds, []string{"created job-1", "complete"}) {
				t.Fatalf("the follower gave %v", got.kinds)
			}
			done := got.seen[1].(semiont.JobCompleted[api.MarkJobCompleteCommand])
			if (done.Data.Result != nil) != c.reads {
				t.Fatalf("the completion's result is %v, want one: %v", done.Data.Result, c.reads)
			}
			if c.reads {
				if counts, err := done.Data.Result.AsMarkJobDone(); err != nil || counts.Found != 3 || counts.Persisted != 2 {
					t.Fatalf("the result reads as %+v (%v)", counts, err)
				}
			}
		})
	}
}

func TestACompletionHeardThatIsAnotherVerbsEndsTheFollowerAndIsNoFailureOfTheJob(t *testing.T) {
	t.Parallel()
	c, fake := jobWorld(t, true, semiont.DefaultTiming())
	waited := waiting(highlighting(t, c))
	created(t, fake, 1)
	var made map[string]any
	if err := json.Unmarshal([]byte(generated), &made); err != nil {
		t.Fatal(err)
	}
	// The job that was delegated is a mark job, and this says a yield job completed.
	say(t, c, jobComplete, "job-1", "yield", map[string]any{"result": made})
	got := waitedWithin(t, waited, time.Second)
	var ended *semiont.TransportError
	if !errors.As(got.err, &ended) || ended.Code != semiont.TransportErrorCodeError || !strings.Contains(ended.Message, "is a yield job's, and the job delegated is a mark job") {
		t.Fatalf("the follower ended with %v", got.err)
	}
	var failed *semiont.JobError
	if errors.As(got.err, &failed) {
		t.Fatal("an answer that is not the protocol's is said to be the job's failure")
	}
	if asked := requestsOn(fake, jobCancel); len(asked) != 0 {
		t.Fatalf("its cancellation was asked for %d times", len(asked))
	}
}

func TestAStatusWhoseCompletionIsNotTheVerbsEndsTheFollowerAndIsNoFailureOfTheJob(t *testing.T) {
	t.Parallel()
	var made map[string]any
	if err := json.Unmarshal([]byte(generated), &made); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		name      string
		delegated api.JobType
		said      map[string]any
	}{
		{"a mark job, and the status is a yield job's", api.JobTypeMark, map[string]any{"type": "yield"}},
		{"a mark job, and the status is a yield job's with its result", api.JobTypeMark, map[string]any{"type": "yield", "result": made}},
		{"a mark job, and the result is a generation's", api.JobTypeMark, map[string]any{"result": made}},
		{"a yield job, and the status is a mark job's", api.JobTypeYield, map[string]any{"type": "mark"}},
		{"a yield job, and the result is a mark job's counts", api.JobTypeYield, map[string]any{"type": "yield", "result": map[string]any{"found": 3, "persisted": 2}}},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			client, fake := jobWorld(t, true, jobTiming(50*time.Millisecond, 50*time.Millisecond))
			fake.Queued[jobStatus] = []json.RawMessage{statusOf(t, "complete", c.said)}
			var events iter.Seq2[semiont.JobEvent, error]
			if c.delegated == api.JobTypeMark {
				events = highlighting(t, client).Events(context.Background())
			} else {
				events = generation(t, client, 0, nil).Events(context.Background())
			}
			// What the knowledge base answered is not the protocol's: no completion is made of it, and the job is not said to have failed.
			if got := followedWithin(t, following(events), 2*time.Second); !slices.Equal(got.kinds, []string{"created job-1", "error error"}) {
				t.Fatalf("the follower gave %v", got.kinds)
			}
		})
	}
}

func TestAStatusWhoseCompletionIsNotTheVerbsIsToldAsWhatItIs(t *testing.T) {
	t.Parallel()
	const carried = "words-of-what-the-job-made"
	c, fake := jobWorld(t, true, jobTiming(50*time.Millisecond, 50*time.Millisecond))
	fake.Queued[jobStatus] = []json.RawMessage{statusOf(t, "complete", map[string]any{"result": map[string]any{"resourceId": "res-summary", "resourceName": carried, "truncated": false}})}
	got := waitedWithin(t, waiting(highlighting(t, c)), 2*time.Second)
	var ended *semiont.TransportError
	if !errors.As(got.err, &ended) || ended.Code != semiont.TransportErrorCodeError {
		t.Fatalf("the follower ended with %v", got.err)
	}
	// It is said by what it lacks, and in none of the words of what the job made.
	if ended.Message != "The status of job job-1 is not a completed mark job's: its `result` is malformed" {
		t.Fatalf("it is told as %q", ended.Message)
	}
	if strings.Contains(ended.Message, carried) {
		t.Fatal("it is told in the words of what the job made")
	}
}

func TestEveryFrameOfTheJobStartsTheSilenceAgain(t *testing.T) {
	t.Parallel()
	silence := 300 * time.Millisecond
	c, fake := jobWorld(t, true, jobTiming(silence, silence))
	followed := following(highlighting(t, c).Events(context.Background()))
	created(t, fake, 1)
	time.Sleep(200 * time.Millisecond)
	say(t, c, jobProgress, "job-1", "mark", progressOf(10))
	time.Sleep(200 * time.Millisecond)
	if asked := requestsOn(fake, jobStatus); len(asked) != 0 {
		t.Fatalf("a job heard from %s ago was asked for its status", 200*time.Millisecond)
	}
	waitUntil(t, "the first status ask", time.Second, func() bool { return len(requestsOn(fake, jobStatus)) >= 1 })
	// A status that could not be had is asked for again at the next poll.
	waitUntil(t, "the second status ask", time.Second, func() bool { return len(requestsOn(fake, jobStatus)) >= 2 })
	select {
	case got := <-followed:
		t.Fatalf("the follower ended on a status it could not have: %v", got.kinds)
	default:
	}
	c.Close()
	if got := followedWithin(t, followed, time.Second); !slices.Equal(got.kinds, []string{"created job-1", "progress 10", "error bus.closed"}) {
		t.Fatalf("the follower gave %v", got.kinds)
	}
}

func TestAStatusThatIsAnEndAndNoCompletionEndsTheFollowerWithIt(t *testing.T) {
	t.Parallel()
	for _, c := range []struct {
		name, of string
		more     map[string]any
		code     semiont.JobErrorCode
		message  string
	}{
		{"failed", "failed", map[string]any{"error": "the worker gave up"}, semiont.JobErrorCodeFailed, "the worker gave up"},
		{"failed, with no word why", "failed", nil, semiont.JobErrorCodeFailed, "Job failed"},
		// Nothing announces a cancellation: this is where its follower learns of one.
		{"cancelled", "cancelled", nil, semiont.JobErrorCodeCancelled, "The job was cancelled"},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			client, fake := jobWorld(t, true, jobTiming(50*time.Millisecond, 50*time.Millisecond))
			fake.Queued[jobStatus] = []json.RawMessage{statusOf(t, c.of, c.more)}
			got := waitedWithin(t, waiting(highlighting(t, client)), 2*time.Second)
			var ended *semiont.JobError
			if !errors.As(got.err, &ended) || ended.Code != c.code || ended.Message != c.message || ended.JobID.String() != "job-1" {
				t.Fatalf("the follower ended with %v", got.err)
			}
		})
	}
}

func TestAFailureTheQueueWillRetryIsReportedAndFollowedPast(t *testing.T) {
	t.Parallel()
	silence := 100 * time.Millisecond
	c, fake := jobWorld(t, true, jobTiming(silence, silence))
	followed := following(highlighting(t, c).Events(context.Background()))
	created(t, fake, 1)
	say(t, c, jobFail, "job-1", "mark", map[string]any{"error": "a blip", "willRetry": true})
	// The attempt that died is not asked about, however long the next takes.
	time.Sleep(3*silence + 50*time.Millisecond)
	if asked := requestsOn(fake, jobStatus); len(asked) != 0 {
		t.Fatalf("the attempt that died was asked about %d times", len(asked))
	}
	say(t, c, jobProgress, "job-1", "mark", progressOf(60))
	say(t, c, jobComplete, "job-1", "mark", nil)
	got := followedWithin(t, followed, time.Second)
	if !slices.Equal(got.kinds, []string{"created job-1", "failed", "progress 60", "complete"}) {
		t.Fatalf("the follower gave %v", got.kinds)
	}
	if setback, ok := got.seen[1].(semiont.JobAttemptFailed); !ok || setback.Data.Error != "a blip" {
		t.Fatalf("the setback is %+v", got.seen[1])
	}
}

func TestAFailureThatIsFinalEndsTheFollowerAndOneThatDoesNotSayIsFinal(t *testing.T) {
	t.Parallel()
	for name, said := range map[string]map[string]any{
		"it says it will not be tried again": {"willRetry": false},
		"it does not say":                    {},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			c, fake := jobWorld(t, true, semiont.DefaultTiming())
			waited := waiting(highlighting(t, c))
			created(t, fake, 1)
			failure := map[string]any{"error": "the budget is spent"}
			for name, value := range said {
				failure[name] = value
			}
			say(t, c, jobFail, "job-1", "mark", failure)
			got := waitedWithin(t, waited, time.Second)
			var ended *semiont.JobError
			if !errors.As(got.err, &ended) || ended.Code != semiont.JobErrorCodeFailed || ended.Message != "the budget is spent" || ended.JobID.String() != "job-1" {
				t.Fatalf("the follower ended with %v", got.err)
			}
		})
	}
}

func TestAnOptionOfAJobGivenAsNothingIsNotSent(t *testing.T) {
	t.Parallel()
	c, fake := jobWorld(t, true, semiont.DefaultTiming())
	fake.Queued[jobCreate] = append(fake.Queued[jobCreate], json.RawMessage(`{"response":{"jobId":"job-2"}}`))
	var params api.MarkJobParams
	density := float32(1.5)
	if err := params.FromCommentingJobParams(api.CommentingJobParams{Motivation: api.CommentingJobParamsMotivationCommenting, Density: &density}); err != nil {
		t.Fatal(err)
	}
	commenting := waiting(c.Mark.Delegate(resourceOf(t, "res-1"), params))
	created(t, fake, 1)
	// What the context holds deeper is sent as it came: a null that came is a null that goes.
	came := `{"focus":{"kind":"resource","resource":{"@context":"https://schema.org","@id":"res-1","name":"A resource","description":null,"representations":[]}},"graph":{"nodes":[],"edges":[]},"metadata":{}}`
	var asked api.GenerationJobParams
	if err := json.Unmarshal([]byte(`{"title":"A summary","storageUri":"file://a-summary.md","context":`+came+`}`), &asked); err != nil {
		t.Fatal(err)
	}
	generating := waiting(c.Yield.Delegate(asked, 0))
	created(t, fake, 2)
	var cameAs map[string]any
	if err := json.Unmarshal([]byte(came), &cameAs); err != nil {
		t.Fatal(err)
	}
	var sent []any
	for _, request := range requestsOn(fake, jobCreate) {
		sent = append(sent, normal(t, request.Payload))
	}
	want := []any{
		map[string]any{"jobType": "mark", "resourceId": "res-1", "params": map[string]any{"motivation": "commenting", "density": 1.5}},
		map[string]any{"jobType": "yield", "params": map[string]any{"title": "A summary", "storageUri": "file://a-summary.md", "context": cameAs}},
	}
	if !reflect.DeepEqual(sent, want) {
		t.Fatalf("job:create sent\n %v\nwant\n %v", sent, want)
	}
	say(t, c, jobComplete, "job-1", "mark", nil)
	say(t, c, jobComplete, "job-2", "yield", nil)
	if got := waitedWithin(t, commenting, time.Second); got.err != nil {
		t.Fatal(got.err)
	}
	if got := waitedWithin(t, generating, time.Second); got.err != nil {
		t.Fatal(got.err)
	}
}

func TestAJobWhoseCreationIsRefusedIsItsFollowersFailure(t *testing.T) {
	t.Parallel()
	c, fake := jobWorld(t, true, semiont.DefaultTiming())
	fake.Rejections[jobCreate] = json.RawMessage(`{"message":"the queue refused it"}`)
	got := waitedWithin(t, waiting(highlighting(t, c)), time.Second)
	var refused *semiont.BusRequestError
	if !errors.As(got.err, &refused) || refused.Code != semiont.BusRequestErrorCodeRejected {
		t.Fatalf("the follower ended with %v", got.err)
	}
}

// Go's decoding refuses no member that is missing, so a job:created naming no
// job is refused by the follower, where it would otherwise wait for a job it
// can never recognise.
func TestACreationThatNamesNoJobIsItsFollowersFailure(t *testing.T) {
	t.Parallel()
	c, fake := jobWorld(t, true, semiont.DefaultTiming())
	fake.Queued[jobCreate] = []json.RawMessage{json.RawMessage(`{"response":{}}`)}
	got := waitedWithin(t, waiting(highlighting(t, c)), time.Second)
	var ended *semiont.TransportError
	if !errors.As(got.err, &ended) || ended.Code != semiont.TransportErrorCodeError || !strings.Contains(ended.Message, "response.jobId") {
		t.Fatalf("the follower ended with %v", got.err)
	}
}

// A frame that is not its channel's is nobody's to act on: one that lacks a
// member its schema requires, and a completion whose result is not its
// verb's.
func TestAFrameThatIsNotItsChannelsIsNobodysToActOn(t *testing.T) {
	t.Parallel()
	c, fake := jobWorld(t, true, semiont.DefaultTiming())
	followed := following(highlighting(t, c).Events(context.Background()))
	created(t, fake, 1)
	var made map[string]any
	if err := json.Unmarshal([]byte(generated), &made); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(map[string]any{"jobId": "job-1", "jobType": "mark"})
	if err != nil {
		t.Fatal(err)
	}
	// A completion with no resource, and one whose result is a generation's.
	c.Bus.Deliver(semiont.Frame{Channel: jobComplete, Payload: encoded})
	say(t, c, jobComplete, "job-1", "mark", map[string]any{"result": made})
	say(t, c, jobComplete, "job-1", "mark", map[string]any{"result": map[string]any{"found": 1, "persisted": 1}})
	got := followedWithin(t, followed, time.Second)
	if !slices.Equal(got.kinds, []string{"created job-1", "complete"}) {
		t.Fatalf("the follower gave %v", got.kinds)
	}
	done := got.seen[1].(semiont.JobCompleted[api.MarkJobCompleteCommand])
	if counts, err := done.Data.Result.AsMarkJobDone(); err != nil || counts.Found != 1 {
		t.Fatalf("the completion followed is %+v (%v)", counts, err)
	}
}

// ── A generation, which may stall ───────────────────────────────────────

func TestAGenerationThatSaysNothingIsCancelledAndGivenUpOn(t *testing.T) {
	t.Parallel()
	c, fake := jobWorld(t, true, jobTiming(50*time.Millisecond, 50*time.Millisecond))
	// Its status says it is running for as long as it is asked: only the deadline ends it.
	fake.Queued[jobStatus] = statuses(statusOf(t, "running", nil), 100)
	stall := 600 * time.Millisecond
	waited := waiting(generation(t, c, stall, nil))
	sent := created(t, fake, 1)
	var members []string
	for name := range sent.Payload {
		members = append(members, name)
	}
	sort.Strings(members)
	if !slices.Equal(members, []string{"jobType", "params"}) {
		t.Fatalf("job:create sent %v", members)
	}
	time.Sleep(stall / 2)
	select {
	case got := <-waited:
		t.Fatalf("the generation was given up on before its deadline: %v", got.err)
	default:
	}
	if asked := requestsOn(fake, jobCancel); len(asked) != 0 {
		t.Fatalf("its cancellation was asked for before its deadline")
	}
	got := waitedWithin(t, waited, 2*time.Second)
	var ended *semiont.JobError
	if !errors.As(got.err, &ended) || ended.Code != semiont.JobErrorCodeStalled || ended.JobID.String() != "job-1" {
		t.Fatalf("the follower ended with %v", got.err)
	}
	if ended.Message != "The job stalled: nothing was heard of it within 600ms" {
		t.Fatalf("the stall is told as %q", ended.Message)
	}
	waitUntil(t, "the cancellation", time.Second, func() bool { return len(requestsOn(fake, jobCancel)) == 1 })
	if asked := requestsOn(fake, jobCancel)[0]; !reflect.DeepEqual(normal(t, asked.Payload), map[string]any{"jobId": "job-1"}) {
		t.Fatalf("the cancellation sent %v", normal(t, asked.Payload))
	}
}

func TestAGenerationThatStallsBeforeItsJobIsKnownHasNothingToCancel(t *testing.T) {
	t.Parallel()
	c, fake := jobWorld(t, false, semiont.DefaultTiming())
	got := waitedWithin(t, waiting(generation(t, c, 200*time.Millisecond, nil)), 2*time.Second)
	var ended *semiont.JobError
	if !errors.As(got.err, &ended) || ended.Code != semiont.JobErrorCodeStalled || !ended.JobID.IsZero() {
		t.Fatalf("the follower ended with %v", got.err)
	}
	time.Sleep(50 * time.Millisecond)
	if asked := requestsOn(fake, jobCancel); len(asked) != 0 {
		t.Fatalf("a job nobody named was asked to be cancelled")
	}
}

func TestWhatAGenerationSaysStartsItsStallDeadlineAgainAndASetbackIsFollowedPast(t *testing.T) {
	t.Parallel()
	c, fake := jobWorld(t, true, semiont.DefaultTiming())
	stall, step := 600*time.Millisecond, 350*time.Millisecond
	followed := following(generation(t, c, stall, nil).Events(context.Background()))
	created(t, fake, 1)
	time.Sleep(step)
	say(t, c, jobProgress, "job-1", "yield", progressOf(10))
	time.Sleep(step)
	// The setback was heard: a deadline left running would cancel the attempt that is coming.
	say(t, c, jobFail, "job-1", "yield", map[string]any{"error": "a blip", "willRetry": true})
	time.Sleep(step)
	select {
	case got := <-followed:
		t.Fatalf("the generation ended while it was heard from: %v", got.kinds)
	default:
	}
	if asked := requestsOn(fake, jobCancel); len(asked) != 0 {
		t.Fatal("a generation heard from was asked to be cancelled")
	}
	say(t, c, jobComplete, "job-1", "yield", nil)
	if got := followedWithin(t, followed, time.Second); !slices.Equal(got.kinds, []string{"created job-1", "progress 10", "failed", "complete"}) {
		t.Fatalf("the follower gave %v", got.kinds)
	}
	time.Sleep(stall + 100*time.Millisecond)
	if asked := requestsOn(fake, jobCancel); len(asked) != 0 {
		t.Fatal("a generation that completed was asked to be cancelled")
	}
}

func TestAGenerationWaitsAsLongAsItsLengthAllowsWhenNoDeadlineIsStated(t *testing.T) {
	t.Parallel()
	timing := jobTiming(50*time.Millisecond, 50*time.Millisecond)
	timing.GenerationStallFloor, timing.GenerationStallPerToken = 100*time.Millisecond, time.Millisecond
	c, fake := jobWorld(t, true, timing)
	fake.Queued[jobStatus] = statuses(statusOf(t, "running", nil), 100)
	tokens := float32(400)
	waited := waiting(generation(t, c, 0, &tokens))
	created(t, fake, 1)
	time.Sleep(200 * time.Millisecond)
	select {
	case got := <-waited:
		t.Fatalf("the generation was given up on before its length allowed: %v", got.err)
	default:
	}
	got := waitedWithin(t, waited, 2*time.Second)
	var ended *semiont.JobError
	if !errors.As(got.err, &ended) || ended.Code != semiont.JobErrorCodeStalled || ended.Message != "The job stalled: nothing was heard of it within 400ms" {
		t.Fatalf("the follower ended with %v", got.err)
	}
}

// ── A client's waits, and its end ───────────────────────────────────────

func TestAClientToldOtherWaitsKeepsThem(t *testing.T) {
	t.Parallel()
	c, fake := jobWorld(t, true, jobTiming(50*time.Millisecond, 20*time.Millisecond))
	fake.Queued[jobStatus] = []json.RawMessage{statusOf(t, "complete", nil)}
	// No clock is moved: a twentieth of a second is waited out.
	got := waitedWithin(t, waiting(highlighting(t, c)), time.Second)
	if got.err != nil || got.done.JobId.String() != "job-1" || got.done.Result != nil {
		t.Fatalf("the completion is %+v (%v)", got.done, got.err)
	}
}

func TestAClientThatClosesEndsTheJobsItWasFollowing(t *testing.T) {
	t.Parallel()
	c, fake := jobWorld(t, true, semiont.DefaultTiming())
	fake.Queued[jobCreate] = append(fake.Queued[jobCreate], json.RawMessage(`{"response":{"jobId":"job-2"}}`))
	followed := following(highlighting(t, c).Events(context.Background()))
	created(t, fake, 1)
	waited := waiting(highlighting(t, c))
	created(t, fake, 2)
	// Its follower has named the first job by the time the client closes.
	time.Sleep(100 * time.Millisecond)
	c.Close()
	if got := followedWithin(t, followed, time.Second); !slices.Equal(got.kinds, []string{"created job-1", "error bus.closed"}) {
		t.Fatalf("the follower gave %v", got.kinds)
	}
	got := waitedWithin(t, waited, time.Second)
	var closed *semiont.BusRequestError
	if !errors.As(got.err, &closed) || closed.Code != semiont.BusRequestErrorCodeClosed {
		t.Fatalf("the wait ended with %v", got.err)
	}
}
