package state

import (
	"context"
	"errors"
	"iter"
	"sync"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
)

// life is a unit's: whether it is closed, and the context its work runs
// under, done once it is. mu is held while the unit changes what it holds,
// so a change of several states, and a test of one before it is changed,
// are one step.
type life struct {
	mu     sync.Mutex
	closed bool
	alive  context.Context
	end    context.CancelFunc
	// lastRun is done once the job the unit asked for last has had its
	// creation answered, or its run has ended.
	lastRun <-chan struct{}
}

func newLife() life {
	alive, end := context.WithCancel(context.Background())
	none := make(chan struct{})
	close(none)
	return life{alive: alive, end: end, lastRun: none}
}

// nextRun is the place of a job's run begun now. The run asks for its job
// once before is done, and calls answered once the job's creation is answered
// or the run has ended. So the jobs a unit asks for are asked for in the
// order their runs began, which the goroutines the runs read on do not keep.
// Called with mu held.
func (l *life) nextRun() (before <-chan struct{}, answered func()) {
	before = l.lastRun
	mine := make(chan struct{})
	l.lastRun = mine
	var once sync.Once
	return before, func() { once.Do(func() { close(mine) }) }
}

// inTurn waits for before: true once it is done, false when the unit closed
// first.
func (l *life) inTurn(before <-chan struct{}) bool {
	select {
	case <-before:
		return true
	case <-l.alive.Done():
		return false
	}
}

// close marks the unit closed and stops its work, and reports whether it was
// open. Called with mu held.
func (l *life) close() bool {
	if l.closed {
		return false
	}
	l.closed = true
	l.end()
	return true
}

// listen hands heard each frame of frames, in order, on a goroutine of its
// own, until the unit is closed. heard is called with mu held, and not once
// the unit is closed.
func (l *life) listen(frames iter.Seq[semiont.Frame], heard func(semiont.Frame)) {
	go func() {
		for frame := range frames {
			l.mu.Lock()
			if l.closed {
				l.mu.Unlock()
				return
			}
			heard(frame)
			l.mu.Unlock()
		}
	}()
}

// cancelled reports whether a job ended because it was cancelled: its
// commits stand, and its display stays to say so.
func cancelled(err error) bool {
	var ended *semiont.JobError
	return errors.As(err, &ended) && ended.Code == semiont.JobErrorCodeCancelled
}
