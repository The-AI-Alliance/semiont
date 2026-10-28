package state

// Generation, as state: whether a resource is being generated, the job's id
// and progress, and what the finished run produced.
//
// The display it feeds stays once the run is over: the progress and the
// outcome are there until they are dismissed, or until the next run begins. A
// cancelled run's progress stays too, though it made nothing. A run that
// fails, or stalls, clears its progress and is no longer generating. Why a
// run ended without a result is held with the rest. A stall is said nowhere
// else.

import (
	"time"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
)

// YieldStateUnit is generation, as state: see the file's documentation. A
// state holding none is nil, or the zero JobId.
type YieldStateUnit struct {
	client *semiont.Client
	locale string
	life

	generating *semiont.Variable[bool]
	progress   *semiont.Variable[*api.JobProgress]
	outcome    *semiont.Variable[*api.YieldJobDone]
	failure    *semiont.Variable[error]
	jobID      *semiont.Variable[api.JobId]
}

var _ semiont.StateUnit = (*YieldStateUnit)(nil)

// NewYieldStateUnit is a unit generating over client. locale is the language
// a generation is written in when its request states none: BCP 47.
func NewYieldStateUnit(client *semiont.Client, locale string) *YieldStateUnit {
	return &YieldStateUnit{
		client:     client,
		locale:     locale,
		life:       newLife(),
		generating: semiont.NewVariable(false),
		progress:   semiont.NewVariable[*api.JobProgress](nil),
		outcome:    semiont.NewVariable[*api.YieldJobDone](nil),
		failure:    semiont.NewVariable[error](nil),
		jobID:      semiont.NewVariable(api.JobId{}),
	}
}

// IsGenerating is whether a run is under way: from its first progress to its
// end.
func (u *YieldStateUnit) IsGenerating() semiont.Watched[bool] { return u.generating.Reading() }

// Progress is the run's progress, and the last run's until it is dismissed.
func (u *YieldStateUnit) Progress() semiont.Watched[*api.JobProgress] { return u.progress.Reading() }

// Outcome is what the last finished run produced; nil while one runs, and
// once dismissed.
func (u *YieldStateUnit) Outcome() semiont.Watched[*api.YieldJobDone] { return u.outcome.Reading() }

// Failure is why the last run ended without a result: it failed, stalled or
// was cancelled. Nil while one runs, after one that completed, and once
// dismissed.
func (u *YieldStateUnit) Failure() semiont.Watched[error] { return u.failure.Reading() }

// JobId is the generation job's id, from the queue's answer to its creation
// to its end: what Job.Cancel names.
func (u *YieldStateUnit) JobId() semiont.Watched[api.JobId] { return u.jobID.Reading() }

// Generate generates a resource from a gathered context, as Yield.Delegate
// does, given stallDeadline as it is. It is written in this unit's locale
// when params states no language. Runs are asked for in the order they are
// begun: a run asks for its job once the run begun before it has had its
// job's creation answered, or has ended.
func (u *YieldStateUnit) Generate(params api.GenerationJobParams, stallDeadline time.Duration) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.closed {
		return
	}
	u.progress.Set(nil)
	u.outcome.Set(nil)
	u.failure.Set(nil)
	u.jobID.Set(api.JobId{})
	if params.Language == nil || *params.Language == "" {
		locale := u.locale
		params.Language = &locale
	}
	before, answered := u.nextRun()
	go u.run(u.client.Yield.Delegate(params, stallDeadline), before, answered)
}

// DismissProgress clears the display of a run: its progress, its outcome and
// why it ended.
func (u *YieldStateUnit) DismissProgress() {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.closed {
		return
	}
	u.progress.Set(nil)
	u.outcome.Set(nil)
	u.failure.Set(nil)
}

// run follows a run to its end, once its turn comes.
func (u *YieldStateUnit) run(run *semiont.Delegation[api.YieldJobCompleteCommand], before <-chan struct{}, answered func()) {
	defer answered()
	if !u.inTurn(before) {
		return
	}
	// This job's id. At the job's end it is let go only while it is still the one held: a run begun later replaces it.
	var created api.JobId
	for event, err := range run.Events(u.alive) {
		// The first event answers the job's creation, or ends the run.
		answered()
		u.mu.Lock()
		if u.closed {
			// Closed while the run goes on: the reading stops, and the delegation is abandoned.
			u.mu.Unlock()
			return
		}
		switch event := event.(type) {
		case semiont.JobCreated:
			u.jobID.Set(event.Data.JobId)
			created = event.Data.JobId
		case semiont.JobProgressed:
			progress := event.Data
			u.progress.Set(&progress)
			u.generating.Set(true)
		case semiont.JobCompleted[api.YieldJobCompleteCommand]:
			if done := generated(event.Data.Result); done != nil {
				u.outcome.Set(done)
			}
		}
		if err != nil {
			// Why it ended is said before the end itself. A cancelled run's progress stays.
			u.failure.Set(err)
			if !cancelled(err) {
				u.progress.Set(nil)
			}
		}
		u.mu.Unlock()
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.closed {
		return
	}
	u.generating.Set(false)
	if !created.IsZero() && u.jobID.Value() == created {
		u.jobID.Set(api.JobId{})
	}
}

// generated is the resource a run's result says it made; nil for a result
// that is none, or a decline. A decline is told by the member only a decline
// carries.
func generated(result *api.YieldJobResult) *api.YieldJobDone {
	if result == nil {
		return nil
	}
	if declined, err := result.AsJobDeclined(); err == nil && declined.Declined == api.JobDeclinedDeclinedTrue {
		return nil
	}
	done, err := result.AsYieldJobDone()
	if err != nil {
		return nil
	}
	return &done
}

// Close ends the unit: the run it was following is abandoned (the job goes
// on), and every state ends. Closing twice is closing once.
func (u *YieldStateUnit) Close() {
	u.mu.Lock()
	defer u.mu.Unlock()
	if !u.close() {
		return
	}
	u.generating.End()
	u.progress.End()
	u.outcome.End()
	u.failure.End()
	u.jobID.End()
}
