package semiont

// A long-running operation: what it reports as it goes, then its final
// value.

import (
	"context"
	"errors"
	"iter"
	"sync/atomic"
)

// Running is a long-running operation, consumed one of two ways, once:
//
//   - waited for (Wait), it gives the final value;
//   - ranged over (Events), it gives every report and then the final value,
//     and ends. A failure is given where the final value would have been.
//
// Nothing is sent until it is first waited for or ranged over. Its caller
// abandons it by cancelling Wait's context or by stopping the loop: what was
// sent stays sent, and nothing more is. Work the client's closing ends, while
// its caller still waits, fails as closed.
type Running[T any] struct {
	links *links
	// work does the operation: it reports through report, which it calls
	// from the goroutine that runs it, and returns the final value.
	work  func(ctx context.Context, report func(T)) (T, error)
	taken atomic.Bool
}

// errTakenTwice is what a second consumer of a running operation is given.
var errTakenTwice = errors.New("a running operation is waited for or ranged over once")

// Wait does the operation and gives its final value.
func (r *Running[T]) Wait(ctx context.Context) (T, error) {
	if !r.taken.CompareAndSwap(false, true) {
		var none T
		return none, errTakenTwice
	}
	inner, stop := r.links.within(ctx)
	defer stop()
	value, err := r.work(inner, func(T) {})
	return value, r.links.closedUnder(ctx, err)
}

// Events does the operation as it is ranged over: every report, then the
// final value, or the failure where it would have been.
func (r *Running[T]) Events() iter.Seq2[T, error] {
	return func(yield func(T, error) bool) {
		if !r.taken.CompareAndSwap(false, true) {
			var none T
			yield(none, errTakenTwice)
			return
		}
		caller := context.Background()
		inner, stop := r.links.within(caller)
		defer stop()
		reading := true
		value, err := r.work(inner, func(report T) {
			if reading {
				reading = yield(report, nil)
				if !reading {
					stop()
				}
			}
		})
		if reading {
			yield(value, r.links.closedUnder(caller, err))
		}
	}
}
