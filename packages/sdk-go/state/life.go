package state

import (
	"context"
	"errors"
	"iter"
	"sync"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go"
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
}

func newLife() life {
	alive, end := context.WithCancel(context.Background())
	return life{alive: alive, end: end}
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
