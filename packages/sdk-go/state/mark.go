package state

// Marking, as one resource's state: the annotation being composed, and the
// delegated job that is running.
//
// The pending annotation. A selection (Mark.Request) becomes the annotation
// pending. Submitting it (Mark.Submit) creates it, and it stops being pending
// when the knowledge base says it is recorded; a creation that fails leaves
// it pending and says mark:create-error on the client's own bus.
// CancelPending drops it.
//
// A request and a submission are signals on the client's own bus that name
// the resource they are for, and a unit acts only on its own. A delegation, a
// cancel and a dismissal are asked of the unit itself. So several units over
// one client, one per open resource, do not answer for each other.
//
// The delegated job. RequestDelegate starts one: the mark job of the
// parameters it is given, delegated for this unit's resource. The motivation
// those parameters state is held while it runs, and its progress as it
// comes, with the motivation that progress is of. A finished job's progress
// stays until it is dismissed (DismissProgress) or the next one begins, and
// so does a cancelled one's: its commits stand. One that fails clears it. Why
// a job ended without completing is held until the progress is dismissed or
// the next job begins. The job's id is held from the queue's answer to its
// creation to the job's end: it is what Job.Cancel names.
//
// A delegated job that says nothing for Timing.DelegateSilence has gone
// quiet, which is not over: the unit says so once (mark:delegate-timeout) and
// keeps following, so a completion that arrives later still ends it.

import (
	"time"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

// PendingAnnotation is an annotation being composed: where it is, and why it
// is made. Its selector is what Mark.Submit takes.
type PendingAnnotation struct {
	Selector   api.AnnotationSelector `json:"selector"`
	Motivation api.Motivation         `json:"motivation"`
}

// MarkStateUnit marks one resource: see the file's documentation. A state
// holding none is nil, or the zero value of an id or a motivation.
type MarkStateUnit struct {
	client     *semiont.Client
	resourceID api.ResourceId
	silence    time.Duration
	life

	pending            *semiont.Variable[*PendingAnnotation]
	delegating         *semiont.Variable[api.Motivation]
	progress           *semiont.Variable[*api.JobProgress]
	progressMotivation *semiont.Variable[api.Motivation]
	failure            *semiont.Variable[error]
	jobID              *semiont.Variable[api.JobId]
}

var _ semiont.StateUnit = (*MarkStateUnit)(nil)

// NewMarkStateUnit is a unit marking resourceID over client. It hears the
// client's own bus from now on.
func NewMarkStateUnit(client *semiont.Client, resourceID api.ResourceId) *MarkStateUnit {
	u := &MarkStateUnit{
		client:             client,
		resourceID:         resourceID,
		silence:            semiont.DefaultTiming().DelegateSilence,
		life:               newLife(),
		pending:            semiont.NewVariable[*PendingAnnotation](nil),
		delegating:         semiont.NewVariable[api.Motivation](""),
		progress:           semiont.NewVariable[*api.JobProgress](nil),
		progressMotivation: semiont.NewVariable[api.Motivation](""),
		failure:            semiont.NewVariable[error](nil),
		jobID:              semiont.NewVariable(api.JobId{}),
	}
	// One reader of every signal it hears, taken now, so what is said from here on is acted on in the order it was said.
	u.listen(client.Bus.FramesAmong(u.alive, bus.MarkRequested.Channel(), bus.MarkSubmit.Channel()), u.heard)
	return u
}

// PendingAnnotation is the annotation being composed, or nil.
func (u *MarkStateUnit) PendingAnnotation() semiont.Watched[*PendingAnnotation] { return u.pending }

// DelegatingMotivation is the motivation of the delegated job that is
// running, or none.
func (u *MarkStateUnit) DelegatingMotivation() semiont.Watched[api.Motivation] {
	return u.delegating
}

// Progress is the progress of the delegated job that is running, or of the
// last one until it is dismissed.
func (u *MarkStateUnit) Progress() semiont.Watched[*api.JobProgress] { return u.progress }

// ProgressMotivation is the motivation of the run whose progress Progress
// holds, until the progress is dismissed or cleared by a failure.
func (u *MarkStateUnit) ProgressMotivation() semiont.Watched[api.Motivation] {
	return u.progressMotivation
}

// Failure is why the last delegated job ended without completing, until it
// is dismissed or the next job begins.
func (u *MarkStateUnit) Failure() semiont.Watched[error] { return u.failure }

// JobId is the delegated job's id, from the queue's answer to its creation
// to its end: what Job.Cancel names.
func (u *MarkStateUnit) JobId() semiont.Watched[api.JobId] { return u.jobID }

// RequestDelegate delegates the annotating of this unit's resource, as the
// mark job of params: what Mark.Delegate takes.
func (u *MarkStateUnit) RequestDelegate(params api.MarkJobParams) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.closed {
		return
	}
	stated, err := params.Discriminator()
	motivation := api.Motivation(stated)
	u.delegating.Set(motivation)
	u.progress.Set(nil)
	u.progressMotivation.Set(motivation)
	u.failure.Set(nil)
	u.jobID.Set(api.JobId{})
	if err != nil {
		// Parameters that state no motivation are no job's: none is delegated, and why is held.
		u.failure.Set(err)
		u.delegating.Set("")
		u.progressMotivation.Set("")
		return
	}
	go u.follow(u.client.Mark.Delegate(u.resourceID, params), motivation)
}

// CancelPending drops the annotation that is pending.
func (u *MarkStateUnit) CancelPending() {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.closed {
		return
	}
	u.pending.Set(nil)
}

// DismissProgress clears the display of a delegated job: its progress, the
// motivation that progress is of, and why it ended.
func (u *MarkStateUnit) DismissProgress() {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.closed {
		return
	}
	u.progress.Set(nil)
	u.progressMotivation.Set("")
	u.failure.Set(nil)
}

// heard acts on a signal of the client's own bus. A frame that is not its
// channel's is nobody's to act on.
func (u *MarkStateUnit) heard(frame semiont.Frame) {
	switch frame.Channel {
	case bus.MarkRequested.Channel():
		request, err := semiont.Decoded(bus.MarkRequested, frame)
		if err == nil && request.Payload.Source == u.resourceID {
			u.pending.Set(&PendingAnnotation{Selector: request.Payload.Selector, Motivation: request.Payload.Motivation})
		}
	case bus.MarkSubmit.Channel():
		submission, err := semiont.Decoded(bus.MarkSubmit, frame)
		if err == nil && submission.Payload.Source == u.resourceID {
			go u.create(submission.Payload)
		}
	}
}

// create makes what was submitted. The annotation stops being pending here,
// when its own creation is recorded, and not on any creation's reply: a reply
// does not say which resource it was for, so another viewer's would drop this
// one's selection.
func (u *MarkStateUnit) create(submission api.MarkSubmitEvent) {
	selector := submission.Selector
	request := api.CreateAnnotationRequest{
		Motivation: submission.Motivation,
		Target:     api.AnnotationTarget{Source: u.resourceID, Selector: &selector},
		Body:       submission.Body,
	}
	_, err := u.client.Mark.Annotation(u.alive, request)
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.closed {
		return
	}
	if err != nil {
		_ = semiont.Publish(u.client.Bus, bus.MarkCreateError, api.ResourceErrorEvent{ResourceId: u.resourceID, Message: err.Error()}, semiont.Envelope{})
		return
	}
	u.pending.Set(nil)
}

// jobHeard is what a delegated job said, or how it ended.
type jobHeard struct {
	event semiont.JobEvent
	err   error
}

// follow follows a delegated job to its end.
func (u *MarkStateUnit) follow(run *semiont.Delegation[api.MarkJobCompleteCommand], motivation api.Motivation) {
	// The job's events, read on a goroutine of their own: a silence gives up
	// waiting for the next, never the reading, since a quiet job is still
	// followed.
	heard := make(chan jobHeard)
	go func() {
		defer close(heard)
		for event, err := range run.Events(u.alive) {
			select {
			case heard <- jobHeard{event, err}:
			case <-u.alive.Done():
				// Closed while the job runs: the reading stops, and the delegation is abandoned.
				return
			}
		}
	}()
	// This job's id. At the job's end it is let go only while it is still the one held: a job delegated later replaces it.
	var created api.JobId
	silence := time.NewTimer(u.silence)
	defer silence.Stop()
	// Whether the next silence is still to be said. It is said once, and again only after the job has said something.
	listening := true
	for {
		var quiet <-chan time.Time
		if listening {
			quiet = silence.C
		}
		select {
		case <-u.alive.Done():
			return
		case <-quiet:
			listening = false
			u.goneQuiet(motivation)
			continue
		case said, open := <-heard:
			if !open {
				u.ended(created)
				return
			}
			silence.Reset(u.silence)
			listening = true
			u.mu.Lock()
			if u.closed {
				u.mu.Unlock()
				return
			}
			switch event := said.event.(type) {
			case semiont.JobCreated:
				u.jobID.Set(event.Data.JobId)
				created = event.Data.JobId
			case semiont.JobProgressed:
				progress := event.Data
				u.progress.Set(&progress)
			}
			if said.err != nil {
				// Why it ended is said before the end itself. A cancelled job's commits stand, and its display stays to say so.
				u.failure.Set(said.err)
				if !cancelled(said.err) {
					u.progress.Set(nil)
					u.progressMotivation.Set("")
				}
			}
			u.mu.Unlock()
		}
	}
}

// ended is the end of the job created as created: it is delegating no more,
// and its id is let go while it is still the one held.
func (u *MarkStateUnit) ended(created api.JobId) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.closed {
		return
	}
	u.delegating.Set("")
	if !created.IsZero() && u.jobID.Value() == created {
		u.jobID.Set(api.JobId{})
	}
}

// goneQuiet says the job has gone quiet. It is still running as far as
// anyone here knows, so its motivation stays; a display with no progress is
// given one.
func (u *MarkStateUnit) goneQuiet(motivation api.Motivation) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.closed {
		return
	}
	if u.progress.Value() == nil {
		u.progress.Set(&api.JobProgress{Percentage: 0})
	}
	_ = semiont.Publish(u.client.Bus, bus.MarkDelegateTimeout, api.MarkDelegateTimeoutEvent{ResourceId: u.resourceID, Motivation: motivation}, semiont.Envelope{})
}

// Close ends the unit: what it had running stops, the delegated job it was
// following is abandoned (the job goes on), and every state ends. Closing
// twice is closing once.
func (u *MarkStateUnit) Close() {
	u.mu.Lock()
	defer u.mu.Unlock()
	if !u.close() {
		return
	}
	u.pending.End()
	u.delegating.End()
	u.progress.End()
	u.progressMotivation.End()
	u.failure.End()
	u.jobID.End()
}
