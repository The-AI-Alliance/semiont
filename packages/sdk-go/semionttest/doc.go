// Package semionttest is what a consumer's tests are built on: a real client
// over doubles. Named for the net/http/httptest convention: a testing
// companion beside the package it doubles, kept out of that package's own
// surface.
//
// NewTestClient gives a real *semiont.Client (its namespaces, its cache and
// its deadlines are the client's own) over a transport a test scripts
// (FaultyTransport), a content transport that keeps what it is given
// (InMemoryContent), and a gateway that answers only what it was told to
// (StubGateway). A test scripts the doubles and observes through the client:
//
//	made := semionttest.NewTestClient(semionttest.TestClientConfig{Timing: semiont.DefaultTiming()})
//	made.Transport.QueueReply(bus.BrowseResourceRequested.Request().Channel(), json.RawMessage(`{"resource":{…}}`))
//	described, err := made.Client.Browse.Resource(resourceID).Fresh(ctx)
//	// made.Transport.RequestLog()[0].Payload is what was sent
//
// A double answers what a test told it to and refuses the rest by name. It
// never answers with a value of its own making: a request nobody scripted an
// answer for fails naming its operation, and a read of content nobody stored
// fails naming the resource, so a test that forgot to say something fails
// where it forgot.
//
// Every double works inside a testing/synctest bubble: it opens no socket,
// starts no goroutine of its own but a delayed reply's timer, and waits only
// on channels. A test that builds the doubles in the bubble can let what is
// ready run (synctest.Wait) and move the clock (time.Sleep) as it likes.
//
// # The state-unit axioms
//
// AssertStateUnitAxioms holds a state unit to what every unit promises
// (docs/builder/STATE-UNITS.md): Close is idempotent and total, the unit is
// inert after it, every reader of what it hands out sees that end, it closes
// nothing it was given and everything it made, it hands out no writer, and
// two units never move each other. One call per unit, from that unit's tests:
//
//	semionttest.AssertStateUnitAxioms(t, semionttest.AxiomSubject[*state.BeckonStateUnit]{
//		Setup: func(t *testing.T) semionttest.Fresh[*state.BeckonStateUnit] {
//			made := semionttest.NewTestClient(semionttest.TestClientConfig{Timing: semiont.DefaultTiming()})
//			t.Cleanup(func() { made.Client.Close(); made.Transport.Close() })
//			unit := state.NewBeckonStateUnit(made.Client, resourceID)
//			return semionttest.Fresh[*state.BeckonStateUnit]{Unit: unit}.With(semionttest.TheClient(made.Client))
//		},
//		Surfaces: func(unit *state.BeckonStateUnit) []semionttest.Surface {
//			return []semionttest.Surface{semionttest.Watching(unit.HoveredAnnotationId())}
//		},
//		Invocations: func(unit *state.BeckonStateUnit) []func() {
//			return []func(){func() { unit.Focus(annotationID) }}
//		},
//	})
package semionttest
