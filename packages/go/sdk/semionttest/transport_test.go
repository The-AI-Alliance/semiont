package semionttest_test

// The double's failures, as a transport's are told
// (protocol/contract/TRANSPORT-CONTRACT.md § Failures).

import (
	"fmt"
	"slices"
	"testing"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/semionttest"
)

// The first listener of the double's failures is told, of those failed
// before it listened, the latest ErrorsKeptForFirstReaderCount, in order,
// and then what follows; a later listener is told only what follows it.
func TestTheFirstListenerOfTheDoublesFailuresIsToldTheLatestFailedBeforeIt(t *testing.T) {
	transport := semionttest.NewFaultyTransport(semionttest.FaultyConfig{})
	defer transport.Close()
	most := semiont.DefaultTiming().ErrorsKeptForFirstReaderCount
	beyond := 5
	failed := make([]*semiont.TransportError, most+beyond)
	for n := range failed {
		failed[n] = &semiont.TransportError{Code: semiont.TransportErrorCodeUnavailable, Message: fmt.Sprintf("failure %d", n)}
		transport.Fail(failed[n])
	}

	var first, later []*semiont.TransportError
	stopFirst := transport.Failures(func(failure *semiont.TransportError) { first = append(first, failure) })
	defer stopFirst()
	stopLater := transport.Failures(func(failure *semiont.TransportError) { later = append(later, failure) })
	defer stopLater()
	following := &semiont.TransportError{Code: semiont.TransportErrorCodeUnavailable, Message: "after both listened"}
	transport.Fail(following)

	if want := append(slices.Clone(failed[beyond:]), following); !slices.Equal(first, want) {
		t.Errorf("the first listener was told %d failures, want the latest %d failed before it, in order, and what followed", len(first), most)
	}
	if want := []*semiont.TransportError{following}; !slices.Equal(later, want) {
		t.Errorf("a later listener was told %v, want %v", later, want)
	}
}

// A first listener who comes after the double has closed is told nothing:
// what was kept for it was let go of at the close.
func TestAFirstListenerWhoComesAfterTheDoubleHasClosedIsToldNothing(t *testing.T) {
	transport := semionttest.NewFaultyTransport(semionttest.FaultyConfig{})
	transport.Fail(&semiont.TransportError{Code: semiont.TransportErrorCodeUnavailable, Message: "HTTP 503"})
	transport.Close()

	var told []*semiont.TransportError
	stop := transport.Failures(func(failure *semiont.TransportError) { told = append(told, failure) })
	stop()

	if len(told) != 0 {
		t.Errorf("a first listener after the close was told %v, want nothing", told)
	}
}
