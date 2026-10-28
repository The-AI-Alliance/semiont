package semionttest

// The state-unit axioms, executable.
//
// AssertStateUnitAxioms runs each axiom against fresh units the subject
// builds, and fails the test, naming the axiom, on the first one a unit
// breaks. One call per state unit, from that unit's tests; a program's own
// units are held to them the same way.
//
//   - A5 Close is idempotent and total: any number of calls, none panics, and
//     none closes what the unit was given.
//   - A5b the unit is inert after Close: its methods do nothing, and a surface
//     taken afterwards gives at most the value it held, and has ended.
//   - A6 every reader of a surface taken before Close sees it end.
//   - A7-passed closing the unit does not close a dependency it was given: a
//     CloseProbe standing in for one, or the client itself (TheClient).
//   - A7-owned closing the unit ends the surfaces of the children it made.
//   - X1 no surface is a writer: a unit hands out a read-only view of each
//     state, never the semiont.Variable that holds it.
//   - X3 instances are isolated: driving one never moves another's surfaces.
//
// Each case runs in a testing/synctest bubble of its own, and the subject
// builds the unit inside it. Before the harness looks, it lets everything in
// the bubble run until nothing more can (synctest.Wait), so a unit that acts
// on a goroutine of its own has acted on what the harness did. No axiom moves
// the clock.

import (
	"context"
	"fmt"
	"iter"
	"math/rand/v2"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
)

// Given is a dependency a unit was given, as the axioms watch it.
type Given interface {
	// Closed reports whether anything has closed it.
	Closed() bool
}

// CloseProbe stands in for a dependency a unit is given. Pass one to the unit
// and to Fresh.With, and the axioms check the unit never closed it.
type CloseProbe struct {
	closes atomic.Int64
}

var (
	_ semiont.StateUnit = (*CloseProbe)(nil)
	_ Given             = (*CloseProbe)(nil)
)

func (p *CloseProbe) Close() { p.closes.Add(1) }

// Closes is how many times it was closed.
func (p *CloseProbe) Closes() int { return int(p.closes.Load()) }

func (p *CloseProbe) Closed() bool { return p.Closes() > 0 }

// theClient is a client as a dependency: closed once its own bus has ended,
// which closing the client does.
type theClient struct {
	ended chan struct{}
}

// TheClient is c as a dependency a unit was given. Call it where the unit is
// built, inside the case's bubble.
func TheClient(c *semiont.Client) Given {
	given := theClient{ended: make(chan struct{})}
	go func() {
		// A reader of no channel is given nothing, and ends when the bus does.
		for range c.Bus.FramesAmong(context.Background()) {
		}
		close(given.ended)
	}()
	return given
}

func (g theClient) Closed() bool {
	select {
	case <-g.ended:
		return true
	default:
		return false
	}
}

// Fresh is a freshly built unit, and what it was given.
type Fresh[U semiont.StateUnit] struct {
	Unit  U
	Given []Given
}

// With is the same, with one more dependency the unit was given.
func (f Fresh[U]) With(dependency Given) Fresh[U] {
	return Fresh[U]{Unit: f.Unit, Given: append(slices.Clone(f.Given), dependency)}
}

// Surface is one reader of a surface a unit hands out, as the axioms read it:
// a state (Watching), or a sequence of events (Events, EventPairs).
type Surface struct {
	read   func(ctx context.Context) iter.Seq[struct{}]
	writer bool
}

// Watching is a reader of a state a unit hands out. One the unit could be
// written through (a semiont.Variable) breaks X1.
func Watching[T any](watched semiont.Watched[T]) Surface {
	_, writes := watched.(interface{ Set(T) })
	return Surface{writer: writes, read: func(ctx context.Context) iter.Seq[struct{}] { return each(watched.Changes(ctx)) }}
}

// Events is a reader of a sequence of events a unit hands out, read from the
// moment read is called, until ctx is done.
func Events[T any](read func(ctx context.Context) iter.Seq[T]) Surface {
	return Surface{read: func(ctx context.Context) iter.Seq[struct{}] { return each(read(ctx)) }}
}

// EventPairs is Events, of a sequence of pairs: an event and the failure in
// its place.
func EventPairs[K, V any](read func(ctx context.Context) iter.Seq2[K, V]) Surface {
	return Surface{read: func(ctx context.Context) iter.Seq[struct{}] {
		return func(yield func(struct{}) bool) {
			for range read(ctx) {
				if !yield(struct{}{}) {
					return
				}
			}
		}
	}}
}

func each[T any](items iter.Seq[T]) iter.Seq[struct{}] {
	return func(yield func(struct{}) bool) {
		for range items {
			if !yield(struct{}{}) {
				return
			}
		}
	}
}

// AxiomSubject is how the axioms reach one kind of state unit. Only Setup is
// required. A means left nil is none: a unit with no surface is held to no
// axiom about one.
type AxiomSubject[U semiont.StateUnit] struct {
	// Setup builds a fresh unit, independent of every other one. It is called
	// inside the case's bubble; what it opens beside the unit (a client, its
	// transport) it closes by t.Cleanup, which runs in the bubble.
	Setup func(t *testing.T) Fresh[U]
	// Surfaces is a new reader of each surface the unit hands out.
	Surfaces func(unit U) []Surface
	// Invocations is each of the unit's methods, as a call with no arguments.
	Invocations func(unit U) []func()
	// OwnedChildSurfaces is a new reader of each surface of the children the
	// unit made itself.
	OwnedChildSurfaces func(unit U) []Surface
}

func (s AxiomSubject[U]) surfaces(unit U) []Surface {
	if s.Surfaces == nil {
		return nil
	}
	return s.Surfaces(unit)
}

func (s AxiomSubject[U]) invocations(unit U) []func() {
	if s.Invocations == nil {
		return nil
	}
	return s.Invocations(unit)
}

func (s AxiomSubject[U]) ownedChildSurfaces(unit U) []Surface {
	if s.OwnedChildSurfaces == nil {
		return nil
	}
	return s.OwnedChildSurfaces(unit)
}

// reader is one reader of a surface, as the axioms watch it: how much it was
// given since last asked, and whether it has ended.
type reader struct {
	mu     sync.Mutex
	given  int
	taken  int
	ending bool
}

// readerOf reads surface on a goroutine of the bubble's, until it ends or
// the case is over.
func readerOf(t *testing.T, surface Surface) *reader {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	r := &reader{}
	go func() {
		for range surface.read(ctx) {
			r.mu.Lock()
			r.given++
			r.mu.Unlock()
		}
		r.mu.Lock()
		r.ending = true
		r.mu.Unlock()
	}()
	return r
}

// drained takes everything there is now, once everything that can run has.
// It returns how much there was.
func (r *reader) drained() int {
	synctest.Wait()
	r.mu.Lock()
	defer r.mu.Unlock()
	taken := r.given - r.taken
	r.taken = r.given
	return taken
}

func (r *reader) moved() bool { return r.drained() > 0 }

func (r *reader) ended() bool {
	synctest.Wait()
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.ending
}

func undisposed[U semiont.StateUnit](fresh Fresh[U], when string) string {
	for number, dependency := range fresh.Given {
		if dependency.Closed() {
			return fmt.Sprintf("the unit closed dependency #%d it was given %s", number, when)
		}
	}
	return ""
}

func drive(invocations []func(), calls []int) {
	for _, call := range calls {
		if len(invocations) == 0 {
			return
		}
		invocations[call%len(invocations)]()
	}
}

// caseOf runs one case of axiom in a bubble of its own, failing t with what
// the case says was broken.
func caseOf(t *testing.T, axiom string, run func(t *testing.T) string) {
	t.Helper()
	synctest.Test(t, func(t *testing.T) {
		if violation := run(t); violation != "" {
			t.Errorf("%s: %s", axiom, violation)
		}
	})
}

// draws is n lists of calls, each of at least least and at most most calls,
// the same lists every run.
func draws(n, least, most int) [][]int {
	random := rand.New(rand.NewPCG(5, 7))
	lists := make([][]int, n)
	for i := range lists {
		calls := make([]int, least+random.IntN(most-least+1))
		for j := range calls {
			calls[j] = random.IntN(1000)
		}
		lists[i] = calls
	}
	return lists
}

// AssertStateUnitAxioms runs every axiom the subject gives the means to
// check, and fails t naming the first axiom broken, and how.
func AssertStateUnitAxioms[U semiont.StateUnit](t *testing.T, subject AxiomSubject[U]) {
	t.Helper()
	steps := []func(){
		func() {
			caseOf(t, "A7-passed", func(t *testing.T) string {
				fresh := subject.Setup(t)
				fresh.Unit.Close()
				synctest.Wait()
				return undisposed(fresh, "(it does not own it)")
			})
		},
		func() {
			for _, closes := range []int{1, 2, 3, 20} {
				caseOf(t, "A5", func(t *testing.T) string {
					fresh := subject.Setup(t)
					for range closes {
						fresh.Unit.Close()
					}
					synctest.Wait()
					return undisposed(fresh, fmt.Sprintf("under %d Close calls", closes))
				})
			}
		},
		func() {
			for _, readersEach := range []int{1, 2, 10} {
				caseOf(t, "A6", func(t *testing.T) string {
					fresh := subject.Setup(t)
					var readers []*reader
					for range readersEach {
						for _, surface := range subject.surfaces(fresh.Unit) {
							readers = append(readers, readerOf(t, surface))
						}
					}
					for _, r := range readers {
						r.drained()
					}
					fresh.Unit.Close()
					for number, r := range readers {
						if !r.ended() {
							return fmt.Sprintf("reader #%d of a surface did not see it end on Close (%d readers each)", number, readersEach)
						}
					}
					return ""
				})
			}
		},
		func() {
			for _, calls := range draws(10, 0, 12) {
				caseOf(t, "A5b", func(t *testing.T) string {
					fresh := subject.Setup(t)
					fresh.Unit.Close()
					drive(subject.invocations(fresh.Unit), calls)
					synctest.Wait()
					for number, surface := range subject.surfaces(fresh.Unit) {
						r := readerOf(t, surface)
						if given := r.drained(); given > 1 {
							return fmt.Sprintf("surface #%d, taken after Close, gave %d values: more than the one it held", number, given)
						}
						if !r.ended() {
							return fmt.Sprintf("surface #%d, taken after Close, has not ended", number)
						}
					}
					return ""
				})
			}
		},
		func() {
			for _, calls := range draws(10, 1, 8) {
				caseOf(t, "X3", func(t *testing.T) string {
					one, other := subject.Setup(t), subject.Setup(t)
					var watched []*reader
					for _, surface := range subject.surfaces(other.Unit) {
						watched = append(watched, readerOf(t, surface))
					}
					for _, r := range watched {
						r.drained()
					}
					drive(subject.invocations(one.Unit), calls)
					synctest.Wait()
					moved := -1
					for number, r := range watched {
						if r.moved() && moved < 0 {
							moved = number
						}
					}
					one.Unit.Close()
					other.Unit.Close()
					if moved >= 0 {
						return fmt.Sprintf("driving one instance moved surface #%d of another", moved)
					}
					return ""
				})
			}
		},
		func() {
			caseOf(t, "A7-owned", func(t *testing.T) string {
				fresh := subject.Setup(t)
				var children []*reader
				for _, surface := range subject.ownedChildSurfaces(fresh.Unit) {
					children = append(children, readerOf(t, surface))
				}
				for _, r := range children {
					r.drained()
				}
				fresh.Unit.Close()
				for number, r := range children {
					if !r.ended() {
						return fmt.Sprintf("the surface #%d of a child the unit made did not end when the unit was closed", number)
					}
				}
				return ""
			})
		},
		func() {
			caseOf(t, "X1", func(t *testing.T) string {
				fresh := subject.Setup(t)
				defer fresh.Unit.Close()
				for number, surface := range subject.surfaces(fresh.Unit) {
					if surface.writer {
						return fmt.Sprintf("surface #%d is the Variable that holds the state, which a reader could write", number)
					}
				}
				return ""
			})
		},
	}
	for _, step := range steps {
		step()
		// The first axiom broken is the one named.
		if t.Failed() {
			return
		}
	}
}
