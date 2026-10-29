package semiont

// Job: a job's lifecycle as it is announced, its status, its cancellation,
// and, for a worker, the claiming of jobs. Creating a job is Mark.Delegate
// and Yield.Delegate.

import (
	"context"
	"fmt"
	"iter"
	"time"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
)

// JobNamespace is jobs: their lifecycle, their status, their cancellation,
// and a worker's claiming of them.
type JobNamespace struct {
	links *links
}

// Queued is every job:queued from now on, until ctx is done: each a mark job's announcement or
// a yield job's, as its jobType says.
func (n *JobNamespace) Queued(ctx context.Context) iter.Seq2[Delivered[api.JobQueuedEvent], error] {
	return Published(ctx, n.links.own, bus.JobQueued)
}

// Progress is every job:report-progress from now on, of every job, until
// ctx is done.
func (n *JobNamespace) Progress(ctx context.Context) iter.Seq2[Delivered[api.JobReportProgressCommand], error] {
	return Published(ctx, n.links.own, bus.JobReportProgress)
}

// Complete is every job:complete from now on, of every job, until ctx is
// done: each a mark
// job's completion or a yield job's, as its jobType says.
func (n *JobNamespace) Complete(ctx context.Context) iter.Seq2[Delivered[api.JobCompleteCommand], error] {
	return Published(ctx, n.links.own, bus.JobComplete)
}

// Fail is every job:fail from now on, of every job, until ctx is done.
func (n *JobNamespace) Fail(ctx context.Context) iter.Seq2[Delivered[api.JobFailCommand], error] {
	return Published(ctx, n.links.own, bus.JobFail)
}

// Status is a job's status, as the queue holds it.
func (n *JobNamespace) Status(ctx context.Context, jobID api.JobId) (api.JobStatusResponse, error) {
	status, err := ask(ctx, n.links, bus.JobStatusRequested, api.JobStatusRequest{JobId: jobID})
	return status.Response, err
}

// PollUntilComplete asks for a job's status every every until it has ended,
// giving each answer to onStatus when it is not nil. It gives the status the
// job ended with. One that has not ended within within fails as a timeout.
func (n *JobNamespace) PollUntilComplete(ctx context.Context, jobID api.JobId, every, within time.Duration, onStatus func(api.JobStatusResponse)) (api.JobStatusResponse, error) {
	deadline := time.Now().Add(within)
	for {
		status, err := n.Status(ctx, jobID)
		if err != nil {
			return status, err
		}
		if onStatus != nil {
			onStatus(status)
		}
		switch status.Status {
		case api.JobStatusResponseStatusComplete, api.JobStatusResponseStatusFailed, api.JobStatusResponseStatusCancelled:
			return status, nil
		}
		if time.Now().After(deadline) {
			return status, &BusRequestError{Code: BusRequestErrorCodeTimeout, Message: fmt.Sprintf("Job polling timeout after %dms", within.Milliseconds())}
		}
		select {
		case <-ctx.Done():
			return status, ctx.Err()
		case <-time.After(every):
		}
	}
}

// Cancel cancels one job: whether the queue acted on it. A pending job is
// cancelled outright. A running one is left to its worker, so true means
// accepted, not stopped. False is a job the queue does not know, or one
// already over.
func (n *JobNamespace) Cancel(ctx context.Context, jobID api.JobId) (bool, error) {
	answer, err := ask(ctx, n.links, bus.JobCancelRequested, api.JobCancelRequest{JobId: jobID})
	return answer.Response.Cancelled, err
}

// Claim is a worker's side: claim the jobs accepts describes, and hold one at
// a time. Claiming begins when the claims are first ranged over, and each job
// they hand out says its own lifecycle, commits its own annotations and
// settles once (docs/protocol/WORKER-CONTRACT.md). The transport's stream
// must name JobClaimChannels, and JobCommitChannels for a worker that
// commits. The waits are the client's Timing: JobClaimTimeout, HeldJobStall,
// HeldJobStallCheck and MarkCommitTimeout.
func (n *JobNamespace) Claim(accepts []api.JobFilter) *Claims {
	return newClaims(n.links, accepts)
}
