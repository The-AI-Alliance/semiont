package discovery_test

// The knowledge bases a launcher manages: what its document says, and what
// changed between two readings of it.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/discovery"
)

func entry(host string, port int, did string) map[string]any {
	return map[string]any{
		"host": host, "port": port, "placement": "local",
		"managedBy": "semiont-launcher", "did": did,
	}
}

func written(t *testing.T, value any) string {
	t.Helper()
	text, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(text)
}

func document(t *testing.T, kbs ...any) string {
	t.Helper()
	if kbs == nil {
		kbs = []any{}
	}
	return written(t, map[string]any{"version": 1, "kbs": kbs})
}

func kb(t *testing.T, value map[string]any) api.DiscoveredKB {
	t.Helper()
	var read api.DiscoveredKB
	if err := json.Unmarshal([]byte(written(t, value)), &read); err != nil {
		t.Fatalf("a discovered knowledge base: %v", err)
	}
	return read
}

func reason(state discovery.DiscoveryState) (discovery.DiscoveryAbsentReason, bool) {
	absent, isAbsent := state.(discovery.Absent)
	return absent.Reason, isAbsent
}

func diagnostic(state discovery.DiscoveryState) string {
	absent, _ := state.(discovery.Absent)
	return absent.Diagnostic
}

const (
	a = "did:web:example.org:kb-a"
	b = "did:web:example.org:kb-b"
)

// ── What the document says ──────────────────────────────────────────────

func TestADocumentOfKnowledgeBasesIsManagedAndOneOfNoneIsManagedToo(t *testing.T) {
	codespace := map[string]any{
		"host": "localhost", "port": 4100, "placement": "codespace", "managedBy": "semiont-launcher",
		"did": b, "repo": "owner/name", "siteName": "A site",
	}
	got := discovery.ParseDiscoveryDocument(document(t, entry("localhost", 4000, a), codespace))
	if want := (discovery.Managed{KBs: []api.DiscoveredKB{kb(t, entry("localhost", 4000, a)), kb(t, codespace)}}); !reflect.DeepEqual(got, want) {
		t.Errorf("read %#v, not %#v", got, want)
	}
	// A launcher that manages nothing is there. It is not absent.
	if got, want := discovery.ParseDiscoveryDocument(document(t)), (discovery.Managed{KBs: []api.DiscoveredKB{}}); !reflect.DeepEqual(got, want) {
		t.Errorf("read %#v, not %#v", got, want)
	}
}

func TestWhatIsNotADocumentIsAbsentAndSaysWhy(t *testing.T) {
	cases := []struct {
		text     string
		expected discovery.DiscoveryAbsentReason
	}{
		{"<!doctype html><html></html>", discovery.NotJSON},
		{"[]", discovery.Invalid},
		{written(t, map[string]any{"kbs": []any{}}), discovery.Invalid},
		{written(t, map[string]any{"version": "1", "kbs": []any{}}), discovery.Invalid},
		{written(t, map[string]any{"version": 2, "kbs": []any{}}), discovery.UnsupportedVersion},
		{written(t, map[string]any{"version": 1}), discovery.Invalid},
		{written(t, map[string]any{"version": 1, "kbs": []any{"localhost"}}), discovery.Invalid},
		{
			document(t, map[string]any{"host": "localhost", "port": 4000, "placement": "elsewhere", "managedBy": "x", "did": a}),
			discovery.Invalid,
		},
		{document(t, entry("localhost", 0, a)), discovery.Invalid},
		{
			document(t, map[string]any{"host": "localhost", "port": 70000, "placement": "local", "managedBy": "x", "did": a}),
			discovery.Invalid,
		},
	}
	for _, stated := range cases {
		state := discovery.ParseDiscoveryDocument(stated.text)
		if got, isAbsent := reason(state); !isAbsent || got != stated.expected {
			t.Errorf("%s: read %#v, not absent as %s", stated.text, state, stated.expected)
		}
		if diagnostic(state) == "" {
			t.Errorf("%s: no diagnostic", stated.text)
		}
	}
}

func TestADocumentOfAnotherVersionIsNotReadInPart(t *testing.T) {
	state := discovery.ParseDiscoveryDocument(written(t, map[string]any{"version": 2, "kbs": []any{entry("localhost", 4000, a)}}))
	if got, isAbsent := reason(state); !isAbsent || got != discovery.UnsupportedVersion {
		t.Errorf("read %#v", state)
	}
	if !strings.Contains(diagnostic(state), "version 2") {
		t.Errorf("read %#v", state)
	}
}

func TestOneEntryThatIsNotOneMakesTheWholeDocumentAbsent(t *testing.T) {
	// A reading of the good entry alone would hide a running knowledge base.
	withoutADid := map[string]any{"host": "localhost", "port": 4100, "placement": "local", "managedBy": "x"}
	state := discovery.ParseDiscoveryDocument(document(t, entry("localhost", 4000, a), withoutADid))
	if got, isAbsent := reason(state); !isAbsent || got != discovery.Invalid {
		t.Errorf("read %#v", state)
	}
	if !strings.Contains(diagnostic(state), "did") {
		t.Errorf("read %#v", state)
	}
}

// ── Reading it as text ──────────────────────────────────────────────────

func readOf(text string, err error) discovery.DiscoveryRead {
	return discovery.TextDiscovery(func(context.Context) (string, error) { return text, err }).Read(context.Background())
}

func TestTextIsReadThroughTheOneValidator(t *testing.T) {
	if got, want := readOf(document(t, entry("localhost", 4000, a)), nil), (discovery.Managed{KBs: []api.DiscoveredKB{kb(t, entry("localhost", 4000, a))}}); !reflect.DeepEqual(got, want) {
		t.Errorf("read %#v, not %#v", got, want)
	}
	if got, want := readOf("", fs.ErrNotExist), (discovery.Absent{Reason: discovery.NotFound}); !reflect.DeepEqual(got, want) {
		t.Errorf("read %#v, not %#v", got, want)
	}
	if got, want := readOf("", errors.New("permission denied")), (discovery.Absent{Reason: discovery.Unreadable, Diagnostic: "permission denied"}); !reflect.DeepEqual(got, want) {
		t.Errorf("read %#v, not %#v", got, want)
	}
}

// ── What changed ────────────────────────────────────────────────────────

// script is a transport that gives what it was scripted to, in order, and
// then says nothing has changed.
type script struct {
	mu    sync.Mutex
	reads []discovery.DiscoveryRead
	asked int
}

func scriptOf(reads ...discovery.DiscoveryRead) *script {
	return &script{reads: reads}
}

func (s *script) Read(context.Context) discovery.DiscoveryRead {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.asked++
	if len(s.reads) == 0 {
		return discovery.Unchanged{}
	}
	next := s.reads[0]
	s.reads = s.reads[1:]
	return next
}

func (s *script) timesAsked() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.asked
}

// changes is every change told of in polls readings. Called inside a
// synctest bubble.
func changes(s *script, polls int) []discovery.DiscoveryDiff {
	ctx, cancel := context.WithCancel(context.Background())
	var mu sync.Mutex
	var told []discovery.DiscoveryDiff
	done := make(chan struct{})
	go func() {
		defer close(done)
		for diff := range discovery.SubscribeDiscovery(ctx, s, discovery.DiscoveryInterval) {
			mu.Lock()
			told = append(told, diff)
			mu.Unlock()
		}
	}()
	time.Sleep(discovery.DiscoveryInterval*time.Duration(polls) - time.Millisecond)
	synctest.Wait()
	cancel()
	<-done
	mu.Lock()
	defer mu.Unlock()
	return told
}

func addresses(kbs []api.DiscoveredKB) []string {
	found := []string{}
	for _, kb := range kbs {
		found = append(found, fmt.Sprintf("%s:%d", kb.Host, kb.Port))
	}
	return found
}

// summary is a diff as what it added, changed and removed, by address.
type summary struct {
	added, updated, removed []string
}

func summaryOf(diff discovery.DiscoveryDiff) summary {
	return summary{addresses(diff.Added), addresses(diff.Updated), addresses(diff.Removed)}
}

func at(addresses ...string) []string {
	return append([]string{}, addresses...)
}

func summaries(told []discovery.DiscoveryDiff) []summary {
	found := []summary{}
	for _, diff := range told {
		found = append(found, summaryOf(diff))
	}
	return found
}

func parsed(text string) discovery.DiscoveryRead {
	return discovery.ParseDiscoveryDocument(text)
}

func TestTheFirstReadingIsToldWholeAndEachOneAfterByWhatChanged(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		renamed := map[string]any{
			"host": "localhost", "port": 4000, "placement": "local",
			"managedBy": "semiont-launcher", "did": a, "siteName": "Renamed",
		}
		s := scriptOf(
			parsed(document(t, entry("localhost", 4000, a))),
			parsed(document(t, renamed, entry("localhost", 4100, b))),
			parsed(document(t, entry("localhost", 4100, b))),
		)
		told := changes(s, 4)

		want := []summary{
			{at("localhost:4000"), at(), at()},
			{at("localhost:4100"), at("localhost:4000"), at()},
			{at(), at(), at("localhost:4000")},
		}
		if got := summaries(told); !reflect.DeepEqual(got, want) {
			t.Fatalf("told %v, not %v", got, want)
		}
		if name := told[1].Updated[0].SiteName; name == nil || *name != "Renamed" {
			t.Errorf("the change told %v", name)
		}
		if asked := s.timesAsked(); asked != 4 {
			t.Errorf("asked %d times", asked)
		}
	})
}

func TestAKnowledgeBaseThatMovesPortIsRemovedAndAdded(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := scriptOf(
			parsed(document(t, entry("localhost", 4000, a))),
			parsed(document(t, entry("localhost", 4001, a))),
		)
		told := changes(s, 2)

		if len(told) != 2 {
			t.Fatalf("told %d changes", len(told))
		}
		if got, want := summaryOf(told[1]), (summary{at("localhost:4001"), at(), at("localhost:4000")}); !reflect.DeepEqual(got, want) {
			t.Errorf("told %v, not %v", got, want)
		}
	})
}

func TestAReadingThatChangedNothingIsNotTold(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		same := document(t, entry("localhost", 4000, a))
		s := scriptOf(parsed(same), discovery.Unchanged{}, parsed(same), parsed(same))
		told := changes(s, 5)

		if len(told) != 1 {
			t.Errorf("told %d changes", len(told))
		}
		if asked := s.timesAsked(); asked != 5 {
			t.Errorf("asked %d times", asked)
		}
	})
}

// Go's own: an entry's optional members are pointers, and an entry read again
// is the same entry when what they point at is.
func TestAnEntryWithOptionalMembersReadAgainUnchangedIsNotTold(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		codespace := document(t, map[string]any{
			"host": "localhost", "port": 4100, "placement": "codespace", "managedBy": "semiont-launcher",
			"did": b, "repo": "owner/name", "siteName": "A site",
		})
		s := scriptOf(parsed(codespace), parsed(codespace))
		told := changes(s, 2)

		if len(told) != 1 {
			t.Errorf("told %d changes", len(told))
		}
	})
}

func TestALauncherThatGoesAndComesBackIsToldWithWhatItTookAndBrought(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		managing := document(t, entry("localhost", 4000, a))
		s := scriptOf(
			parsed("not json"),
			parsed(managing),
			parsed("not json"),
			// Absent for another reason is a change too; for the same one it is not.
			parsed("[]"),
			parsed("{}"),
		)
		told := changes(s, 6)

		type said struct {
			reason  discovery.DiscoveryAbsentReason
			absent  bool
			summary summary
		}
		got := []said{}
		for _, diff := range told {
			why, isAbsent := reason(diff.State)
			got = append(got, said{why, isAbsent, summaryOf(diff)})
		}
		want := []said{
			{discovery.NotJSON, true, summary{at(), at(), at()}},
			{"", false, summary{at("localhost:4000"), at(), at()}},
			{discovery.NotJSON, true, summary{at(), at(), at("localhost:4000")}},
			{discovery.Invalid, true, summary{at(), at(), at()}},
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("told %v, not %v", got, want)
		}
	})
}

func TestOneKnowledgeBaseInTwoPlacesIsTwoEntriesAndEachIsItsOwn(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		both := document(t, entry("localhost", 4000, a), entry("localhost", 4100, a))
		s := scriptOf(
			parsed(both),
			parsed(both),
			parsed(document(t, entry("localhost", 4100, a))),
		)
		told := changes(s, 4)

		// No change while both are there, and the one that stops is not hidden
		// by the one that goes on.
		want := []summary{
			{at("localhost:4000", "localhost:4100"), at(), at()},
			{at(), at(), at("localhost:4000")},
		}
		if got := summaries(told); !reflect.DeepEqual(got, want) {
			t.Errorf("told %v, not %v", got, want)
		}
		for _, diff := range told {
			if len(diff.Duplicated) != 0 {
				t.Errorf("named %v as duplicated", diff.Duplicated)
			}
		}
	})
}

func TestTwoEntriesAtOneAddressAreNamedAndNeitherIsDroppedFromTheState(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := scriptOf(parsed(document(t,
			entry("localhost", 4000, a),
			entry("localhost", 4000, b),
			entry("localhost", 4100, b),
		)))
		told := changes(s, 1)

		if len(told) != 1 {
			t.Fatalf("told %d changes", len(told))
		}
		if !slices.Equal(told[0].Duplicated, at("localhost:4000")) {
			t.Errorf("named %v as duplicated", told[0].Duplicated)
		}
		managed, isManaged := told[0].State.(discovery.Managed)
		if !isManaged {
			t.Fatalf("a managed state was expected, not %#v", told[0].State)
		}
		if len(managed.KBs) != 3 {
			t.Errorf("the state lists %d entries", len(managed.KBs))
		}
	})
}

func TestReadingStopsWhenNobodyListens(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := scriptOf(parsed(document(t)))
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() {
			defer close(done)
			for range discovery.SubscribeDiscovery(ctx, s, discovery.DiscoveryInterval) {
			}
		}()
		time.Sleep(discovery.DiscoveryInterval * 2)
		synctest.Wait()
		asked := s.timesAsked()
		if asked < 2 {
			t.Fatalf("asked %d times", asked)
		}

		cancel()
		<-done
		time.Sleep(discovery.DiscoveryInterval * 5)
		if now := s.timesAsked(); now != asked {
			t.Errorf("asked %d times after the reader left, not %d", now, asked)
		}
	})
}
