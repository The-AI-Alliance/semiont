package verbs

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/harness"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/semionttest"
)

// `semiont yield --delegate`, in process against the faulty transport: it
// gathers the context, creates a yield job from it, and follows the job to
// its end. The upload form sends bytes over the gateway's HTTP content route,
// which the transport seam does not carry: it stays end-to-end, in
// launcher_test.go.

// gatheredSource is what the gateway gathers for res-src.
var gatheredSource = json.RawMessage(`{"metadata":{},"focus":{"kind":"resource","resource":{"@context":"https://schema.org/","@id":"res-src","name":"Source","representations":[]}},"graph":{"nodes":[],"edges":[]}}`)

var (
	gathering = bus.GatherResourceRequested.Request().Channel()
	creating  = bus.JobCreate.Request().Channel()
)

// delegated runs yield --delegate res-src with more args against fake, which
// gathers res-src's context and creates job-1. Once the job is created, the
// job's end is delivered. It gives the exit code and everything printed.
func delegated(t *testing.T, fake *semionttest.FaultyTransport, end semiont.Frame, more ...string) (int, string) {
	t.Helper()
	fake.QueueReply(gathering, gatheredSource)
	fake.QueueReply(creating, json.RawMessage(`{"jobId":"job-1"}`))
	args := append([]string{"--delegate", "res-src", "--storage-uri", "file://generated/out.md", "--title", "Derived"}, more...)
	var code int
	created, ended := false, false
	out, errOut := harness.CaptureOutput(t, func() {
		done := make(chan int, 1)
		go func() { done <- Yield(args) }()
		// The job's events are followed from before it is created, so its end is heard however soon it comes.
		if created = within(func() bool { return len(requestsOf(fake, creating)) > 0 }); !created {
			return
		}
		fake.Deliver(end)
		select {
		case code = <-done:
			ended = true
		case <-time.After(5 * time.Second):
		}
	})
	if !created || !ended {
		t.Fatalf("yield --delegate created its job: %v; ended with it: %v\n%s%s", created, ended, out, errOut)
	}
	return code, out + errOut
}

// requestsOf is every request a verb sent on channel, in order.
func requestsOf(fake *semionttest.FaultyTransport, channel bus.Channel) []semionttest.RequestLogEntry {
	var on []semionttest.RequestLogEntry
	for _, request := range fake.RequestLog() {
		if request.Channel == channel {
			on = append(on, request)
		}
	}
	return on
}

// jobEnd is a frame of job-1's lifecycle, a yield job's on res-src.
func jobEnd(t *testing.T, channel bus.Channel, more map[string]any) semiont.Frame {
	t.Helper()
	payload := map[string]any{"resourceId": "res-src", "jobId": "job-1", "jobType": "yield"}
	for name, value := range more {
		payload[name] = value
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return semiont.Frame{Channel: channel, Payload: encoded}
}

func TestYieldDelegateGathersCreatesAndFollowsItsJobInProcess(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	completed := jobEnd(t, bus.JobComplete.Channel(), map[string]any{"result": map[string]any{"resourceId": "res-new", "resourceName": "Derived", "truncated": false}})

	code, out := delegated(t, fake, completed, "--task", "summary")
	if code != 0 {
		t.Fatalf("exit %d\n%s", code, out)
	}
	harness.MustContainAll(t, "output", out, "Generating", "Yielded", "res-new", "Derived")

	// The gather names its traversal: with none, the librarian would be asked for no resources at all.
	gathers := requestsOf(fake, gathering)
	if len(gathers) != 1 {
		t.Fatalf("gathered %d times, want once", len(gathers))
	}
	harness.MustContainAll(t, "gather", string(gathers[0].Payload), `"resourceId":"res-src"`, `"depth":2`, `"maxResources":10`, `"includeContent":true`, `"includeSummary":true`)

	// The job is a yield job: what it is asked to make, and the context it is made from.
	creates := requestsOf(fake, creating)
	if len(creates) != 1 {
		t.Fatalf("created %d jobs, want one", len(creates))
	}
	asked := string(creates[0].Payload)
	harness.MustContainAll(t, "job:create", asked, `"jobType":"yield"`, `"storageUri":"file://generated/out.md"`, `"title":"Derived"`, `"task":"summary"`, `"context"`, `"@id":"res-src"`)
	// The dispatcher derives the job's resource from its context's focus: the command names none.
	var command map[string]json.RawMessage
	if err := json.Unmarshal(creates[0].Payload, &command); err != nil {
		t.Fatal(err)
	}
	for _, gone := range []string{"resourceId", "referenceId"} {
		if _, carried := command[gone]; carried {
			t.Errorf("job:create carries %s; the context's focus is what names the resource:\n%s", gone, asked)
		}
	}
}

// A decline completes the job and makes nothing: no resource is at the
// storage URI, so the command fails, saying why.
func TestYieldDelegateReportsADeclineInProcess(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	declined := jobEnd(t, bus.JobComplete.Channel(), map[string]any{"result": map[string]any{"declined": true, "reason": "encrypted"}})

	code, out := delegated(t, fake, declined)
	if code == 0 {
		t.Fatalf("a declined job produced nothing, and the command succeeded\n%s", out)
	}
	harness.MustContainAll(t, "decline", out, "encrypted", "this PDF is password-protected")
	if strings.Contains(out, "Generation failed") {
		t.Errorf("a decline is not a failure:\n%s", out)
	}
}

// A job that fails for good fails the command, with the job's own words.
func TestYieldDelegateReportsAJobThatFailsInProcess(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	failed := jobEnd(t, bus.JobFail.Channel(), map[string]any{"error": "model refused"})

	code, out := delegated(t, fake, failed)
	if code == 0 {
		t.Fatalf("a failed job must fail the command\n%s", out)
	}
	harness.MustContainAll(t, "failure", out, "Generation failed", "model refused")
}
