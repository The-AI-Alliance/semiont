package semionttest

// The liveness axioms, executable. The state-unit axioms make a unit's
// wrongness detectable; these make silence detectable: under any behaviour of
// the wire, something is eventually delivered.
//
//   - L1 every output says something, a value or a failure, within the
//     bound. Pending forever is the violation.
//   - L2 every awaited path settles within the bound; a request is sent again
//     no more often than its retry budget allows; and one whose last attempt
//     was faulted is either sent again or surfaced, never swallowed.
//   - L3 every event written to a live connection is delivered exactly once,
//     wherever a client-initiated transition (a handoff, a reopening, a
//     change of scope) lands relative to it: a connection is retired by
//     drain, never by abort.
//
// L1 and L2 run a composition against a FaultyTransport over fault schedules.
// L3 runs interleavings of writes and transitions against anything shaped
// like a connection. Each case runs in a testing/synctest bubble of its own,
// whose clock moves the moment nothing in it can run, so a bound of seconds
// costs nothing. The schedules and interleavings drawn are the same every
// run.

import (
	"errors"
	"fmt"
	"math/rand/v2"
	"slices"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

// ── L1, L2 ──────────────────────────────────────────────────────────────

// LivenessScenario is what one fresh run of a composition exposes to the
// axioms.
type LivenessScenario struct {
	// Outputs is one channel per output, closed when the output has said
	// something, a value or a failure (L1).
	Outputs []<-chan struct{}
	// Settlements is one channel per awaited path, closed when it has
	// settled, either way (L2).
	Settlements []<-chan struct{}
}

// LivenessSpec is a composition, and the schedules it is run under.
type LivenessSpec struct {
	// Setup builds a fresh composition over the transport it is given. It is
	// called once per schedule, inside the case's bubble; what it opens it
	// closes by t.Cleanup, which runs before the transport is closed. What it
	// starts must end once the transport has closed: a goroutine still
	// blocked then fails the test as the bubble's deadlock.
	Setup func(t *testing.T, transport *FaultyTransport) LivenessScenario
	// Timeout is the time the composition gives a bus request. The bound is
	// derived from it: (Timeout × (1 + RetryBudget) + the schedule's delays)
	// × 4.
	Timeout time.Duration
	// RetryBudget is how often the composition may send a logical request
	// again.
	RetryBudget int
	// Schedules is the fault schedules to run, one case each (FaultSchedules
	// draws them).
	Schedules [][]FaultAction
	// MakeResponse is what the gateway answers a request no queued response
	// answers, as FaultyConfig.MakeResponse is.
	MakeResponse MakeResponse
}

// FaultActions draws a wire behaviour from random, each as likely as the
// others. A delay is at most 5ms.
func FaultActions(random *rand.Rand) FaultAction {
	switch random.IntN(5) {
	case 0:
		return Deliver{}
	case 1:
		return DropReply{}
	case 2:
		return Delay{For: time.Duration(random.IntN(6)) * time.Millisecond}
	case 3:
		return DuplicateReply{}
	default:
		return RejectEmit{}
	}
}

// FaultSchedules is n fault schedules of one to eight behaviours each, the
// same every run.
func FaultSchedules(n int) [][]FaultAction {
	random := rand.New(rand.NewPCG(5, 7))
	schedules := make([][]FaultAction, n)
	for i := range schedules {
		schedule := make([]FaultAction, 1+random.IntN(8))
		for j := range schedule {
			schedule[j] = FaultActions(random)
		}
		schedules[i] = schedule
	}
	return schedules
}

// described is a schedule as a violation names it.
func described(schedule []FaultAction) string {
	names := make([]string, len(schedule))
	for i, action := range schedule {
		switch action := action.(type) {
		case Deliver:
			names[i] = "deliver"
		case DropReply:
			names[i] = "drop-reply"
		case Delay:
			names[i] = fmt.Sprintf("delay(%d)", action.For.Milliseconds())
		case DuplicateReply:
			names[i] = "duplicate-reply"
		case RejectEmit:
			names[i] = "reject-emit"
		}
	}
	return strings.Join(names, ",")
}

// closedNow reports, for each channel, whether it has been closed.
func closedNow(channels []<-chan struct{}) []bool {
	closed := make([]bool, len(channels))
	for i, channel := range channels {
		select {
		case <-channel:
			closed[i] = true
		default:
		}
	}
	return closed
}

// AssertLivenessAxioms runs L1 and L2 under each of the spec's schedules, and
// gives the first violation: the axiom broken, how, and under which schedule.
// It is nil when every schedule kept them.
func AssertLivenessAxioms(t *testing.T, spec LivenessSpec) error {
	if len(spec.Schedules) == 0 {
		return errors.New("the spec states no schedule: a run under none checks nothing")
	}
	for _, schedule := range spec.Schedules {
		var violation error
		synctest.Test(t, func(t *testing.T) {
			transport := NewFaultyTransport(FaultyConfig{Schedule: schedule, MakeResponse: spec.MakeResponse})
			t.Cleanup(transport.Close)
			scenario := spec.Setup(t, transport)
			var delays time.Duration
			for _, action := range schedule {
				if delay, ok := action.(Delay); ok {
					delays += delay.For
				}
			}
			bound := (spec.Timeout*time.Duration(1+spec.RetryBudget) + delays) * 4
			time.Sleep(bound)
			violation = livenessViolation(spec.RetryBudget, bound, schedule, scenario, transport.RequestLog())
		})
		if violation != nil {
			return violation
		}
	}
	return nil
}

// issue is one logical request: how often it was sent, and whether its last
// attempt was faulted.
type issue struct {
	sent        int
	lastFaulted bool
}

// livenessViolation is what a run broke, or nil.
func livenessViolation(retryBudget int, bound time.Duration, schedule []FaultAction, scenario LivenessScenario, log []RequestLogEntry) error {
	notified, settled := closedNow(scenario.Outputs), closedNow(scenario.Settlements)
	under := fmt.Sprintf("under schedule ⟨%s⟩", described(schedule))
	// L2 first: where it applies it names the mechanism. L1 is the broader
	// net, and would shadow it.
	if i := slices.Index(settled, false); i >= 0 {
		return fmt.Errorf("L2: settlement #%d did not settle within %dms %s", i, bound.Milliseconds(), under)
	}
	var keys []string
	issued := map[string]*issue{}
	for _, entry := range log {
		request, seen := issued[entry.RetryKey]
		if !seen {
			request = &issue{}
			issued[entry.RetryKey] = request
			keys = append(keys, entry.RetryKey)
		}
		_, dropped := entry.Action.(DropReply)
		_, rejected := entry.Action.(RejectEmit)
		request.sent++
		request.lastFaulted = dropped || rejected
	}
	silent := !slices.Contains(notified, true)
	for _, key := range keys {
		request := issued[key]
		if request.sent > 1+retryBudget {
			return fmt.Errorf("L2: request ⟨%s⟩ was sent %d times, past the retry budget (1 + %d) %s", key, request.sent, retryBudget, under)
		}
		if request.lastFaulted && request.sent <= retryBudget && len(notified) > 0 && silent {
			return fmt.Errorf("L2: faulted request ⟨%s⟩ was neither sent again nor surfaced %s: its failure was swallowed", key, under)
		}
	}
	if i := slices.Index(notified, false); i >= 0 {
		return fmt.Errorf("L1: output #%d said nothing within %dms %s: silently pending", i, bound.Milliseconds(), under)
	}
	return nil
}

// ── L3 ──────────────────────────────────────────────────────────────────

// DeliverySubject is something shaped like a connection: it accepts writes
// to whichever connection is live, can be told to change connections, and
// delivers.
type DeliverySubject interface {
	// Write writes the event with this id to the connection that is live now.
	Write(eventID string)
	// Transition makes a client-initiated transition: a handoff, a reopening,
	// a change of scope.
	Transition()
	// Delivered lets whatever is in flight be delivered, then gives the ids
	// delivered, in order.
	Delivered() []string
}

// DeliveryOp is one step of an interleaving: DeliveryOpWrite or
// DeliveryOpTransition.
type DeliveryOp string

const (
	// DeliveryOpWrite writes an event.
	DeliveryOpWrite DeliveryOp = "write"
	// DeliveryOpTransition makes a transition.
	DeliveryOpTransition DeliveryOp = "transition"
)

// DeliveryOps is n interleavings of writes and transitions, of one to longest
// steps each, the same every run. Each has at least one write: a sequence
// that writes nothing checks nothing.
func DeliveryOps(n, longest int) [][]DeliveryOp {
	random := rand.New(rand.NewPCG(5, 7))
	steps := []DeliveryOp{DeliveryOpWrite, DeliveryOpTransition}
	interleavings := make([][]DeliveryOp, n)
	for i := range interleavings {
		ops := make([]DeliveryOp, 1+random.IntN(longest))
		for j := range ops {
			ops[j] = steps[random.IntN(len(steps))]
		}
		if !slices.Contains(ops, DeliveryOpWrite) {
			ops = append(ops, DeliveryOpWrite)
		}
		interleavings[i] = ops
	}
	return interleavings
}

// AssertExactlyOnceDelivery runs L3 over each interleaving, against a fresh
// subject setup builds inside the case's bubble, and gives the first
// violation: the event lost or doubled, and the interleaving. It is nil when
// every interleaving kept it. A subject that reads a socket is no subject for
// it: a bubble's clock stands still while anything in it waits on one.
func AssertExactlyOnceDelivery(t *testing.T, setup func(t *testing.T) DeliverySubject, interleavings [][]DeliveryOp) error {
	if len(interleavings) == 0 {
		return errors.New("no interleaving was given: a run of none checks nothing")
	}
	for _, ops := range interleavings {
		var violation error
		synctest.Test(t, func(t *testing.T) {
			subject := setup(t)
			var written []string
			// No settling between steps: the races that matter are a
			// transition landing before a write has been delivered.
			for i, op := range ops {
				switch op {
				case DeliveryOpWrite:
					id := fmt.Sprintf("e%d", i)
					subject.Write(id)
					written = append(written, id)
				case DeliveryOpTransition:
					subject.Transition()
				default:
					violation = fmt.Errorf("%q is no step of an interleaving", op)
					return
				}
			}
			violation = deliveryViolation(ops, written, subject.Delivered())
		})
		if violation != nil {
			return violation
		}
	}
	return nil
}

// deliveryViolation is the first event written that was not delivered
// exactly once, or nil.
func deliveryViolation(ops []DeliveryOp, written, delivered []string) error {
	steps := make([]string, len(ops))
	for i, op := range ops {
		steps[i] = string(op)
	}
	under := fmt.Sprintf("under ⟨%s⟩", strings.Join(steps, ","))
	for _, id := range written {
		times := 0
		for _, each := range delivered {
			if each == id {
				times++
			}
		}
		switch times {
		case 1:
		case 0:
			return fmt.Errorf("L3: event ⟨%s⟩ was delivered 0 times %s: lost across a transition", id, under)
		default:
			return fmt.Errorf("L3: event ⟨%s⟩ was delivered %d times %s", id, times, under)
		}
	}
	return nil
}
