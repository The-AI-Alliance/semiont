package verbs

import (
	"strings"
	"testing"

	launcher "github.com/The-AI-Alliance/semiont/packages/go/launcher"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
)

// A guide watching a tour needs to read the room, not decode it. These pin the
// three gaps `semiont listen` closes for a human reader: ids that should be
// names, presence that is a STATE rather than a pair of events, and a stream
// that shows only the participant's half of the conversation.

func TestListenRendersResourceNamesWithIdFallback(t *testing.T) {
	u := launcher.NewUI(true)
	r := newListenRenderer(map[string]string{"res-42": "The Iliad"})

	known := r.line(u, semiont.Frame{Channel: "browse:resource-viewed", Payload: []byte(`{"resourceId":"res-42"}`)})
	if !strings.Contains(known, "The Iliad") {
		t.Errorf("a resolvable id must render as its name: %q", known)
	}

	// Never blocks and never blanks: an id the prefetch did not cover still
	// renders, as the id. A guide can act on an id; they cannot act on "".
	unknown := r.line(u, semiont.Frame{Channel: "browse:resource-viewed", Payload: []byte(`{"resourceId":"res-99"}`)})
	if !strings.Contains(unknown, "res-99") {
		t.Errorf("an unresolvable id must still render: %q", unknown)
	}
}

// Presence is a STATE. Two tabs is two connections under one principal, so the
// count follows connectionId — a renderer keyed on the DID would report one
// viewer for two, and zero for one when the duplicate tab closed.
func TestListenRendersPresenceAsState(t *testing.T) {
	u := launcher.NewUI(true)
	r := newListenRenderer(nil)
	did := "did:web:example.github.io:users:alice%40example.com"

	first := r.line(u, semiont.Frame{Channel: "session:joined", Payload: []byte(`{"participant":"` + did + `","connectionId":"c1"}`)})
	mustAll(t, "first join", first, did, "1 connection watching")

	second := r.line(u, semiont.Frame{Channel: "session:joined", Payload: []byte(`{"participant":"` + did + `","connectionId":"c2"}`)})
	mustAll(t, "second connection of the same person", second, "2 connections watching")

	gone := r.line(u, semiont.Frame{Channel: "session:left", Payload: []byte(`{"participant":"` + did + `","connectionId":"c2"}`)})
	mustAll(t, "one tab closed", gone, "left", "1 connection watching")

	if got := r.watching(); got != 1 {
		t.Errorf("watching() = %d, want 1", got)
	}
}

// A participant is shown by its DID, a person's and an agent's alike: nothing
// read out of it is a name.
func TestListenShowsAParticipantByItsDID(t *testing.T) {
	u := launcher.NewUI(true)
	r := newListenRenderer(nil)
	for _, did := range []string{
		"did:web:example.github.io:users:alice%40example.com",
		"did:web:example.github.io:agents:semiont-worker",
	} {
		joined := r.line(u, semiont.Frame{Channel: "session:joined", Payload: []byte(`{"participant":"` + did + `","connectionId":"` + did + `"}`)})
		mustAll(t, did, joined, " "+did+" joined")
	}
}

func mustAll(t *testing.T, label, got string, wants ...string) {
	t.Helper()
	for _, w := range wants {
		if !strings.Contains(got, w) {
			t.Errorf("%s: %q missing %q", label, got, w)
		}
	}
}
