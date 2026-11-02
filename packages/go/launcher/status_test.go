package launcher

import (
	"slices"
	"testing"
)

// Beside a service several knowledge bases share, each is named by the last
// segment of its DID, or by its whole DID where two would share one; a
// stack with no record, by the key its containers are named for.
func TestKnowledgeBasesAreNamedByTheirDIDs(t *testing.T) {
	view := func(did string) stackView { return stackView{st: &StackState{KBDid: did}, key: "key of " + did} }
	views := []stackView{
		view("did:web:example.github.io:test-kb"),
		view("did:web:example.org:test-kb"),
		view("did:web:example.github.io:other-kb"),
		{key: "example.github.io-found-kb"},
	}
	nameViews(views)
	var got []string
	for _, v := range views {
		got = append(got, v.name)
	}
	want := []string{"did:web:example.github.io:test-kb", "did:web:example.org:test-kb", "other-kb", "example.github.io-found-kb"}
	if !slices.Equal(got, want) {
		t.Errorf("named %q, want %q", got, want)
	}
}
