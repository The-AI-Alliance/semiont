package semiont

// A worker's side of the job queue: Job.Claim.
//
// A worker is any party that takes jobs and says how each one went. What it
// promises the dispatcher, and everyone who follows a job, is
// docs/protocol/WORKER-CONTRACT.md; this file is that contract for Go, and the
// worker conformance suite (tests/conformance/worker) holds it on the wire.
//
// THE MODEL. A worker asks the queue at every moment it becomes idle, and
// never otherwise. job:claim carries the jobs it takes; the dispatcher answers
// with the next pending job that matches one of them, or declines. Queue state
// is the truth, and no message carries correctness. The idle moments:
//
//   - its claims are first ranged over, once the stream is open;
//   - it settles the job it holds, immediately, with no timer;
//   - a matching job:queued arrives while it holds nothing;
//   - the stream opens again: every change to open after the first.
//
// job:queued is a WAKE-UP with no memory. While the worker holds nothing it
// causes a claim; while a claim is in flight it sets a bit that earns exactly
// one more claim, so a wake-up cannot be lost in that window; while a job is
// held it is ignored, because the settle claims. The check of a wake-up is a
// PRE-FILTER: an announcement carries the job description less its input, so
// the worker asks its own claim's question of it (JobMatchesFilter), the
// comparison the dispatcher makes, and does not spend a round trip to be
// declined.
//
// A HELD JOB owns its lifecycle. It says its own start, progress and
// checkpoints, and it settles once: Complete, Fail and Cancel each say the
// outcome and release the job in one call, and a second is refused.
//
// A HELD JOB COMMITS FOR ITSELF. Commit sends a batch of annotations to the
// record, citing the job, and returns once the batch is established: the
// record acknowledged it, or, when no acknowledgement came, answered that the
// batch's last annotation is on the resource. The job remembers the weakest of
// what its commits observed and states it when it settles, so a worker says
// neither which job a batch is for nor how its commits went.
//
// EACH JOB HAS A TRACE OF ITS OWN (WORKER-CONTRACT T1). A claim is made in no
// trace: the claiming runs as the client's, never in the context of the code
// that settled the job before it. A held job states the trace its reply
// arrived in (Trace), and a message it sends under a context in no trace is
// sent in that one; a worker's span for the job continues it with
// Continuing(ctx, job.Trace()).
//
//	claims := client.Job.Claim(accepts)
//	defer claims.Close()
//	for job, err := range claims.All() {
//		var refused *semiont.ClaimRefusal
//		if errors.As(err, &refused) {
//			continue // the host judges: bus.unauthorized means stop
//		}
//		...
//		job.Start(ctx)
//		switch held := job.(type) {
//		case *semiont.HeldMarkJob:
//			held.Complete(ctx, result)
//		}
//	}
//
// Closed, the claims stop, and a job still held then is failed first. Go tells
// nobody when a value is let go of, so a job that is neither settled nor held
// when its claims close stays with the dispatcher until its worker stops.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"iter"
	"maps"
	"reflect"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

// JobClaimChannels is what a worker's stream names for its claims: the
// replies of job:claim, and the two broadcasts a worker reads. job:queued and
// job:cancel-requested reach only a stream that names them, so a transport
// made for a worker is given these beside the reply channels of whatever else
// the worker awaits.
var JobClaimChannels = append(bus.ReplyChannelsFor(bus.JobClaim.Request().Channel()),
	bus.JobQueued.Channel(),
	bus.JobCancelRequested.Request().Channel(),
)

// JobCommitChannels is what a worker's stream names for its commits: the
// replies of mark:commit, and of the question it asks when one goes
// unacknowledged. The question is the read of ONE annotation, and not of a
// resource's list of them: reply channels reach every stream that names them,
// and the list's replies are the frames of many megabytes a worker's stream
// exists to keep out; one annotation's frame is small.
var JobCommitChannels = bus.ReplyChannelsFor(bus.MarkCommit.Request().Channel(), bus.BrowseAnnotationRequested.Request().Channel())

// stoppedWhileHeld is the error of a job failed because its worker stopped,
// and not because the work failed.
const stoppedWhileHeld = "The worker stopped while it held the job"

// retriedClasses is whether the queue runs a failure of each class again
// while its job has retries left. A failure known to be deterministic is not:
// the same request cannot succeed on a second attempt. Neither is an answer
// the provider withheld: it withholds its answer to the same request again.
// Every class the spec names is here, and a test holds the list to the spec.
var retriedClasses = map[api.FailureClass]bool{
	api.FailureClassTransient:     true,
	api.FailureClassDeterministic: false,
	api.FailureClassWithheld:      false,
}

// WillRetryAfter is whether a failed attempt is retried: exactly when the
// failure's class is one the queue retries and the job has retries left, on
// the record before the failure is applied. A failure of no stated class
// (nil) is retried as a transient one is. Two places need the answer and they
// must never disagree: the dispatcher's queue acts on it, and a worker
// reports it on job:fail as willRetry. specs/src/jobs/retry-cases.json is the
// table every implementation answers alike.
func WillRetryAfter(retryCount, maxRetries int, failureClass *api.FailureClass) bool {
	retried := true
	if failureClass != nil {
		retried = retriedClasses[*failureClass]
	}
	return retried && retryCount < maxRetries
}

// weakness is how weak an observation of a commit is, as evidence that the
// batch is on the record. The two a commit is not established by are equally
// weak: one says the record answered that the annotation is not there, the
// other that nobody answered, and neither says more than the other. Every
// evidence the spec names is here, and a test holds the list to the spec.
var weakness = map[api.DurabilityEvidence]int{
	api.DurabilityEvidenceAcknowledged:     0,
	api.DurabilityEvidenceProbeConfirmed:   1,
	api.DurabilityEvidenceProbeRefused:     2,
	api.DurabilityEvidenceProbeUnreachable: 2,
}

// JobMatchesFilter is whether job matches filter, both as the wire carries
// them (decoded JSON): a filter as a claim states it, and a job description
// as it is announced or held, with its jobType and its params. A filter is a
// partial job description: a job matches when every field the filter states
// equals the job's at the same path, and what the filter leaves out is not
// compared. specs/src/jobs/filter-cases.json holds every implementation to
// one answer.
func JobMatchesFilter(filter, job any) bool {
	stated, ok := filter.(map[string]any)
	if !ok {
		return false
	}
	return states(stated, job)
}

// states is whether actual states everything stated does, at the same paths.
func states(stated, actual any) bool {
	if object, ok := stated.(map[string]any); ok {
		held, ok := actual.(map[string]any)
		if !ok {
			return false
		}
		for name, value := range object {
			present, has := held[name]
			if !has || !states(value, present) {
				return false
			}
		}
		return true
	}
	// A number is the number it is, however it was written: decoded, 1 and
	// 1.0 are one float64, and neither is true.
	return reflect.DeepEqual(stated, actual)
}

// ClaimRefusal is a claim that was refused for a reason other than "nothing
// pending". It is the error the claims give where a job would have been.
type ClaimRefusal struct {
	// Code is the code the reply was given; nil when the refusal was the
	// worker's own: a reply that names no job, or a claim that could not be
	// sent. bus.none-pending never appears: an empty queue is not a fault.
	// bus.unauthorized means this credential cannot claim, and will not be
	// able to later.
	Code    *BusRequestErrorCode
	Message string
}

func (r *ClaimRefusal) Error() string { return r.Message }

// ActiveJob is the job a worker holds, as its vitals name it.
type ActiveJob struct {
	JobId   api.JobId
	JobType api.JobType
	Since   time.Time
}

// WorkerVitals is what a worker can say of itself at any moment
// (WORKER-CONTRACT V1). A time that is zero has not happened yet.
//
// LastQueuedEventAt is any job:queued received, matching or not. On an idle
// stack with an empty queue it stands still by design, so a still stamp alone
// is not a fault of the stream. LastActivityAt (a claim, a progress report, a
// checkpoint, a settle) is the liveness of the work: a job stuck partway
// stops advancing it, and that is what the stall rule reads.
type WorkerVitals struct {
	LastQueuedEventAt time.Time
	LastClaimAt       time.Time
	// LastFinishedAt is the last settle, whatever its outcome: a worker that
	// fails and moves on is alive.
	LastFinishedAt time.Time
	LastActivityAt time.Time
	// ActiveJob is the job held now; nil when none is.
	ActiveJob     *ActiveJob
	JobsCompleted int
}

// HeldJobStall is a held job that showed no activity for Threshold
// (WORKER-CONTRACT V2). What its host does then is the host's.
type HeldJobStall struct {
	JobId          api.JobId
	JobType        api.JobType
	HeldSince      time.Time
	LastActivityAt time.Time
	SilentFor      time.Duration
	Threshold      time.Duration
}

// ending is a Watched read until over is done, after which it changes no
// more.
type ending[T comparable] struct {
	watched *Variable[T]
	over    context.Context
}

func (e ending[T]) Value() T { return e.watched.Value() }

func (e ending[T]) Changes(ctx context.Context) iter.Seq[T] {
	return func(yield func(T) bool) {
		inner, cancel := context.WithCancel(ctx)
		defer cancel()
		stop := context.AfterFunc(e.over, cancel)
		defer stop()
		for value := range e.watched.Changes(inner) {
			if !yield(value) {
				return
			}
		}
	}
}

// JobFailure is what a failure carries beside its error. What the job's
// commits observed is the held job's own to state.
type JobFailure struct {
	// FailureClass is the failure's class, when the worker knows it.
	FailureClass *api.FailureClass
	// CompletedUnits is the units finished before the failure; nil when the
	// failure states none.
	CompletedUnits []string
	// UnitCursors is the furthest each unit begun got, a finished unit's
	// cursor where it ended; nil when the failure states none.
	UnitCursors map[string]api.UnitCursor
}

// HeldJob is a job this worker holds, as its verb's: a *HeldMarkJob or a
// *HeldYieldJob. A completion is its verb's, so a type switch reads which
// before Complete is called; every other member is the same for both.
type HeldJob interface {
	// JobId is the job's id.
	JobId() api.JobId
	// JobType is the job's verb.
	JobType() api.JobType
	// ResourceId is the resource the job is about.
	ResourceId() api.ResourceId
	// Params is the job's parameters as the dispatcher holds them: the
	// description, and what the dispatcher adds.
	Params() api.JobParams
	// CompletedUnits is the units earlier attempts finished. A worker does
	// not do them again. Empty on a first attempt.
	CompletedUnits() []string
	// UnitCursors is the furthest each unit begun got on an earlier attempt,
	// and what it had counted there; a finished unit's is where it ended.
	// Empty on a first attempt.
	UnitCursors() map[string]api.UnitCursor
	// RetryCount is how many attempts failed before this one.
	RetryCount() int
	// MaxRetries is how many the job is allowed.
	MaxRetries() int
	// Attempt is which attempt this is, 1-based. Every lifecycle message
	// states it.
	Attempt() int
	// AnnotationId is the annotation the job is anchored to: the one a yield
	// job's context is focused on. The zero AnnotationId for a job anchored
	// to none.
	AnnotationId() api.AnnotationId
	// Trace is the trace the job is run in: the one its reply arrived in.
	// The zero TraceContext for a reply that arrived in none.
	Trace() TraceContext
	// Cancelled is whether a cancellation has named this job: the answer
	// now, and the change to it, until the job is settled. The work stops
	// where it can, and the worker says Cancel.
	Cancelled() Watched[bool]
	// Settled is whether the job has been settled: completed, failed or
	// cancelled.
	Settled() bool
	// Start says job:start: the job's first message, said once.
	Start(ctx context.Context) error
	// Progress says job:report-progress. It counts as activity.
	Progress(ctx context.Context, progress api.JobProgress) error
	// Checkpoint says job:checkpoint: what a later attempt resumes from. It
	// counts as activity.
	Checkpoint(ctx context.Context, completedUnits []string, unitCursors map[string]api.UnitCursor) error
	// Commit says mark:commit for this job, and returns once the batch is
	// established.
	Commit(ctx context.Context, resourceID api.ResourceId, annotations []api.Annotation) error
	// Fail settles the job: job:fail.
	Fail(ctx context.Context, message string, failure JobFailure) error
	// Cancel settles the job: job:cancel.
	Cancel(ctx context.Context, completedUnits []string, unitCursors map[string]api.UnitCursor) error

	held() *heldJob
}

var (
	_ HeldJob = (*HeldMarkJob)(nil)
	_ HeldJob = (*HeldYieldJob)(nil)
)

// heldJob is what a held job is, whatever its verb.
type heldJob struct {
	claims       *Claims
	trace        TraceContext
	jobID        api.JobId
	jobType      api.JobType
	resourceID   api.ResourceId
	params       api.JobParams
	retryCount   int
	maxRetries   int
	annotationID api.AnnotationId
	// completedUnits and unitCursors are the record's, once an attempt has
	// checkpointed. Absent, each reads as none.
	completedUnits []string
	unitCursors    map[string]api.UnitCursor
	cancelled      *Variable[bool]
	// over is done once the job is settled: nothing about it changes after.
	over context.Context
	end  context.CancelFunc

	mu      sync.Mutex
	begun   bool
	settled bool
	// durability is the weakest of what this job's commits observed, across
	// every batch and every resource it committed on: the strongest thing
	// still true of the job as a whole. Nil until a batch is committed, and
	// never a default: a job that commits nothing states nothing.
	durability *api.DurabilityEvidence
}

func (h *heldJob) held() *heldJob { return h }

func (h *heldJob) JobId() api.JobId               { return h.jobID }
func (h *heldJob) JobType() api.JobType           { return h.jobType }
func (h *heldJob) ResourceId() api.ResourceId     { return h.resourceID }
func (h *heldJob) Params() api.JobParams          { return h.params }
func (h *heldJob) CompletedUnits() []string       { return slices.Clone(h.completedUnits) }
func (h *heldJob) RetryCount() int                { return h.retryCount }
func (h *heldJob) MaxRetries() int                { return h.maxRetries }
func (h *heldJob) Attempt() int                   { return h.retryCount + 1 }
func (h *heldJob) AnnotationId() api.AnnotationId { return h.annotationID }
func (h *heldJob) Trace() TraceContext            { return h.trace }

func (h *heldJob) UnitCursors() map[string]api.UnitCursor { return maps.Clone(h.unitCursors) }

func (h *heldJob) Cancelled() Watched[bool] { return ending[bool]{h.cancelled, h.over} }

func (h *heldJob) Settled() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.settled
}

// attempt is Attempt, as a lifecycle message states it.
func (h *heldJob) attempt() *int {
	attempt := h.Attempt()
	return &attempt
}

// anchor is AnnotationId, as a message states it: nil for a job anchored to
// none.
func (h *heldJob) anchor() *api.AnnotationId {
	if h.annotationID.IsZero() {
		return nil
	}
	anchored := h.annotationID
	return &anchored
}

// inTrace is ctx, in the job's trace when ctx is in none.
func (h *heldJob) inTrace(ctx context.Context) context.Context {
	if activeTrace(ctx).IsZero() {
		return Continuing(ctx, h.trace)
	}
	return ctx
}

// unsettled refuses a message of a job that is settled.
func (h *heldJob) unsettled(saying bus.Channel) error {
	if h.settled {
		return fmt.Errorf("Job %s is already settled: it cannot say %s", h.jobID, saying)
	}
	return nil
}

// going marks the job as having said more than its start, and refuses a job
// that is settled.
func (h *heldJob) going(saying bus.Channel) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if err := h.unsettled(saying); err != nil {
		return err
	}
	h.begun = true
	return nil
}

// settling settles the job from the moment it is asked to be, so a second
// settle is refused while the first is on its way.
func (h *heldJob) settling(saying bus.Channel) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if err := h.unsettled(saying); err != nil {
		return err
	}
	h.settled = true
	return nil
}

// released is the job, settled and no longer held: whether it was completed.
func (h *heldJob) released(completed bool) {
	// Settled: no cancellation will be signalled to it now, and whoever
	// watches for one is told so.
	h.end()
	h.claims.released(h, completed)
}

// say sends one of a held job's messages over the wire.
func say[P any](ctx context.Context, h *heldJob, c bus.Emittable[P], payload P) error {
	_, _, err := Emit(h.inTrace(ctx), h.claims.links.wire, c, payload, Envelope{})
	return err
}

func (h *heldJob) Start(ctx context.Context) error {
	saying := bus.JobStart.Channel()
	h.mu.Lock()
	if err := h.unsettled(saying); err != nil {
		h.mu.Unlock()
		return err
	}
	if h.begun {
		h.mu.Unlock()
		return fmt.Errorf("job:start is a held job's first message, said once: job %s has already said more", h.jobID)
	}
	h.begun = true
	h.mu.Unlock()
	return say(ctx, h, bus.JobStart, api.JobStartCommand{
		ResourceId: h.resourceID, JobId: h.jobID, JobType: h.jobType, Attempt: h.attempt(), AnnotationId: h.anchor(),
	})
}

func (h *heldJob) Progress(ctx context.Context, progress api.JobProgress) error {
	if err := h.going(bus.JobReportProgress.Channel()); err != nil {
		return err
	}
	h.claims.active()
	if anchor := h.anchor(); anchor != nil {
		progress.AnnotationId = anchor
	}
	return say(ctx, h, bus.JobReportProgress, api.JobReportProgressCommand{
		ResourceId: h.resourceID, JobId: h.jobID, JobType: h.jobType, Attempt: h.attempt(), AnnotationId: h.anchor(),
		Percentage: progress.Percentage, Progress: &progress,
	})
}

func (h *heldJob) Checkpoint(ctx context.Context, completedUnits []string, unitCursors map[string]api.UnitCursor) error {
	if err := h.going(bus.JobCheckpoint.Channel()); err != nil {
		return err
	}
	h.claims.active()
	return say(ctx, h, bus.JobCheckpoint, api.JobCheckpointCommand{
		JobId: h.jobID, CompletedUnits: listed(completedUnits), UnitCursors: stated(unitCursors),
	})
}

// listed is units as a message states them: none is an empty list.
func listed(units []string) []string {
	if units == nil {
		return []string{}
	}
	return units
}

// stated is cursors as a message states them: nil when none are stated.
func stated(cursors map[string]api.UnitCursor) *map[string]api.UnitCursor {
	if cursors == nil {
		return nil
	}
	return &cursors
}

// statedUnits is units as an optional field states them: nil when none are
// stated.
func statedUnits(units []string) *[]string {
	if units == nil {
		return nil
	}
	return &units
}

// Commit says mark:commit for this job: it returns once the batch is
// established.
//
// It sends the batch to the record and WAITS for the record to say it has
// it. The gateway taking the message says nothing of the record: a record
// that is down discards a batch the gateway accepted, and a job that counted
// the batch as done would report work that never landed.
//
// A commit the record does not acknowledge in time is not thereby lost. If
// the gateway goes down after the record appended the batch, the
// acknowledgement cannot be routed, and a job failed on that would be failed
// over annotations that are on the record. So the outcome follows what the
// record holds, and not the arrival of a message: the record is asked. A
// batch is never sent a second time to find out.
//
// A commit that was not established fails as its unanswered request did,
// with that request's own failure. What was observed leaves by the job's
// settle, the one place it can still be told.
func (h *heldJob) Commit(ctx context.Context, resourceID api.ResourceId, annotations []api.Annotation) error {
	h.mu.Lock()
	err := h.unsettled(bus.MarkCommit.Request().Channel())
	h.mu.Unlock()
	if err != nil {
		return err
	}
	if len(annotations) == 0 {
		// A batch of no annotations is no commit: there is nothing to establish.
		return nil
	}
	jobID := h.jobID
	unanswered := h.answered(ctx, bus.MarkCommit.Request().Channel(), api.MarkCommitCommand{ResourceId: resourceID, Annotations: annotations, JobId: &jobID})
	if unanswered == nil {
		h.observe(api.DurabilityEvidenceAcknowledged)
		return nil
	}
	// The record's refusal, and every other failure of the request, is the
	// commit's failure as it is. Only an acknowledgement that did not arrive
	// leaves what the record holds unknown.
	var timedOut *BusRequestError
	if !errors.As(unanswered, &timedOut) || timedOut.Code != BusRequestErrorCodeTimeout {
		return unanswered
	}
	observed := h.askWhetherRecorded(ctx, resourceID, annotations[len(annotations)-1].Id)
	h.observe(observed)
	if observed != api.DurabilityEvidenceProbeConfirmed {
		return unanswered
	}
	return nil
}

// askWhetherRecorded is what asking whether the annotation is on the resource
// observes. Asked of the LAST annotation of a batch nobody acknowledged, and
// that is enough: the record appends a batch in order and stops at the first
// annotation it cannot append (WORKER-CONTRACT A5), so the last being there
// says every one before it is.
//
// Every answer but the annotation fails the commit, and the asymmetry is
// deliberate: a job retried over a batch that had landed costs one more run
// of the batch's unit, where a wrong "it is there" loses the batch silently.
// A question nobody answered is neither yes nor no: it is said as its own
// observation, and it does not establish the commit.
func (h *heldJob) askWhetherRecorded(ctx context.Context, resourceID api.ResourceId, annotationID api.AnnotationId) api.DurabilityEvidence {
	err := h.answered(ctx, bus.BrowseAnnotationRequested.Request().Channel(), api.BrowseAnnotationRequest{ResourceId: resourceID, AnnotationId: annotationID})
	if err == nil {
		return api.DurabilityEvidenceProbeConfirmed
	}
	// A failure reply (bus.rejected) means the question was answered and the
	// answer was not the annotation. That is not "the annotation is absent":
	// a read that failed for its own reasons answers on the same channel. So
	// the job says what was observed, and its reader judges. Anything else
	// (bus.timeout, bus.closed) means nobody answered.
	var refused *BusRequestError
	if errors.As(err, &refused) && refused.Code == BusRequestErrorCodeRejected {
		return api.DurabilityEvidenceProbeRefused
	}
	return api.DurabilityEvidenceProbeUnreachable
}

// answered is one of a commit's requests, waited for the commit's wait: nil
// once it is answered, or the failure a bus request has. What it is answered
// with is not read: that the record answered is what establishes a commit,
// so an answer this SDK cannot type is the answer it is all the same.
func (h *heldJob) answered(ctx context.Context, request bus.Channel, payload any) error {
	object, err := payloadOf(payload)
	if err != nil {
		return err
	}
	links := h.claims.links
	_, err = links.wire.result(h.inTrace(ctx), request, object, links.timing.MarkCommitTimeout, nil)
	return err
}

// observe remembers evidence if it is weaker than what is remembered. Of two
// equally weak, the first seen is kept.
func (h *heldJob) observe(evidence api.DurabilityEvidence) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.durability == nil || weakness[evidence] > weakness[*h.durability] {
		h.durability = &evidence
	}
}

// observed is the weakest of what the job's commits observed; nil when it
// committed nothing.
func (h *heldJob) observed() *api.DurabilityEvidence {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.durability
}

// Fail settles the job: job:fail. It says whether the queue will retry, from
// the record's budget and the failure's class, and what a commit that was not
// established observed. A settle the gateway did not take still releases the
// job, and fails.
func (h *heldJob) Fail(ctx context.Context, message string, failure JobFailure) error {
	if err := h.settling(bus.JobFail.Channel()); err != nil {
		return err
	}
	defer h.released(false)
	// Stated only when a commit was not established: what is weaker than any
	// observation that establishes one. Otherwise the failure says nothing of
	// the job's commits.
	var notEstablished *api.DurabilityEvidence
	if observed := h.observed(); observed != nil && weakness[*observed] > weakness[api.DurabilityEvidenceProbeConfirmed] {
		notEstablished = observed
	}
	willRetry := WillRetryAfter(h.retryCount, h.maxRetries, failure.FailureClass)
	return say(ctx, h, bus.JobFail, api.JobFailCommand{
		ResourceId: h.resourceID, JobId: h.jobID, JobType: h.jobType, Attempt: h.attempt(), AnnotationId: h.anchor(),
		Error: message, CompletedUnits: statedUnits(failure.CompletedUnits), UnitCursors: stated(failure.UnitCursors),
		FailureClass: failure.FailureClass, WillRetry: &willRetry, Durability: notEstablished,
	})
}

// Cancel settles the job: job:cancel, once the work has stopped for a
// cancellation, with the units it finished and the furthest each unit begun
// got, a finished unit's cursor where it ended; nil for none stated. The
// message is the command's own fields and no more: it names no attempt.
func (h *heldJob) Cancel(ctx context.Context, completedUnits []string, unitCursors map[string]api.UnitCursor) error {
	if err := h.settling(bus.JobCancel.Channel()); err != nil {
		return err
	}
	defer h.released(false)
	return say(ctx, h, bus.JobCancel, api.JobCancelCommand{
		ResourceId: h.resourceID, JobId: h.jobID, JobType: h.jobType, AnnotationId: h.anchor(),
		CompletedUnits: statedUnits(completedUnits), UnitCursors: stated(unitCursors),
	})
}

// failFor fails the job for a reason that is not the work's, unless it is
// settled already. The failure states no class, so the record's retry budget
// decides what becomes of the job. One that cannot be said is not said: the
// job is released, and the dispatcher's sweep concludes it.
func (h *heldJob) failFor(ctx context.Context, reason string) {
	if h.Settled() {
		return
	}
	_ = h.Fail(ctx, reason, JobFailure{})
}

// HeldMarkJob is a mark job this worker holds, from its claim until it
// settles it. Each settle says the outcome and releases the job together; a
// second is refused. A settle the gateway did not take still releases the
// job, and fails.
type HeldMarkJob struct {
	heldJob
}

// Complete settles the job: job:complete, with what a mark job reports, and
// how its commits were established.
func (j *HeldMarkJob) Complete(ctx context.Context, result api.MarkJobResult) error {
	if err := j.settling(bus.JobComplete.Channel()); err != nil {
		return err
	}
	defer j.released(true)
	var completed api.JobCompleteCommand
	if err := completed.FromMarkJobCompleteCommand(api.MarkJobCompleteCommand{
		ResourceId: j.resourceID, JobId: j.jobID, JobType: api.MarkJobCompleteCommandJobTypeMark, Attempt: j.attempt(),
		Result: &result, Durability: j.observed(),
	}); err != nil {
		return err
	}
	return say(ctx, &j.heldJob, bus.JobComplete, completed)
}

// HeldYieldJob is a yield job this worker holds, from its claim until it
// settles it. Each settle says the outcome and releases the job together; a
// second is refused. A settle the gateway did not take still releases the
// job, and fails.
type HeldYieldJob struct {
	heldJob
}

// Complete settles the job: job:complete, with what a yield job reports, and
// how its commits were established.
func (j *HeldYieldJob) Complete(ctx context.Context, result api.YieldJobResult) error {
	if err := j.settling(bus.JobComplete.Channel()); err != nil {
		return err
	}
	defer j.released(true)
	var completed api.JobCompleteCommand
	if err := completed.FromYieldJobCompleteCommand(api.YieldJobCompleteCommand{
		ResourceId: j.resourceID, JobId: j.jobID, JobType: api.YieldJobCompleteCommandJobTypeYield, Attempt: j.attempt(),
		AnnotationId: j.anchor(), Result: &result, Durability: j.observed(),
	}); err != nil {
		return err
	}
	return say(ctx, &j.heldJob, bus.JobComplete, completed)
}

// anchorOf is the annotation a job is anchored to: the one a yield job's
// context is focused on. A yield job focused on a resource has none, and
// neither has a mark job.
func anchorOf(jobType api.JobType, params api.JobParams) api.AnnotationId {
	if jobType != api.JobTypeYield {
		return api.AnnotationId{}
	}
	encoded, err := params.MarshalJSON()
	if err != nil {
		return api.AnnotationId{}
	}
	var stated struct {
		Context *struct {
			Focus *struct {
				Kind       string `json:"kind"`
				Annotation *struct {
					ID json.RawMessage `json:"id"`
				} `json:"annotation"`
			} `json:"focus"`
		} `json:"context"`
	}
	if json.Unmarshal(encoded, &stated) != nil || stated.Context == nil || stated.Context.Focus == nil {
		return api.AnnotationId{}
	}
	focus := stated.Context.Focus
	if focus.Kind != "annotation" || focus.Annotation == nil {
		return api.AnnotationId{}
	}
	var named string
	if json.Unmarshal(focus.Annotation.ID, &named) != nil {
		return api.AnnotationId{}
	}
	anchored, err := api.ParseAnnotationId(named)
	if err != nil {
		return api.AnnotationId{}
	}
	return anchored
}

// handedOut is what the claims hand out next: a job, or a refusal.
type handedOut struct {
	job     HeldJob
	refusal *ClaimRefusal
}

// Claims is a worker's claims, from Job.Claim: each job the worker comes to
// hold, one at a time, and each claim it was refused. They are ranged over
// (All). The next job is claimed when the one held is settled, and a refusal
// does not end the claims: the worker waits for its next idle moment, and
// what the refusal means is its host's to judge. Claiming begins when the
// claims are first ranged over. It ends when Close is called, when the
// transport's stream ends, or when the client closes; a job still held when
// Close stops it is failed first.
type Claims struct {
	links   *links
	accepts []api.JobFilter
	// filters is each filter as the wire carries it, which is what an
	// announcement is compared with.
	filters []any
	// filtersErr is why the filters could not be read, which refuses the
	// claims when they are first ranged over.
	filtersErr error
	handed     *queue[handedOut]
	stall      *Variable[*HeldJobStall]
	// life is the claims': done once they have ended. What watches for an
	// idle moment runs in it; a claim in flight does not, and is left to be
	// answered.
	life context.Context
	end  context.CancelFunc
	work sync.WaitGroup

	mu       sync.Mutex
	begun    bool
	beginErr error
	stopped  bool
	held     *heldJob
	// The loop's two bits: one claim in flight at a time, and a wake-up that
	// arrived during it, honoured with exactly one more claim.
	claiming      bool
	wakePending   bool
	stallReported bool
	// Each by the clock a silence is measured on; zero until it happens.
	lastQueuedEventAt time.Time
	lastClaimAt       time.Time
	lastFinishedAt    time.Time
	lastActivityAt    time.Time
	heldSince         time.Time
	jobsCompleted     int
}

func newClaims(l *links, accepts []api.JobFilter) *Claims {
	life, end := context.WithCancel(l.life)
	c := &Claims{
		links:   l,
		accepts: slices.Clone(accepts),
		handed:  newQueue[handedOut](),
		stall:   NewVariable[*HeldJobStall](nil),
		life:    life,
		end:     end,
	}
	if c.accepts == nil {
		c.accepts = []api.JobFilter{}
	}
	// The client's closing ends the claims, and so whoever ranges over them:
	// nothing can be claimed for a client that is gone.
	context.AfterFunc(life, c.stop)
	for _, accepted := range c.accepts {
		encoded, err := accepted.MarshalJSON()
		var filter any
		if err == nil {
			err = json.Unmarshal(encoded, &filter)
		}
		if err != nil {
			c.filtersErr = fmt.Errorf("a filter of the claims does not read: %w", err)
			break
		}
		c.filters = append(c.filters, filter)
	}
	return c
}

// All is the claims as they are ranged over: each job the worker comes to
// hold, or, as its error, a claim that was refused. Ranging it the first time
// begins claiming; the sequence ends when the claims do. A transport whose
// stream does not name JobClaimChannels cannot carry a worker's claims, and is
// refused as unsubscribed.
func (c *Claims) All() iter.Seq2[HeldJob, error] {
	return func(yield func(HeldJob, error) bool) {
		if err := c.begin(); err != nil {
			yield(nil, err)
			return
		}
		for {
			item, ok := c.handed.next(nil)
			if !ok {
				return
			}
			if item.refusal != nil {
				if !yield(nil, item.refusal) {
					return
				}
				continue
			}
			// Claimed, and failed by the worker's stop before anybody read it.
			if item.job.Settled() {
				continue
			}
			if !yield(item.job, nil) {
				return
			}
		}
	}
}

// Vitals is what this worker can say of itself now.
func (c *Claims) Vitals() WorkerVitals {
	c.mu.Lock()
	defer c.mu.Unlock()
	vitals := WorkerVitals{
		LastQueuedEventAt: utc(c.lastQueuedEventAt),
		LastClaimAt:       utc(c.lastClaimAt),
		LastFinishedAt:    utc(c.lastFinishedAt),
		LastActivityAt:    utc(c.lastActivityAt),
		JobsCompleted:     c.jobsCompleted,
	}
	if c.held != nil && !c.heldSince.IsZero() {
		vitals.ActiveJob = &ActiveJob{JobId: c.held.jobID, JobType: c.held.jobType, Since: utc(c.heldSince)}
	}
	return vitals
}

// utc is t in UTC; the zero time stays the zero time.
func utc(t time.Time) time.Time {
	if t.IsZero() {
		return t
	}
	return t.UTC()
}

// Stalled is the last stall found: a held job that has shown no activity for
// the client's HeldJobStall, reported once. Nil until there is one, and each
// one after is a change, until the claims end.
func (c *Claims) Stalled() Watched[*HeldJobStall] {
	return ending[*HeldJobStall]{c.stall, c.life}
}

// Close stops claiming. A job still held is failed first, and Close returns
// once that has been said, or could not be. A claim in flight is waited for,
// up to its timeout: a job it is answered with is failed too. Closing twice is
// closing once.
func (c *Claims) Close() {
	c.mu.Lock()
	held := c.held
	c.mu.Unlock()
	c.stop()
	if held != nil {
		held.failFor(c.links.life, stoppedWhileHeld)
	}
	c.work.Wait()
}

// stop ends the claims: nothing more is claimed or handed out, and what
// watched for an idle moment stops watching.
func (c *Claims) stop() {
	c.mu.Lock()
	if c.stopped {
		c.mu.Unlock()
		return
	}
	c.stopped = true
	c.mu.Unlock()
	c.handed.close()
	c.end()
}

// spawn runs work as the claims'. It is called with c.mu held, before the
// claims have stopped, so Close waits for it.
func (c *Claims) spawn(work func()) {
	c.work.Add(1)
	go func() {
		defer c.work.Done()
		work()
	}()
}

func (c *Claims) begin() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.begun {
		return c.beginErr
	}
	c.begun = true
	if c.filtersErr != nil {
		c.beginErr = c.filtersErr
		return c.beginErr
	}
	var unnamed []string
	for _, channel := range JobClaimChannels {
		if !c.links.transport.IsSubscribed(channel) {
			unnamed = append(unnamed, string(channel))
		}
	}
	if len(unnamed) > 0 {
		c.beginErr = &BusRequestError{
			Code: BusRequestErrorCodeUnsubscribed,
			Message: fmt.Sprintf("This transport's stream does not name %s: a worker on it would never be answered, woken or told of a cancellation. Give the transport JobClaimChannels.",
				strings.Join(unnamed, ", ")),
		}
		return c.beginErr
	}
	if c.stopped {
		return nil
	}
	// Both broadcasts are read from the transport, as the stream delivers
	// them, and not as this SDK types them: the comparison of an announcement
	// with a filter knows no field by name, so a job this SDK cannot type
	// still wakes a worker whose claim it matches. What the client's own
	// parts say to each other wakes no worker.
	frames, err := c.links.transport.Frames(c.life, bus.JobQueued.Channel(), bus.JobCancelRequested.Request().Channel())
	if err != nil {
		c.beginErr = err
		return c.beginErr
	}
	c.spawn(func() { c.hear(frames) })
	c.spawn(c.watchTheStream)
	c.spawn(c.lookForStalls)
	return nil
}

// hear reads the announcements and the cancellations as the transport
// delivers them. The transport's closing ends the claims: nothing more can be
// claimed.
func (c *Claims) hear(frames iter.Seq[Frame]) {
	for frame := range frames {
		if frame.Channel == bus.JobQueued.Channel() {
			c.announced(frame)
		} else {
			c.cancellation(frame)
		}
	}
	c.stop()
}

// announced is a job:queued. Every announcement received is stamped, before
// any filtering.
func (c *Claims) announced(frame Frame) {
	c.mu.Lock()
	c.lastQueuedEventAt = time.Now()
	c.mu.Unlock()
	var job any
	if json.Unmarshal(frame.Payload, &job) != nil {
		return
	}
	for _, filter := range c.filters {
		if JobMatchesFilter(filter, job) {
			c.mu.Lock()
			c.pull()
			c.mu.Unlock()
			return
		}
	}
}

// cancellation is a job:cancel-requested. It is the held job's only when it
// names it, and one that arrives after the settle signals nothing.
func (c *Claims) cancellation(frame Frame) {
	var named struct {
		JobID string `json:"jobId"`
	}
	if json.Unmarshal(frame.Payload, &named) != nil {
		return
	}
	c.mu.Lock()
	held := c.held
	c.mu.Unlock()
	if held != nil && !held.Settled() && named.JobID == held.jobID.String() {
		held.cancelled.Set(true)
	}
}

// watchTheStream claims when the stream opens: the first observation decides
// whether the first claim is made now or waits for the stream to open (a
// claim on a closed stream would only be refused here), and every change to
// open after it claims. A closed transport ends the claims.
func (c *Claims) watchTheStream() {
	first, wasOpen := true, false
	for state := range c.links.transport.State().Changes(c.life) {
		open := state == ConnectionStateOpen
		if open && (first || !wasOpen) {
			c.mu.Lock()
			c.pull()
			c.mu.Unlock()
		}
		if state == ConnectionStateClosed {
			c.stop()
			return
		}
		first, wasOpen = false, open
	}
}

// lookForStalls looks at the held job every HeldJobStallCheck, and reports
// one that has shown no activity for longer than HeldJobStall, once.
func (c *Claims) lookForStalls() {
	timing := c.links.timing
	ticker := time.NewTicker(timing.HeldJobStallCheck)
	defer ticker.Stop()
	for {
		select {
		case <-c.life.Done():
			return
		case <-ticker.C:
		}
		c.mu.Lock()
		held := c.held
		if held == nil || c.stallReported || c.lastActivityAt.IsZero() || c.heldSince.IsZero() {
			c.mu.Unlock()
			continue
		}
		silentFor := time.Since(c.lastActivityAt)
		if silentFor <= timing.HeldJobStall {
			c.mu.Unlock()
			continue
		}
		c.stallReported = true
		stall := &HeldJobStall{
			JobId: held.jobID, JobType: held.jobType, HeldSince: utc(c.heldSince), LastActivityAt: utc(c.lastActivityAt),
			SilentFor: silentFor, Threshold: timing.HeldJobStall,
		}
		c.mu.Unlock()
		c.stall.Set(stall)
	}
}

// active is the work showing it is alive.
func (c *Claims) active() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.lastActivityAt = time.Now()
}

// released is job, settled and no longer held: whether it was completed. The
// settle is an idle moment.
func (c *Claims) released(job *heldJob, completed bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.held != job {
		return
	}
	now := time.Now()
	c.lastActivityAt, c.lastFinishedAt = now, now
	c.held = nil
	c.heldSince = time.Time{}
	if completed {
		c.jobsCompleted++
	}
	c.pull()
}

// pull is one idle moment: ask once, or remember that we were asked to. It is
// called with c.mu held.
func (c *Claims) pull() {
	if c.stopped || c.held != nil {
		// Holding a job: the settle claims. Nothing to remember.
		return
	}
	if c.claiming {
		c.wakePending = true
		return
	}
	c.claiming, c.wakePending = true, false
	c.spawn(c.claim)
}

func (c *Claims) claim() {
	job, refusal := c.claimNext()
	c.mu.Lock()
	c.claiming = false
	if c.stopped {
		c.mu.Unlock()
		// Answered after the worker stopped: the job is this worker's at the
		// dispatcher, and nobody here will run it.
		if job != nil {
			job.held().failFor(c.links.life, stoppedWhileHeld)
		}
		return
	}
	if job != nil {
		now := time.Now()
		c.lastActivityAt, c.lastClaimAt, c.heldSince = now, now, now
		c.stallReported = false
		// A wake-up that arrived during the claim is moot: the settle claims.
		c.wakePending = false
		c.held = job.held()
		c.mu.Unlock()
		c.handed.push(handedOut{job: job})
		return
	}
	if refusal != nil {
		c.handed.push(handedOut{refusal: refusal})
	}
	if c.wakePending {
		c.wakePending = false
		c.pull()
	}
	c.mu.Unlock()
}

// claimNext asks once: the job claimed, the refusal, or neither when nothing
// is pending. A claim names fields of the job description, never a job id. A
// reply that does not read as a claimed job is refused here and never run
// (WORKER-CONTRACT C9): it names no job id, no job type or no parameters.
//
// The claim is made in no trace: it runs in the client's life, never in the
// context of whatever settled the job before it.
func (c *Claims) claimNext() (HeldJob, *ClaimRefusal) {
	life := c.links.life
	answer, err := claimed(life, c.links, c.accepts)
	if err != nil {
		if life.Err() != nil {
			// The client closed: nobody is left to claim for.
			return nil, nil
		}
		var refused *BusRequestError
		if errors.As(err, &refused) {
			if refused.Code == BusRequestErrorCodeNonePending {
				return nil, nil
			}
			code := refused.Code
			return nil, &ClaimRefusal{Code: &code, Message: refused.Message}
		}
		return nil, &ClaimRefusal{Message: err.Error()}
	}
	running := answer.Payload.Response
	unread := func(lacking string) *ClaimRefusal {
		return &ClaimRefusal{Message: fmt.Sprintf("a payload on %s is not that channel's: it names no %s", bus.JobClaim.Result().Channel(), lacking)}
	}
	switch {
	case running.Metadata.Id.IsZero():
		return nil, unread("job id")
	case running.Metadata.Type != api.JobTypeMark && running.Metadata.Type != api.JobTypeYield:
		return nil, unread("job type")
	case running.Params.ResourceId.IsZero():
		return nil, unread("parameters")
	}
	// The verb's handle is made first, and its job filled in place: a held
	// job holds a lock, and is never copied.
	var job HeldJob
	var held *heldJob
	if running.Metadata.Type == api.JobTypeMark {
		mark := &HeldMarkJob{}
		job, held = mark, &mark.heldJob
	} else {
		yield := &HeldYieldJob{}
		job, held = yield, &yield.heldJob
	}
	held.claims = c
	held.trace = answer.Trace
	held.jobID = running.Metadata.Id
	held.jobType = running.Metadata.Type
	held.resourceID = running.Params.ResourceId
	held.params = running.Params
	held.retryCount = running.Metadata.RetryCount
	held.maxRetries = running.Metadata.MaxRetries
	held.annotationID = anchorOf(running.Metadata.Type, running.Params)
	held.cancelled = NewVariable(false)
	held.over, held.end = context.WithCancel(context.Background())
	// Both appear on the record once an attempt has checkpointed. Absent, each reads as none.
	held.completedUnits = []string{}
	if units := running.Metadata.CompletedUnits; units != nil {
		held.completedUnits = slices.Clone(*units)
	}
	held.unitCursors = map[string]api.UnitCursor{}
	if cursors := running.Metadata.UnitCursors; cursors != nil {
		held.unitCursors = maps.Clone(*cursors)
	}
	return job, nil
}

// claimed is a claim of what accepts describes, as far as the frame that
// answers it on its result channel: its payload, and the trace it arrived in.
func claimed(ctx context.Context, l *links, accepts []api.JobFilter) (Delivered[api.JobClaimedResult], error) {
	object, err := payloadOf(api.JobClaimCommand{Accepts: accepts})
	if err != nil {
		return Delivered[api.JobClaimedResult]{}, err
	}
	reply, err := l.wire.result(ctx, bus.JobClaim.Request().Channel(), object, l.timing.JobClaimTimeout, nil)
	if err != nil {
		return Delivered[api.JobClaimedResult]{}, err
	}
	return delivered[api.JobClaimedResult](reply)
}
