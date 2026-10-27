package verbs

// mcp_jobs.go — a delegated job, as `semiont mcp` answers it. A delegating
// tool (mark_delegate, yield_generate) waits for its job, sending its
// progress as notifications when the client asked for them, and cancels the
// job when the call is cancelled. job_status reads one later; jobAnswer is
// how a job's status becomes an answer, the one mapping that job_status and,
// once the MCP library carries the Tasks extension, tasks/get both give
// (LAUNCHER-MCP §Delegated jobs as MCP Tasks).

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
)

// jobCancelWithin is how long a cancelled call waits for the queue to take
// its job's cancellation.
const jobCancelWithin = 10 * time.Second

// followDelegation follows job until it completes, and gives its completion.
// A job that fails, or one whose call is cancelled, is the tool's error; a
// cancelled call cancels its job, which the queue does cooperatively: a
// running job stops when its worker does.
func followDelegation[C any](ctx context.Context, call mcpCall, job *semiont.Delegation[C]) (C, error) {
	var done C
	c := call.client()
	following, stop := context.WithCancel(ctx)
	defer stop()
	defer context.AfterFunc(c.Context(), stop)()
	notify := progressNotifier(ctx, call)
	var jobID api.JobId
	for event, err := range job.Events(following) {
		if err != nil {
			var failed *semiont.JobError
			switch {
			case ctx.Err() != nil && !jobID.IsZero():
				asked, cancelled := context.WithTimeout(context.WithoutCancel(ctx), jobCancelWithin)
				_, cancelErr := c.Job.Cancel(asked, jobID)
				cancelled()
				if cancelErr != nil {
					return done, &mcpRefusal{fmt.Sprintf("The call was cancelled; cancelling its job %s failed: %v", jobID, cancelErr)}
				}
				return done, &mcpRefusal{fmt.Sprintf("The call was cancelled, and so was its job %s.", jobID)}
			case errors.As(err, &failed):
				return done, &mcpRefusal{fmt.Sprintf("Job %s failed: %s", failed.JobID, failed.Message)}
			}
			return done, err
		}
		switch e := event.(type) {
		case semiont.JobCreated:
			jobID = e.Data.JobId
			notify(fmt.Sprintf("Job %s created", jobID))
		case semiont.JobProgressed:
			if text := progressText(e.Data.Message); text != "" {
				notify(text)
			}
		case semiont.JobAttemptFailed:
			notify(fmt.Sprintf("An attempt failed (%s); the queue is running the job again", e.Data.Error))
		case semiont.JobCompleted[C]:
			return e.Data, nil
		}
	}
	return done, fmt.Errorf("job %s was no longer followed before it completed", jobID)
}

// progressNotifier sends a call's progress as notifications, when the
// client gave the call a progress token, and does nothing otherwise; ctx is
// the call's, which ties each notification to its request. Each
// notification is one step further on: a job states no total.
func progressNotifier(ctx context.Context, call mcpCall) func(said string) {
	token := call.request.Params.GetProgressToken()
	if token == nil {
		return func(string) {}
	}
	steps := 0.0
	return func(said string) {
		steps++
		err := call.request.Session.NotifyProgress(ctx, &mcp.ProgressNotificationParams{ProgressToken: token, Message: said, Progress: steps})
		if err != nil {
			fmt.Fprintf(os.Stderr, "semiont mcp: a progress notification was not sent: %v\n", err)
		}
	}
}

// callersJob is the status of the job jobID, when the person signed in to
// the call's knowledge base asked for it. A job that is another person's, or
// that the queue no longer keeps, is unknown: a server answering a job id it
// was not given reveals nothing about it.
func callersJob(ctx context.Context, call mcpCall, jobID api.JobId) (api.JobStatusResponse, error) {
	status, err := call.client().Job.Status(ctx, jobID)
	var failed *semiont.BusRequestError
	if errors.As(err, &failed) && failed.Code == semiont.BusRequestErrorCodeNotFound {
		return status, unknownJob(jobID)
	}
	if err != nil {
		return status, err
	}
	signee := call.session.User()
	if signee == nil || signee.Did != status.UserId {
		return status, unknownJob(jobID)
	}
	return status, nil
}

func unknownJob(jobID api.JobId) error {
	return &mcpRefusal{fmt.Sprintf("No job %s is known to this knowledge base.", jobID)}
}

// jobAnswer is a job's status as a tool answers it: working, with its last
// progress; completed, with its result; or cancelled. A job that failed is
// the tool's error, with the worker's words: a job's failure is the tool's,
// not the protocol's.
func jobAnswer(status api.JobStatusResponse) (mcpAnswer, error) {
	answer := map[string]any{"jobId": status.JobId}
	switch status.Status {
	case api.JobStatusResponseStatusPending, api.JobStatusResponseStatusRunning:
		answer["status"] = "working"
		said, err := storedProgressText(status.Progress)
		if err != nil {
			return mcpAnswer{}, fmt.Errorf("job %s's progress cannot be read: %w", status.JobId, err)
		}
		if said != "" {
			answer["statusMessage"] = said
		}
	case api.JobStatusResponseStatusComplete:
		answer["status"] = "completed"
		if status.Result != nil {
			answer["result"] = status.Result
		}
	case api.JobStatusResponseStatusCancelled:
		answer["status"] = "cancelled"
	case api.JobStatusResponseStatusFailed:
		said := fmt.Sprintf("Job %s failed.", status.JobId)
		if status.Error != nil {
			said = fmt.Sprintf("Job %s failed: %s", status.JobId, *status.Error)
		}
		return mcpAnswer{}, &mcpRefusal{said}
	default:
		return mcpAnswer{}, fmt.Errorf("job %s is in a state this launcher does not know: %q", status.JobId, status.Status)
	}
	return mcpAnswer{structured: answer}, nil
}

// storedProgressText is a job's last progress as the blocking form words it;
// "" when it has reported none.
func storedProgressText(progress *api.JobStoredProgress) (string, error) {
	if progress == nil {
		return "", nil
	}
	reported, err := progress.AsJobProgress()
	if err != nil {
		return "", err
	}
	return progressText(reported.Message), nil
}
