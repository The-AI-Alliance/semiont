package verbs

// A delegated job's answer, through the one mapping job_status gives and
// tasks/get will (LAUNCHER-MCP §Delegated jobs as MCP Tasks), and a
// delegation whose call is cancelled.

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
)

// statusOf is job-1's status, as the dispatcher answers it, the fixture's
// signed-in person its requester, with more members.
func statusOf(t *testing.T, status string, more string) json.RawMessage {
	t.Helper()
	return json.RawMessage(`{"jobId":"job-1","type":"mark","status":"` + status + `","userId":"did:web:example.org:users:t","created":"2026-10-26T00:00:00Z"` + more + `}`)
}

func TestMCPJobStatusAnswersEachStateThroughTheOneMapping(t *testing.T) {
	for _, c := range []struct {
		name, status, more string
		want               map[string]any
		failed             string
	}{
		{"pending", "pending", ``, map[string]any{"status": "working"}, ""},
		{"running, with its last progress", "running", `,"progress":{"percentage":40,"message":{"code":"analyzing"}}`, map[string]any{"status": "working", "statusMessage": "Analyzing text"}, ""},
		{"complete, with its result", "complete", `,"result":{"found":3,"persisted":3}`, map[string]any{"status": "completed", "result": map[string]any{"found": 3, "persisted": 3}}, ""},
		{"cancelled", "cancelled", ``, map[string]any{"status": "cancelled"}, ""},
		{"failed, in the worker's words", "failed", `,"error":"the model refused"`, nil, "the model refused"},
	} {
		t.Run(c.name, func(t *testing.T) {
			cs, fake, _ := mcpFixture(t)
			fake.QueueReply(bus.JobStatusRequested.Request().Channel(), statusOf(t, c.status, c.more))
			result := callTool(t, cs, "job_status", map[string]any{"jobId": "job-1"})
			if c.failed != "" {
				// A job's failure is the tool's, never a protocol error.
				if !result.IsError || !strings.Contains(said(result), c.failed) {
					t.Fatalf("a failed job did not answer as the tool's error with the worker's words:\n%s", said(result))
				}
				return
			}
			if result.IsError {
				t.Fatalf("job_status refused:\n%s", said(result))
			}
			got := structured(t, result)
			if got["jobId"] != "job-1" {
				t.Errorf("jobId is %v", got["jobId"])
			}
			for name, want := range c.want {
				if written, wanted := jsonText(got[name]), jsonText(want); written != wanted {
					t.Errorf("%s is %s, want %s", name, written, wanted)
				}
			}
		})
	}
}

// A job that is another person's, and one the queue no longer keeps, are
// unknown, said alike: an id the caller was not given reveals nothing.
func TestMCPAJobThatIsNotTheCallersIsUnknown(t *testing.T) {
	t.Run("another person's", func(t *testing.T) {
		cs, fake, _ := mcpFixture(t)
		another := strings.Replace(string(statusOf(t, "running", ``)), "users:t", "users:someone-else", 1)
		fake.QueueReply(bus.JobStatusRequested.Request().Channel(), json.RawMessage(another), json.RawMessage(another))
		for _, tool := range []string{"job_status", "job_cancel"} {
			result := callTool(t, cs, tool, map[string]any{"jobId": "job-1"})
			if !result.IsError || !strings.Contains(said(result), "No job job-1 is known") {
				t.Errorf("%s answered another person's job:\n%s", tool, said(result))
			}
		}
		if cancels := requestsOf(fake, bus.JobCancelRequested.Request().Channel()); len(cancels) != 0 {
			t.Errorf("another person's job was cancelled")
		}
	})
	t.Run("one retention deleted", func(t *testing.T) {
		cs, fake, _ := mcpFixture(t)
		fake.RefuseWhen(refusing(bus.JobStatusRequested.Request().Channel(), `{"code":"not-found","message":"no job job-1"}`))
		result := callTool(t, cs, "job_status", map[string]any{"jobId": "job-1"})
		if !result.IsError || !strings.Contains(said(result), "No job job-1 is known") {
			t.Errorf("a job the queue no longer keeps was not unknown:\n%s", said(result))
		}
	})
}

// A delegation answers its job's completion; a cancelled call cancels its
// job.
func TestMCPADelegationAnswersItsCompletionAndACancelledCallCancelsItsJob(t *testing.T) {
	creating := bus.JobCreate.Request().Channel()
	params := map[string]any{"motivation": "highlighting"}

	t.Run("completed", func(t *testing.T) {
		cs, fake, _ := mcpFixture(t)
		fake.QueueReply(creating, json.RawMessage(`{"jobId":"job-1"}`))
		answered := make(chan *mcp.CallToolResult, 1)
		failed := make(chan error, 1)
		go func() {
			result, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "mark_delegate", Arguments: map[string]any{"resourceId": "res-1", "params": params}})
			if err != nil {
				failed <- err
				return
			}
			answered <- result
		}()
		if !within(func() bool { return len(requestsOf(fake, creating)) > 0 }) {
			t.Fatal("the job was never created")
		}
		fake.Deliver(markJobEnd(t, bus.JobComplete.Channel()))
		select {
		case err := <-failed:
			t.Fatalf("mark_delegate: a protocol error, where a tool answers its own: %v", err)
		case result := <-answered:
			if result.IsError {
				t.Fatalf("mark_delegate refused:\n%s", said(result))
			}
			if got := structured(t, result); got["jobId"] != "job-1" || got["resourceId"] != "res-1" {
				t.Errorf("the completion answered is %v", got)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("mark_delegate did not answer its job's completion")
		}
	})

	t.Run("cancelled", func(t *testing.T) {
		_, fake, _ := mcpFixture(t)
		heard := make(chan string, 16)
		cs := mcpClientWith(t, &mcp.ClientOptions{ProgressNotificationHandler: func(_ context.Context, request *mcp.ProgressNotificationClientRequest) {
			heard <- request.Params.Message
		}})
		fake.QueueReply(creating, json.RawMessage(`{"jobId":"job-1"}`))
		fake.QueueReply(bus.JobCancelRequested.Request().Channel(), json.RawMessage(`{"cancelled":true}`))
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		call := &mcp.CallToolParams{Name: "mark_delegate", Arguments: map[string]any{"resourceId": "res-1", "params": params}}
		call.SetProgressToken("delegation-1")
		go func() { _, _ = cs.CallTool(ctx, call) }()
		// The job is known by its id once its creation is answered, which the
		// call's progress says.
		select {
		case message := <-heard:
			if !strings.Contains(message, "job-1") {
				t.Fatalf("the first progress is %q, not the job's creation", message)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("no progress was heard of the job's creation")
		}
		cancel()
		cancelling := bus.JobCancelRequested.Request().Channel()
		if !within(func() bool { return len(requestsOf(fake, cancelling)) > 0 }) {
			t.Fatal("a cancelled call left its job running")
		}
		if payload := string(requestsOf(fake, cancelling)[0].Payload); !strings.Contains(payload, `"jobId":"job-1"`) {
			t.Errorf("the cancellation was not of job-1: %s", payload)
		}
	})
}

// markJobEnd is a frame of job-1's lifecycle, a mark job's on res-1.
func markJobEnd(t *testing.T, channel bus.Channel) semiont.Frame {
	t.Helper()
	written, err := json.Marshal(map[string]any{"resourceId": "res-1", "jobId": "job-1", "jobType": "mark"})
	if err != nil {
		t.Fatal(err)
	}
	return semiont.Frame{Channel: channel, Payload: written}
}
