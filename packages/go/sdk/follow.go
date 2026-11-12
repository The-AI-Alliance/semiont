package semiont

// Following a job from its creation to its end (protocol/contract/JOBS.md §
// Following a job).
//
// A job's progress and its end reach the client that created it as passing
// frames: a stream that is down when one is published does not carry it
// later. So a follower that has heard nothing of its job for the client's
// JobSilence asks for the job's status, and asks again every JobStatusPoll
// until the job says something or its status is an end.
//
// The follower listens before it creates the job: a frame of the job can be
// read from the stream beside the reply that names it. Frames that arrive
// before the job's id is known are held, and the job's are then handled in
// the order they came. The reply itself is the follower's first event: it
// names the job, to Job.Cancel and to Job.Status.
//
// A failure the queue will retry is reported and followed past: the job is
// not over. A failure it will not retry ends the follower with job.failed. A
// follower given a stall deadline that hears nothing for that long asks for
// the cancellation and ends with job.stalled.
//
// A frame of the lifecycle the follower's reading refuses, its transport
// refusing it or its payload not being its channel's, names no job: it is
// reported as a JobRefused, held like the job's own frames until the job is
// named, and followed past. It is no word of the job, so it starts neither
// the silence nor the stall deadline again.
//
// A job completes as its verb's jobs do: a mark job with a
// MarkJobCompleteCommand, a yield job with a YieldJobCompleteCommand. The
// follower of a job is told which, and reads the completion as that one,
// whether it heard it or learned it from the job's status. A completion that
// is another verb's is not the job's failure: it is an answer that is not the
// protocol's, and ends the follower with a *TransportError.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"iter"
	"reflect"
	"time"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/internal/required"
)

// JobEvent is what a followed job reports, and how it ends: a JobCreated
// first, then JobProgressed, JobAttemptFailed and JobRefused as they come,
// and a JobCompleted last. As JSON it is {"kind": "progress", "data": …}, the
// same event in every SDK.
type JobEvent interface {
	jobEvent()
}

// JobCreated is the queue's answer to the job's creation, naming the job. A
// follower's first event.
type JobCreated struct {
	Data api.JobCreatedResultResponse
}

// JobProgressed is the job's progress.
type JobProgressed struct {
	Data api.JobProgress
}

// JobAttemptFailed is an attempt that failed, which the queue will try
// again. The job is not over.
type JobAttemptFailed struct {
	Data api.JobFailCommand
}

// JobRefused is a frame of a job's progress, completion or failure that the
// follower's reading refused: its transport refused the frame, or its
// payload is not its channel's. It names the frame's channel, and the member
// and reason of its fault. It names no job, so it may be this job's or
// another's, and it is no word of the job: the job goes on being followed,
// and its silence goes on being counted.
type JobRefused struct {
	Data struct {
		Channel bus.Channel            `json:"channel"`
		Member  string                 `json:"member"`
		Reason  bus.FrameRefusalReason `json:"reason"`
	}
}

// JobCompleted is the job's completion, as its verb's jobs give it. A
// follower's last event.
type JobCompleted[C any] struct {
	Data C
}

func (JobCreated) jobEvent()       {}
func (JobProgressed) jobEvent()    {}
func (JobAttemptFailed) jobEvent() {}
func (JobRefused) jobEvent()       {}
func (JobCompleted[C]) jobEvent()  {}

// kinded is a JobEvent as JSON: its kind, and what it carries.
func kinded(kind string, data any) ([]byte, error) {
	return json.Marshal(struct {
		Kind string `json:"kind"`
		Data any    `json:"data"`
	}{kind, data})
}

func (e JobCreated) MarshalJSON() ([]byte, error)       { return kinded("created", e.Data) }
func (e JobProgressed) MarshalJSON() ([]byte, error)    { return kinded("progress", e.Data) }
func (e JobAttemptFailed) MarshalJSON() ([]byte, error) { return kinded("failed", e.Data) }
func (e JobRefused) MarshalJSON() ([]byte, error)       { return kinded("refused", e.Data) }
func (e JobCompleted[C]) MarshalJSON() ([]byte, error)  { return kinded("complete", e.Data) }

// Delegation is a job another party does (Mark.Delegate, Yield.Delegate),
// consumed one of two ways, once:
//
//   - waited for (Wait), it gives the job's completion;
//   - ranged over (Events), it gives every event of the job, the
//     completion's the last of them, and ends.
//
// C is the completion its verb's jobs give: api.MarkJobCompleteCommand,
// whose Result is a mark job's counts or a decline, or
// api.YieldJobCompleteCommand, whose Result is the resource a yield job made
// or a decline. A job that does not complete is a failure, given where the
// completion would have been. Nothing is sent until it is first waited for or
// ranged over; its caller abandons it by cancelling the context it gave Wait
// or Events, or by stopping the loop: the job goes on, and is followed no
// more.
type Delegation[C any] struct {
	following *Running[JobEvent]
}

// Wait follows the job and gives its completion.
func (d *Delegation[C]) Wait(ctx context.Context) (C, error) {
	var none C
	last, err := d.following.Wait(ctx)
	if err != nil {
		return none, err
	}
	completed, ok := last.(JobCompleted[C])
	if !ok {
		return none, fmt.Errorf("a delegated job ended on a %T, not on its completion", last)
	}
	return completed.Data, nil
}

// Events follows the job as it is ranged over, until ctx is done: every
// event, the completion the last, or the failure where the completion would
// have been.
func (d *Delegation[C]) Events(ctx context.Context) iter.Seq2[JobEvent, error] {
	return d.following.Events(ctx)
}

// follow creates a job and follows it to the completion its verb's jobs give,
// C. delegated is the job's verb, and resourceID the resource it is about,
// for a completion learned from the job's status. stall is how long the job
// may say nothing before its follower gives up on it; nil when it never
// does.
func follow[C any](l *links, create api.JobCreateCommand, delegated api.JobType, resourceID api.ResourceId, stall *time.Duration) *Delegation[C] {
	return &Delegation[C]{following: &Running[JobEvent]{links: l, work: func(ctx context.Context, report func(JobEvent)) (JobEvent, error) {
		return followed[C](ctx, l, create, delegated, resourceID, stall, report)
	}}}
}

// lifecycle is what a job says of itself, by channel.
var lifecycle = []bus.Channel{bus.JobReportProgress.Channel(), bus.JobComplete.Channel(), bus.JobFail.Channel()}

// heard is a frame of some job's lifecycle, read as its channel's; or the
// refusal of one, which names no job.
type heard struct {
	channel  bus.Channel
	refusal  *FrameRefusal
	jobID    api.JobId
	jobType  api.JobType
	progress api.JobReportProgressCommand
	fail     api.JobFailCommand
	// complete is a completion as it came, to be read as the delegated
	// verb's.
	complete json.RawMessage
}

// hear reads what arrived as its channel's: the refusal its transport gave
// in a frame's place, the refusal of a payload that is not its channel's,
// or what the frame says of its job. False for a frame of no channel of the
// lifecycle. A completion is its channel's when it is a completion of the
// verb it states, its result that verb's.
func hear(one arrival) (heard, bool) {
	if one.refusal != nil {
		return heard{channel: one.refusal.Channel, refusal: one.refusal}, true
	}
	frame := one.frame
	said := heard{channel: frame.Channel}
	switch frame.Channel {
	case bus.JobReportProgress.Channel():
		read, refusal := delivered[api.JobReportProgressCommand](frame)
		said.refusal, said.progress = refusal, read.Payload
		said.jobID, said.jobType = read.Payload.JobId, read.Payload.JobType
	case bus.JobFail.Channel():
		read, refusal := delivered[api.JobFailCommand](frame)
		said.refusal, said.fail = refusal, read.Payload
		said.jobID, said.jobType = read.Payload.JobId, read.Payload.JobType
	case bus.JobComplete.Channel():
		if _, said.refusal = delivered[api.JobCompleteCommand](frame); said.refusal != nil {
			break
		}
		var named struct {
			JobID   api.JobId   `json:"jobId"`
			JobType api.JobType `json:"jobType"`
		}
		if json.Unmarshal(frame.Payload, &named) != nil {
			said.refusal = refusedPayload(frame, required.Undecoded)
			break
		}
		said.jobID, said.jobType, said.complete = named.JobID, named.JobType, frame.Payload
	default:
		return heard{}, false
	}
	return said, true
}

// resultMembers is each verb's result union: the spec's MarkJobResult and
// YieldJobResult, read here for a status, which states a result of any
// verb's. Their members share no required member, so a result is the one
// member whose required members it carries all of; the generated As*
// accessors are bare decodings and cannot say.
var resultMembers = map[api.JobType][]reflect.Type{
	api.JobTypeMark:  {reflect.TypeFor[api.MarkJobDone](), reflect.TypeFor[api.JobDeclined]()},
	api.JobTypeYield: {reflect.TypeFor[api.YieldJobDone](), reflect.TypeFor[api.JobDeclined]()},
}

// isVerbsResult is whether result is exactly one member of verb's result
// union.
func isVerbsResult(verb api.JobType, result []byte) bool {
	matched := 0
	for _, member := range resultMembers[verb] {
		if required.Carries(result, member) {
			matched++
		}
	}
	return matched == 1
}

// learned is the completion a complete status stands for, read as the
// delegated verb's, C. A status states its job's type and a result of any
// verb's, and does not state the resource the job is about.
func learned[C any](delegated api.JobType, status api.JobStatusResponse, resourceID api.ResourceId) (C, error) {
	var completion C
	unread := func(why string) (C, error) {
		return completion, transportErrorWithoutResponse(fmt.Sprintf("The status of job %s is not a completed %s job's: %s", status.JobId, delegated, why), TransportErrorCodeError)
	}
	if status.Type != delegated {
		return unread(fmt.Sprintf("it is a %s job's", status.Type))
	}
	stated := map[string]any{"resourceId": resourceID, "jobId": status.JobId, "jobType": status.Type}
	// A job completed without a result is stored with an empty one: an object that holds nothing.
	if status.Result != nil {
		raw, err := status.Result.MarshalJSON()
		if err != nil {
			return unread(err.Error())
		}
		var fields map[string]json.RawMessage
		if json.Unmarshal(raw, &fields) != nil || len(fields) > 0 {
			if !isVerbsResult(delegated, raw) {
				return unread("its `result` is malformed")
			}
			stated["result"] = json.RawMessage(raw)
		}
	}
	encoded, err := json.Marshal(stated)
	if err != nil {
		return unread(err.Error())
	}
	if err := json.Unmarshal(encoded, &completion); err != nil {
		return unread(err.Error())
	}
	return completion, nil
}

// outcome is what a request the follower made in the background came to.
type outcome[R any] struct {
	value R
	err   error
}

func followed[C any](ctx context.Context, l *links, create api.JobCreateCommand, delegated api.JobType, resourceID api.ResourceId, stall *time.Duration, report func(JobEvent)) (JobEvent, error) {
	silence, poll := l.timing.JobSilence, l.timing.JobStatusPoll
	// One reader of the three channels, so the job's frames are heard in the order they were published.
	frames, leave := l.own.listenAmong(lifecycle...)
	defer leave()
	// The follower's requests end with it.
	asked, stop := context.WithCancel(ctx)
	defer stop()

	creating := make(chan outcome[api.JobCreatedResult], 1)
	go func() {
		created, err := ask(asked, l, bus.JobCreate, create)
		creating <- outcome[api.JobCreatedResult]{created, err}
	}()
	var asking chan outcome[api.JobStatusResult]
	var jobID api.JobId
	var held []heard
	var askAt, stallAt time.Time
	if stall != nil {
		stallAt = time.Now().Add(*stall)
	}
	timer := time.NewTimer(0)
	<-timer.C
	defer timer.Stop()

	for {
		now := time.Now()
		if !stallAt.IsZero() && !now.Before(stallAt) {
			// A job whose creation was never answered has no id, and there is
			// nothing to cancel. Asked for as the client's work: the follower
			// ends here, and the request must outlive it.
			if !jobID.IsZero() {
				stalled := jobID
				l.run(func(ctx context.Context) {
					_, _ = ask(ctx, l, bus.JobCancelRequested, api.JobCancelRequest{JobId: stalled})
				})
			}
			return nil, &JobError{Code: JobErrorCodeStalled, Message: fmt.Sprintf("The job stalled: nothing was heard of it within %dms", stall.Milliseconds()), JobID: jobID}
		}
		var due time.Time
		for _, at := range []time.Time{askAt, stallAt} {
			if !at.IsZero() && (due.IsZero() || at.Before(due)) {
				due = at
			}
		}
		var wake <-chan time.Time
		if !due.IsZero() {
			timer.Reset(max(time.Until(due), 0))
			wake = timer.C
		}

		var said []heard
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case created := <-creating:
			if created.err != nil {
				return nil, created.err
			}
			creating = nil
			jobID = created.value.Response.JobId
			// Ahead of the frames held for it: the job's id is the first thing its follower gives.
			report(JobCreated{Data: created.value.Response})
			askAt = time.Now().Add(silence)
			said, held = held, nil
		case <-frames.Ready():
			items, closed := frames.Drain()
			for _, item := range items {
				if one, ok := hear(item); ok {
					if jobID.IsZero() {
						held = append(held, one)
					} else {
						said = append(said, one)
					}
				}
			}
			if closed && len(items) == 0 {
				return nil, &BusRequestError{Code: BusRequestErrorCodeClosed, Message: "The client closed while it was following a job"}
			}
			if closed {
				// What came before the close is handled; the next turn ends the follower.
				frames.Signal()
			}
		case status := <-asking:
			asking = nil
			var failure Error
			if status.err != nil && !errors.As(status.err, &failure) {
				return nil, status.err
			}
			// A status that could not be had is asked for again at the next poll.
			if status.err == nil {
				switch answer := status.value.Response; answer.Status {
				case api.JobStatusResponseStatusComplete:
					completion, err := learned[C](delegated, answer, resourceID)
					if err != nil {
						return nil, err
					}
					return JobCompleted[C]{Data: completion}, nil
				case api.JobStatusResponseStatusFailed:
					message := "Job failed"
					if answer.Error != nil && *answer.Error != "" {
						message = *answer.Error
					}
					return nil, &JobError{Code: JobErrorCodeFailed, Message: message, JobID: answer.JobId, FailureClass: answer.FailureClass}
				case api.JobStatusResponseStatusCancelled:
					// Nothing announces a cancellation: this is where its follower learns of one.
					return nil, &JobError{Code: JobErrorCodeCancelled, Message: "The job was cancelled", JobID: answer.JobId}
				}
			}
		case <-wake:
		}

		now = time.Now()
		if !askAt.IsZero() && !now.Before(askAt) {
			askAt = now.Add(poll)
			if asking == nil && !jobID.IsZero() {
				asking = make(chan outcome[api.JobStatusResult], 1)
				go func(answers chan<- outcome[api.JobStatusResult], of api.JobId) {
					status, err := ask(asked, l, bus.JobStatusRequested, api.JobStatusRequest{JobId: of})
					answers <- outcome[api.JobStatusResult]{status, err}
				}(asking, jobID)
			}
		}
		for _, one := range said {
			if one.refusal != nil {
				// It names no job, and is no word of this one: neither deadline starts again.
				var event JobRefused
				event.Data.Channel, event.Data.Member, event.Data.Reason = one.refusal.Channel, one.refusal.Member, one.refusal.Reason
				report(event)
				continue
			}
			if one.jobID != jobID {
				continue
			}
			switch one.channel {
			case bus.JobReportProgress.Channel():
				if one.progress.Progress != nil {
					report(JobProgressed{Data: *one.progress.Progress})
				}
				askAt = now.Add(silence)
				if stall != nil {
					stallAt = now.Add(*stall)
				}
			case bus.JobFail.Channel():
				// Absent reads as final: a follower that ends early is seen, one that never ends is not.
				if one.fail.WillRetry == nil || !*one.fail.WillRetry {
					return nil, &JobError{Code: JobErrorCodeFailed, Message: one.fail.Error, JobID: one.fail.JobId, FailureClass: one.fail.FailureClass}
				}
				// The queue re-queues the job and another attempt continues
				// it. The dead attempt's status is not asked for: the next
				// attempt's first frame starts the silence again. The setback
				// was heard, so the stall deadline starts again: one left
				// running would cancel the attempt that is coming.
				askAt = time.Time{}
				if stall != nil {
					stallAt = now.Add(*stall)
				}
				report(JobAttemptFailed{Data: one.fail})
			default:
				// The third thing a job says: that it completed, read as the delegated verb's completion.
				if one.jobType != delegated {
					return nil, transportErrorWithoutResponse(fmt.Sprintf("The job:complete of job %s is a %s job's, and the job delegated is a %s job", one.jobID, one.jobType, delegated), TransportErrorCodeError)
				}
				var completion C
				if err := json.Unmarshal(one.complete, &completion); err != nil {
					return nil, transportErrorWithoutResponse(fmt.Sprintf("The job:complete of job %s is not a completed %s job's: %v", one.jobID, delegated, err), TransportErrorCodeError)
				}
				return JobCompleted[C]{Data: completion}, nil
			}
		}
	}
}

// refused is a delegation whose job could not be written: consumed, it fails
// with err, and nothing is sent.
func refused[C any](l *links, err error) *Delegation[C] {
	return &Delegation[C]{following: &Running[JobEvent]{links: l, work: func(context.Context, func(JobEvent)) (JobEvent, error) {
		return nil, err
	}}}
}
