package registry_test

// The registry, continued: a sign-in landing on the entry for the knowledge
// base that answered, what is open in each knowledge base, what a session's
// arrival checks, what its transport fails at, and how a registry ends.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/registry"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/semionttest"
)

// ended is whether a reader of something a registry showed sees no more: its
// changes end once it is given the value now.
func ended[T any](watched semiont.Watched[T]) bool {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	seen := 0
	for range watched.Changes(ctx) {
		seen++
	}
	return ctx.Err() == nil && seen == 1
}

func TestWhatAHostShowsAboutASessionIsThereExactlyWhenTheSessionIs(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		browser := w.with(kbOfA()).browser()
		if browser.ActiveSignals().Value() != nil {
			t.Fatal("signals are shown with no session")
		}

		live(t, browser)
		first := browser.ActiveSignals().Value()
		if first == nil || first.SessionEnded().Value() != nil {
			t.Fatal("a live session's signals are not shown, or say it ended")
		}

		// A sign-in on the active knowledge base replaces both together.
		must(t, browser.SignIn(kbA, tokens("r2")))
		live(t, browser)
		if second := browser.ActiveSignals().Value(); second == nil || second == first {
			t.Error("a sign-in did not replace the signals")
		}
		if !ended(first.SessionEnded()) {
			t.Error("the replaced signals still say things")
		}

		must(t, browser.SignOut(kbA))
		if browser.ActiveSignals().Value() != nil || sessionOf(browser) != "" {
			t.Error("signing out leaves signals or a session")
		}
	})
}

// ── Signing in ──────────────────────────────────────────────────────────

func signedIn(t *testing.T, at api.KbEndpoint, said json.RawMessage, refresh string) registry.SignedIn {
	var description api.KbDescription
	must(t, json.Unmarshal(said, &description))
	return registry.SignedIn{Endpoint: at, Description: description, Session: tokens(refresh)}
}

func TestNewTokensForTheActiveKnowledgeBaseReplaceItsSession(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		browser := w.with(kbOfA()).browser()
		first := live(t, browser)

		must(t, browser.SignIn(kbA, tokens("renewed")))
		second := live(t, browser)

		if first.Id() == second.Id() || !closed(w.factory.sessions.Transports(kbA)[0]) {
			t.Error("new tokens did not replace the session")
		}
		if refresh, _ := w.storedRefresh(kbA); refresh != "renewed" {
			t.Errorf("the stored refresh token is %q", refresh)
		}
	})
}

func TestASignInAtANewAddressRegistersTheKnowledgeBaseUnderWhatItSaysItIs(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		browser := w.browser()

		outcome, err := browser.SignedIn(signedIn(t, endpoint("localhost", 4000), description("KB A", "example.org:kb-a", "main"), "r"))
		must(t, err)

		if outcome.Expected != nil || outcome.Kb.Did != didA || outcome.Kb.Label != "KB A" {
			t.Errorf("the outcome is %+v", outcome)
		}
		if read := outcome.Kb.LastRead; read == nil || read.GitBranch == nil || *read.GitBranch != "main" {
			t.Errorf("what it last said is %+v", read)
		}
		if !same(t, browser.KnowledgeBases().Value(), []api.KnowledgeBase{outcome.Kb}) || sessionOf(browser) != outcome.Kb.Id {
			t.Error("the knowledge base signed in to is not the one registered and active")
		}
		if refresh, _ := w.storedRefresh(outcome.Kb.Id); refresh != "r" {
			t.Errorf("the stored refresh token is %q", refresh)
		}
	})
}

func TestASignInReportsWhatThePersonBelievedTheyClicked(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		browser := w.browser()
		believed := signedIn(t, endpoint("localhost", 4000), description("KB A", "example.org:kb-a", ""), "r")
		believed.ExpectedDid, believed.ExpectedName = didB, "KB B"

		outcome, err := browser.SignedIn(believed)
		must(t, err)

		// The knowledge base that answered is the one registered. What was
		// believed is said back, for a host to set against it.
		if outcome.Kb.Did != didA || !reflect.DeepEqual(outcome.Expected, &registry.Expected{Did: didB, Name: "KB B"}) {
			t.Errorf("the outcome is %+v, expected %+v", outcome.Kb, outcome.Expected)
		}
	})
}

func TestASignInToARegisteredKnowledgeBaseTakesWhatItAndTheIssuerNowSay(t *testing.T) {
	for _, byID := range []bool{true, false} {
		t.Run(fmt.Sprintf("by id %v", byID), func(t *testing.T) {
			bubble(t, func(t *testing.T, w *world) {
				browser := w.with(kbOfA()).browser()
				first := live(t, browser)
				again := signedIn(t, endpoint("localhost", 4000), description("KB A, renamed", "example.org:kb-a", "feature"), "r2")
				if byID {
					again.KbID = kbA
				}

				outcome, err := browser.SignedIn(again)
				must(t, err)

				// The same entry, under the name it gives itself now.
				if outcome.Kb.Id != kbA || outcome.Kb.Label != "KB A, renamed" || !same(t, browser.KnowledgeBases().Value(), []api.KnowledgeBase{outcome.Kb}) {
					t.Errorf("the entry is %+v of %+v", outcome.Kb, browser.KnowledgeBases().Value())
				}
				// What was believed is the entry as it was, under the label it had.
				if !reflect.DeepEqual(outcome.Expected, &registry.Expected{Did: didA, Name: "KB A"}) {
					t.Errorf("expected: %+v", outcome.Expected)
				}
				if refresh, _ := w.storedRefresh(kbA); refresh != "r2" {
					t.Errorf("the stored refresh token is %q", refresh)
				}
				if live(t, browser).Id() == first.Id() {
					t.Error("the session was not replaced")
				}
			})
		})
	}
}

func TestASignInADifferentKnowledgeBaseAnswersLeavesTheEntryAndLandsOnANewOne(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		branch := "main"
		believed := kbOfA()
		believed.LastRead = &api.KbRead{At: "2027-01-15T08:00:00.000Z", GitBranch: &branch}
		w.with(believed)
		before, _ := registry.StoredSessionOf(w.storage, kbA)
		browser := w.browser()
		live(t, browser)
		landing := signedIn(t, endpoint("localhost", 4000), description("KB B", "example.org:kb-b", "other"), "for-b")
		landing.KbID = kbA

		outcome, err := browser.SignedIn(landing)
		must(t, err)

		// The entry the person believed they were signing in to is as it was:
		// its did, its name, what it last said, and its credentials.
		kbs := browser.KnowledgeBases().Value()
		if !same(t, kbs[0], believed) {
			t.Errorf("the entry believed is now %+v", kbs[0])
		}
		if after, _ := registry.StoredSessionOf(w.storage, kbA); after != before {
			t.Error("the entry believed has other credentials")
		}
		// The knowledge base that answered has an entry of its own, at the same
		// address, and it is the one signed in and active.
		if len(kbs) != 2 || !same(t, kbs[1], outcome.Kb) || outcome.Kb.Did != didB || outcome.Kb.Label != "KB B" || outcome.Kb.Id == kbA || !same(t, outcome.Kb.Endpoint, believed.Endpoint) {
			t.Errorf("the entries are %+v, the outcome %+v", kbs, outcome.Kb)
		}
		if sessionOf(browser) != outcome.Kb.Id {
			t.Errorf("the session is %q", sessionOf(browser))
		}
		if refresh, _ := w.storedRefresh(outcome.Kb.Id); refresh != "for-b" {
			t.Errorf("the stored refresh token is %q", refresh)
		}
		if !reflect.DeepEqual(outcome.Expected, &registry.Expected{Did: didA, Name: "KB A"}) {
			t.Errorf("expected: %+v", outcome.Expected)
		}
	})
}

func TestOfTwoEntriesAtOneAddressASignInLandsOnTheOneWhoseDidAnswered(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		twin := kb("kb-a2", "KB B here", didB, endpoint("localhost", 4000))
		browser := w.with(kbOfA(), twin).browser()
		live(t, browser)

		outcome, err := browser.SignedIn(signedIn(t, endpoint("localhost", 4000), description("KB B", "example.org:kb-b", ""), "for-b"))
		must(t, err)

		kbs := browser.KnowledgeBases().Value()
		if outcome.Kb.Id != twin.Id || len(kbs) != 2 || !same(t, kbs[0], kbOfA()) || sessionOf(browser) != "kb-a2" {
			t.Errorf("the outcome is %+v, the entries %+v", outcome.Kb, kbs)
		}
		// An address with two entries singles out no belief.
		if outcome.Expected != nil {
			t.Errorf("expected: %+v", outcome.Expected)
		}
	})
}

func TestAnEntryAtAnotherAddressWithTheSameDidIsNotTheOneSignedIn(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		// One knowledge base in two places is two entries.
		browser := w.with(kbOfA()).browser()
		live(t, browser)

		outcome, err := browser.SignedIn(signedIn(t, endpoint("localhost", 4100), description("KB A", "example.org:kb-a", ""), "r"))
		must(t, err)

		if outcome.Kb.Id == kbA || outcome.Kb.Did != didA || len(browser.KnowledgeBases().Value()) != 2 || outcome.Expected != nil {
			t.Errorf("the outcome is %+v", outcome)
		}
	})
}

func TestSigningOutForgetsTheTokensClosesTheSessionAndHasTheIssuerTold(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		w.with(kbOfA())
		before, _ := registry.StoredSessionOf(w.storage, kbA)
		browser := w.browser()
		live(t, browser)
		ctx, cancel := context.WithCancel(context.Background())
		told := make(chan struct{}, 4)
		listening := make(chan struct{})
		go func() {
			defer close(listening)
			first := true
			for range browser.KnowledgeBases().Changes(ctx) {
				if !first {
					told <- struct{}{}
				}
				first = false
			}
		}()
		defer func() {
			cancel()
			<-listening
		}()
		synctest.Wait()

		must(t, browser.SignOut(kbA))
		settle()

		if _, ok := registry.StoredSessionOf(w.storage, kbA); ok {
			t.Error("the tokens are still stored")
		}
		if sessionOf(browser) != "" || !closed(w.factory.sessions.Transports(kbA)[0]) {
			t.Error("the session is not closed")
		}
		if revoked := w.factory.sessions.Revoked(); !reflect.DeepEqual(revoked, []registry.StoredSession{before}) {
			t.Errorf("revoked: %+v", revoked)
		}
		// Still registered, and still the active one: only signed out.
		if !same(t, browser.KnowledgeBases().Value(), []api.KnowledgeBase{kbOfA()}) || browser.ActiveKbId().Value() != kbA {
			t.Error("signing out unregistered the knowledge base, or made it not active")
		}
		// The list is said again, so whoever shows its status reads it anew.
		select {
		case <-told:
		default:
			t.Error("the list was not said again")
		}
		if status := browser.KbSessionStatus(kbA); status != registry.KbSessionSignedOut {
			t.Errorf("the status is %s", status)
		}

		// Signing out of what is not signed in tells the issuer nothing.
		must(t, browser.SignOut(kbA))
		settle()
		if revoked := len(w.factory.sessions.Revoked()); revoked != 1 {
			t.Errorf("the issuer was told %d times", revoked)
		}
	})
}

// ── What is open ────────────────────────────────────────────────────────

func TestResourcesAreOpenedRenamedClosedAndMovedInTheActiveKnowledgeBase(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		browser := w.with(kbOfA()).browser()
		live(t, browser)

		must(t, browser.AddOpenResource(id("r1"), "One", "text/plain", ""))
		must(t, browser.AddOpenResource(id("r2"), "Two", "", "file://two.md"))
		must(t, browser.AddOpenResource(id("r3"), "Three", "", ""))
		if got := open(browser); !equalStrings(got, []string{"r1", "r2", "r3"}) {
			t.Fatalf("open: %v", got)
		}

		// Opening what is open already takes what is stated of it, in place.
		must(t, browser.AddOpenResource(id("r1"), "One, renamed", "", ""))
		must(t, browser.UpdateOpenResourceName(id("r2"), "Two, renamed"))
		shown := browser.OpenResources().Value()
		if got := open(browser); !equalStrings(got, []string{"r1", "r2", "r3"}) {
			t.Errorf("open: %v", got)
		}
		if shown[0].Name != "One, renamed" || shown[0].MediaType != "text/plain" || shown[1].Name != "Two, renamed" || shown[1].StorageURI != "file://two.md" {
			t.Errorf("shown: %+v", shown)
		}

		must(t, browser.ReorderOpenResources(0, 2))
		if got := open(browser); !equalStrings(got, []string{"r2", "r3", "r1"}) {
			t.Errorf("reordered: %v", got)
		}
		// A place that is not in the list moves nothing.
		must(t, browser.ReorderOpenResources(0, 3))
		must(t, browser.ReorderOpenResources(7, 0))
		if got := open(browser); !equalStrings(got, []string{"r2", "r3", "r1"}) {
			t.Errorf("after moves of nothing: %v", got)
		}

		must(t, browser.RemoveOpenResource(id("r3")))
		if got := open(browser); !equalStrings(got, []string{"r2", "r1"}) || len(w.storedOpen(kbA)) != 2 {
			t.Errorf("after closing r3: %v", got)
		}
	})
}

func TestAResourceOpenedAfterARemovalDoesNotTakeAPlaceThatIsTaken(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		browser := w.with(kbOfA()).browser()
		live(t, browser)
		for _, each := range []string{"r1", "r2", "r3"} {
			must(t, browser.AddOpenResource(id(each), each, "", ""))
		}

		must(t, browser.RemoveOpenResource(id("r2")))
		must(t, browser.AddOpenResource(id("r4"), "r4", "", ""))

		var places []int
		for _, resource := range browser.OpenResources().Value() {
			places = append(places, resource.Order)
		}
		if got := open(browser); !equalStrings(got, []string{"r1", "r3", "r4"}) || !slices.Equal(places, []int{0, 2, 3}) {
			t.Errorf("open %v at %v", got, places)
		}
	})
}

func TestNothingIsOpenOrOpenedOrViewedWithoutALiveSession(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		w.with(kbOfA())
		must(t, w.storage.Set(registry.OpenResourcesByKbKey, `{"kb-a":[{"id":"r1","name":"One","openedAt":1,"order":0}]}`))
		must(t, w.storage.Set(registry.LastViewedResourceByKbKey, `{"kb-a":"r1"}`))
		browser := w.browser()
		live(t, browser)
		if got := open(browser); !equalStrings(got, []string{"r1"}) || browser.LastViewedResource().Value().String() != "r1" {
			t.Fatalf("open %v, last viewed %v", got, browser.LastViewedResource().Value())
		}

		must(t, browser.SignOut(kbA))
		if len(open(browser)) != 0 || !browser.LastViewedResource().Value().IsZero() {
			t.Error("what is open is shown with no session")
		}
		must(t, browser.AddOpenResource(id("r2"), "Two", "", ""))
		must(t, browser.SetLastViewedResource(id("r2")))
		must(t, browser.RemoveOpenResource(id("r1")))
		// Hidden, not forgotten: the storage holds what it held.
		if got := w.storedOpen(kbA); !equalStrings(got, []string{"r1"}) || w.storedLastViewed()[kbA] != "r1" {
			t.Errorf("stored open %v, last viewed %v", got, w.storedLastViewed())
		}

		must(t, browser.SignIn(kbA, tokens("r")))
		live(t, browser)
		if got := open(browser); !equalStrings(got, []string{"r1"}) || browser.LastViewedResource().Value().String() != "r1" {
			t.Errorf("open %v, last viewed %v", got, browser.LastViewedResource().Value())
		}
	})
}

func TestEachKnowledgeBaseKeepsWhatIsOpenInItAndWhereThePersonWas(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		browser := w.with(kbOfA(), kbOfB()).browser()
		live(t, browser)
		must(t, browser.AddOpenResource(id("in-a"), "In A", "", ""))
		must(t, browser.SetLastViewedResource(id("in-a")))

		must(t, browser.SetActiveKb(kbB))
		live(t, browser)
		if len(open(browser)) != 0 || !browser.LastViewedResource().Value().IsZero() {
			t.Error("B shows what is open in A")
		}
		must(t, browser.AddOpenResource(id("in-b"), "In B", "", ""))
		must(t, browser.SetLastViewedResource(id("in-b")))

		must(t, browser.SetActiveKb(kbA))
		live(t, browser)
		if got := open(browser); !equalStrings(got, []string{"in-a"}) || browser.LastViewedResource().Value().String() != "in-a" {
			t.Errorf("A shows %v, last viewed %v", got, browser.LastViewedResource().Value())
		}
		if got := w.storedOpen(kbB); !equalStrings(got, []string{"in-b"}) {
			t.Errorf("stored open in B: %v", got)
		}
		if got := w.storedLastViewed(); !reflect.DeepEqual(got, map[string]string{kbA: "in-a", kbB: "in-b"}) {
			t.Errorf("stored last viewed: %v", got)
		}
	})
}

func TestWhatAnotherContextOpensOrViewsIsShownAndNeitherLosesTheOthers(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		w.with(kbOfA())
		here := w.browser()
		there := w.browserOver(w.storage.Context())
		live(t, here)
		live(t, there)

		must(t, here.AddOpenResource(id("from-here"), "Here", "", ""))
		must(t, there.AddOpenResource(id("from-there"), "There", "", ""))
		must(t, there.SetLastViewedResource(id("from-there")))

		// Each wrote against what the storage held, so both are there, in both.
		both := []string{"from-here", "from-there"}
		if !equalStrings(w.storedOpen(kbA), both) || !equalStrings(open(here), both) || !equalStrings(open(there), both) {
			t.Errorf("stored %v, here %v, there %v", w.storedOpen(kbA), open(here), open(there))
		}
		if here.LastViewedResource().Value().String() != "from-there" {
			t.Errorf("here, last viewed %v", here.LastViewedResource().Value())
		}
	})
}

func TestAChangeToWhatIsOpenIsMadeAgainstWhatTheStorageHolds(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		browser := w.with(kbOfA()).browser()
		live(t, browser)
		must(t, browser.AddOpenResource(id("mine"), "Mine", "", ""))

		// Written to the storage with nobody told: a context does not hear what
		// it writes itself, so what the registry has in memory is behind, and
		// what it writes next must not put it back.
		must(t, w.storage.Set(registry.OpenResourcesByKbKey, `{"kb-a":[
			{"id":"mine","name":"Mine","openedAt":1,"order":0},
			{"id":"theirs","name":"Theirs","openedAt":2,"order":1}]}`))
		must(t, w.storage.Set(registry.LastViewedResourceByKbKey, `{"kb-b":"in-b"}`))
		must(t, browser.AddOpenResource(id("another"), "Another", "", ""))
		must(t, browser.SetLastViewedResource(id("mine")))

		want := []string{"mine", "theirs", "another"}
		if !equalStrings(w.storedOpen(kbA), want) || !equalStrings(open(browser), want) {
			t.Errorf("stored %v, shown %v", w.storedOpen(kbA), open(browser))
		}
		if got := w.storedLastViewed(); !reflect.DeepEqual(got, map[string]string{kbA: "mine", kbB: "in-b"}) {
			t.Errorf("stored last viewed: %v", got)
		}
	})
}

// ── What a session's arrival checks ─────────────────────────────────────

// opened stores ids as open in a knowledge base, each under a stale name.
func (w *world) opened(kbID string, ids ...string) {
	byKb := map[string][]map[string]any{}
	w.stored(registry.OpenResourcesByKbKey, &byKb)
	var resources []map[string]any
	for place, each := range ids {
		resources = append(resources, map[string]any{"id": each, "name": "stale-" + each, "openedAt": place, "order": place})
	}
	byKb[kbID] = resources
	must(w.t, w.storage.Set(registry.OpenResourcesByKbKey, string(marshal(byKb))))
}

func TestOnlyAResourceTheKnowledgeBaseSaysIsGoneIsClosed(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		w.with(kbOfA()).opened(kbA, "kept", "gone", "unreadable")
		w.factory.behind.mu.Lock()
		w.factory.behind.gone["gone"] = true
		w.factory.behind.failing["unreadable"] = true
		w.factory.behind.mediaTypes["kept"] = "application/pdf"
		w.factory.behind.mu.Unlock()
		browser := w.browser()
		live(t, browser)

		want := []string{"kept", "unreadable"}
		if !equalStrings(open(browser), want) || !equalStrings(w.storedOpen(kbA), want) {
			t.Fatalf("open %v, stored %v", open(browser), w.storedOpen(kbA))
		}
		shown := browser.OpenResources().Value()
		// What was found is shown under the name and type it has now.
		if shown[0].Name != "name-kept" || shown[0].MediaType != "application/pdf" {
			t.Errorf("what was found shows as %+v", shown[0])
		}
		// What could not be read is left exactly as it was.
		if shown[1].Name != "stale-unreadable" {
			t.Errorf("what could not be read shows as %+v", shown[1])
		}
	})
}

func TestWhatIsOpenIsCheckedOncePerSessionAndAgainForTheNext(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		w.with(kbOfA(), kbOfB()).opened(kbA, "a1", "a2", "a3", "a4", "a5", "a6")
		w.opened(kbB, "b1")
		browser := w.browser()
		live(t, browser)
		if asked := len(w.factory.askedAbout(kbA)); asked != 6 {
			t.Fatalf("%d resources of A were asked about", asked)
		}

		// Changing what is open shows the list again, and checks nothing.
		must(t, browser.AddOpenResource(id("a7"), "Seven", "", ""))
		must(t, browser.ReorderOpenResources(0, 1))
		settle()
		if asked := len(w.factory.askedAbout(kbA)); asked != 6 {
			t.Errorf("%d resources of A were asked about", asked)
		}

		must(t, browser.SetActiveKb(kbB))
		live(t, browser)
		if asked := w.factory.askedAbout(kbB); !equalStrings(asked, []string{"b1"}) {
			t.Errorf("B was asked about %v", asked)
		}
	})
}

func TestAResourceAnotherContextOpenedWhileTheChecksRanIsLeftOpen(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		w.with(kbOfA()).opened(kbA, "gone")
		w.factory.behind.mu.Lock()
		w.factory.behind.gone["gone"] = true
		w.factory.behind.mu.Unlock()
		elsewhere := w.storage.Context()
		gate := gated{SessionFactory: w.factory.sessions, open: make(chan struct{})}
		browser, err := registry.NewSemiontBrowser(registry.SemiontBrowserConfig{Storage: w.storage, SessionFactory: gate})
		must(t, err)
		closedAtTheEnd(t, browser)
		// Before the session is up: the other context opens one more.
		byKb := map[string][]map[string]any{}
		w.stored(registry.OpenResourcesByKbKey, &byKb)
		byKb[kbA] = append(byKb[kbA], map[string]any{"id": "sibling", "name": "Sibling", "openedAt": 9, "order": 9})
		must(t, elsewhere.Set(registry.OpenResourcesByKbKey, string(marshal(byKb))))
		close(gate.open)

		live(t, browser)

		if !equalStrings(open(browser), []string{"sibling"}) || !equalStrings(w.storedOpen(kbA), []string{"sibling"}) {
			t.Errorf("open %v, stored %v", open(browser), w.storedOpen(kbA))
		}
	})
}

func conflict(browser *registry.SemiontBrowser) *semiont.KbIdentityConflict {
	if signals := browser.ActiveSignals().Value(); signals != nil {
		return signals.KbIdentityConflict().Value()
	}
	return nil
}

func TestADifferentKnowledgeBaseAnsweringVoidsWhatWasOpenAndIsRaised(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		w.with(kbOfA(), kbOfB()).opened(kbA, "a1", "a2")
		w.opened(kbB, "b1")
		must(t, w.storage.Set(registry.LastViewedResourceByKbKey, `{"kb-a":"a1","kb-b":"b1"}`))
		w.factory.says(kbA, description("KB B", "example.org:kb-b", "main"))
		browser := w.browser()
		live(t, browser)

		if len(open(browser)) != 0 || len(w.storedOpen(kbA)) != 0 || !browser.LastViewedResource().Value().IsZero() {
			t.Error("what was open in A was not voided")
		}
		// Only the active one's: the other keeps both.
		if !equalStrings(w.storedOpen(kbB), []string{"b1"}) || !reflect.DeepEqual(w.storedLastViewed(), map[string]string{kbB: "b1"}) {
			t.Errorf("B's: open %v, last viewed %v", w.storedOpen(kbB), w.storedLastViewed())
		}
		if got := conflict(browser); got == nil || *got != (semiont.KbIdentityConflict{ExpectedDid: didA, ObservedDid: didB}) {
			t.Errorf("the conflict raised is %+v", got)
		}
		// The entry is as it was written: nothing of the other is put on it.
		if !same(t, browser.KnowledgeBases().Value()[0], kbOfA()) {
			t.Errorf("the entry is now %+v", browser.KnowledgeBases().Value()[0])
		}
		// And no resource was asked about: those answers would be the wrong
		// one's.
		if asked := w.factory.askedAbout(kbA); len(asked) != 0 {
			t.Errorf("A was asked about %v", asked)
		}
	})
}

func TestTheKnowledgeBaseAnsweringAsItselfChangesNothingAndIsRecorded(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		w.with(kbOfA()).opened(kbA, "a1")
		w.factory.says(kbA, description("KB A, as it says", "example.org:kb-a", "main"))
		browser := w.browser()
		live(t, browser)

		if !equalStrings(open(browser), []string{"a1"}) || conflict(browser) != nil {
			t.Error("an answer as itself changed what is open, or raised a conflict")
		}
		entry := browser.KnowledgeBases().Value()[0]
		if entry.Label != "KB A, as it says" || entry.LastRead == nil || entry.LastRead.GitBranch == nil || *entry.LastRead.GitBranch != "main" {
			t.Errorf("the entry is %+v", entry)
		}

		// And a new registry on the storage reads what was recorded.
		must(t, browser.Close())
		if !same(t, w.browser().KnowledgeBases().Value()[0], entry) {
			t.Error("a new registry does not read what was recorded")
		}
	})
}

func TestNoAnswerAndARefusalToSayAreNoVerdictAndVoidNothing(t *testing.T) {
	for _, refusing := range []bool{false, true} {
		t.Run(fmt.Sprintf("refusing %v", refusing), func(t *testing.T) {
			bubble(t, func(t *testing.T, w *world) {
				w.with(kbOfA()).opened(kbA, "a1")
				if refusing {
					w.factory.behind.mu.Lock()
					w.factory.behind.describes[kbA] = describes{refusing: true}
					w.factory.behind.mu.Unlock()
				}
				browser := w.browser()
				live(t, browser)

				if !equalStrings(open(browser), []string{"a1"}) || conflict(browser) != nil || !same(t, browser.KnowledgeBases().Value()[0], kbOfA()) {
					t.Error("no verdict voided or changed something")
				}
				// The resources were checked all the same.
				if asked := w.factory.askedAbout(kbA); !equalStrings(asked, []string{"a1"}) {
					t.Errorf("A was asked about %v", asked)
				}
				if verdict, err := browser.ReadActiveKb(context.Background()); err != nil || verdict.Kind != registry.KbReadNoVerdict {
					t.Errorf("asked again, it says %+v, %v", verdict, err)
				}
			})
		})
	}
}

func TestAskingTheActiveKnowledgeBaseAgainRecordsWhatItSaysNow(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		w.with(kbOfA())
		w.factory.says(kbA, description("KB A", "example.org:kb-a", "main"))
		browser := w.browser()
		live(t, browser)
		asked := w.factory.askedWho(kbA)

		w.factory.says(kbA, description("KB A", "example.org:kb-a", ""))
		if verdict, err := browser.ReadActiveKb(context.Background()); err != nil || verdict.Kind != registry.KbReadRecorded {
			t.Fatalf("asked again, it says %+v, %v", verdict, err)
		}

		if got := w.factory.askedWho(kbA); got != asked+1 {
			t.Errorf("it was asked who it is %d times, not %d", got, asked+1)
		}
		// A tree that is on no branch is recorded as on none.
		if read := browser.KnowledgeBases().Value()[0].LastRead; read == nil || read.GitBranch != nil {
			t.Errorf("what it last said is %+v", read)
		}
	})
}

func TestAskingAgainReportsADifferentKnowledgeBaseAndActsOnNothing(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		w.with(kbOfA()).opened(kbA, "a1")
		w.factory.says(kbA, description("KB A", "example.org:kb-a", ""))
		browser := w.browser()
		live(t, browser)
		must(t, browser.SetLastViewedResource(id("a1")))

		w.factory.says(kbA, description("KB B", "example.org:kb-b", ""))
		verdict, err := browser.ReadActiveKb(context.Background())
		must(t, err)

		if verdict != (registry.KbReadVerdict{Kind: registry.KbReadConflict, ObservedDid: didB, ObservedName: "KB B"}) {
			t.Errorf("asked again, it says %+v", verdict)
		}
		// Asking is not activating: nothing is voided, and nothing is raised.
		if !equalStrings(open(browser), []string{"a1"}) || browser.LastViewedResource().Value().String() != "a1" || conflict(browser) != nil {
			t.Error("asking again voided or raised something")
		}
		if label := browser.KnowledgeBases().Value()[0].Label; label != "KB A" {
			t.Errorf("the entry is now named %q", label)
		}
	})
}

func TestAskingAgainDoesNotRaiseAConflictThatWasAcknowledged(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		w.with(kbOfA())
		w.factory.says(kbA, description("KB B", "example.org:kb-b", ""))
		browser := w.browser()
		live(t, browser)
		if conflict(browser) == nil {
			t.Fatal("no conflict was raised")
		}
		browser.ActiveSignals().Value().AcknowledgeKbIdentityConflict()

		if verdict, err := browser.ReadActiveKb(context.Background()); err != nil || verdict.Kind != registry.KbReadConflict {
			t.Errorf("asked again, it says %+v, %v", verdict, err)
		}
		if conflict(browser) != nil {
			t.Error("asking again raised the conflict again")
		}
	})
}

func TestWithNoSessionThereIsNothingToAsk(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		if verdict, err := w.browser().ReadActiveKb(context.Background()); err != nil || verdict.Kind != registry.KbReadNoVerdict {
			t.Errorf("with no session, it says %+v, %v", verdict, err)
		}
	})
}

// ── What the session's transport fails at ───────────────────────────────

func refusal(code semiont.TransportErrorCode, status int) *semiont.TransportError {
	return &semiont.TransportError{Code: code, Message: fmt.Sprintf("HTTP %d", status)}
}

func sessionEnded(browser *registry.SemiontBrowser) *semiont.SessionEnded {
	if signals := browser.ActiveSignals().Value(); signals != nil {
		return signals.SessionEnded().Value()
	}
	return nil
}

func denied(browser *registry.SemiontBrowser) *semiont.PermissionDenied {
	if signals := browser.ActiveSignals().Value(); signals != nil {
		return signals.PermissionDenied().Value()
	}
	return nil
}

func TestARefusalForWantOfATokenRenewsTheSessionQuietlyWhenItCan(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		w.with(kbOfA())
		renewed := jwt(2 * time.Hour)
		w.factory.sessions.QueueRenewals(semionttest.Renewal{Token: renewed})
		browser := w.browser()
		session := live(t, browser)

		w.factory.sessions.Transports(kbA)[0].Fail(refusal(semiont.TransportErrorCodeUnauthorized, 401))
		settle()

		if renewals := w.factory.sessions.Renewed(); renewals != 1 {
			t.Errorf("%d renewals were asked for", renewals)
		}
		if session.Token().Value() != renewed || sessionEnded(browser) != nil {
			t.Error("the session was not renewed quietly")
		}
		if _, ok := registry.StoredSessionOf(w.storage, kbA); !ok {
			t.Error("the credential is gone")
		}
	})
}

func TestASessionThatCannotBeRenewedIsSaidToHaveExpiredAndItsCredentialIsGone(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		w.with(kbOfA())
		// The issuer has nothing to renew it with.
		w.factory.sessions.QueueRenewals(semionttest.Renewal{})
		browser := w.browser()
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		errs := browser.Errors(ctx)
		live(t, browser)

		w.factory.sessions.Transports(kbA)[0].Fail(refusal(semiont.TransportErrorCodeUnauthorized, 401))
		settle()

		if got := sessionEnded(browser); got == nil || *got != (semiont.SessionEnded{Reason: semiont.SessionEndExpired}) {
			t.Errorf("the session ended as %+v", got)
		}
		if _, ok := registry.StoredSessionOf(w.storage, kbA); ok {
			t.Error("the credential is still stored")
		}
		var said *semiont.SessionError
		for err := range errs {
			said = err
			break
		}
		if said == nil || said.Code != semiont.SessionErrorCodeRefreshExhausted {
			t.Errorf("the failure said is %+v", said)
		}

		// The refusals that follow find nothing stored, and say nothing more.
		browser.ActiveSignals().Value().AcknowledgeSessionEnded()
		w.factory.sessions.Transports(kbA)[0].Fail(refusal(semiont.TransportErrorCodeUnauthorized, 401))
		settle()
		if got := sessionEnded(browser); got != nil {
			t.Errorf("the session ended again, as %+v", got)
		}
	})
}

func TestARefusalWithNothingStoredIsBeingSignedOutAndNotAnExpiry(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		must(t, registry.SaveKnowledgeBases(w.storage, []api.KnowledgeBase{kbOfA()}))
		browser := w.browser()
		live(t, browser)

		w.factory.sessions.Transports(kbA)[0].Fail(refusal(semiont.TransportErrorCodeUnauthorized, 401))
		settle()

		if got := sessionEnded(browser); got != nil {
			t.Errorf("a session signed out ended as %+v", got)
		}
	})
}

func TestARefusalForLackOfPermissionIsSaidAndAnyOtherFailureIsNot(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		browser := w.with(kbOfA()).browser()
		live(t, browser)
		transport := w.factory.sessions.Transports(kbA)[0]

		transport.Fail(refusal(semiont.TransportErrorCodeNotFound, 404))
		transport.Fail(refusal(semiont.TransportErrorCodeConflict, 409))
		transport.Fail(refusal(semiont.TransportErrorCodeError, 500))
		transport.Fail(refusal(semiont.TransportErrorCodeUnavailable, 503))
		settle()
		if denied(browser) != nil || sessionEnded(browser) != nil || w.factory.sessions.Renewed() != 0 {
			t.Error("a failure that is no refusal of a token or of permission was acted on")
		}

		transport.Fail(refusal(semiont.TransportErrorCodeForbidden, 403))
		settle()
		if got := denied(browser); got == nil || got.Detail == nil || *got.Detail != "HTTP 403" {
			t.Errorf("the refusal said is %+v", got)
		}
		if sessionEnded(browser) != nil {
			t.Error("a refusal of permission ended the session")
		}
	})
}

// ── A write the storage refuses ─────────────────────────────────────────

var errFull = errors.New("the storage is full")

// refusing is a storage that, while it refuses a kind of write, takes none of
// that kind: what it holds stays as it was.
type refusing struct {
	*semionttest.SharedStorage
	sets, deletes, updates atomic.Bool
}

func (r *refusing) Set(key, value string) error {
	if r.sets.Load() {
		return errFull
	}
	return r.SharedStorage.Set(key, value)
}

func (r *refusing) Delete(key string) error {
	if r.deletes.Load() {
		return errFull
	}
	return r.SharedStorage.Delete(key)
}

// Update is told what to store, and refuses to store it.
func (r *refusing) Update(key string, change func(stored string, has bool) (string, bool)) error {
	if r.updates.Load() {
		change(r.Get(key))
		return errFull
	}
	return r.SharedStorage.Update(key, change)
}

func TestARegistryOverAStorageThatRefusesWhatItReadIsNotMade(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		w.with(kbOfA())
		storage := &refusing{SharedStorage: w.storage}
		storage.sets.Store(true)

		if _, err := registry.NewSemiontBrowser(registry.SemiontBrowserConfig{Storage: storage, SessionFactory: w.factory.sessions}); !errors.Is(err, errFull) {
			t.Fatalf("made over a storage that refuses, it says %v", err)
		}
		settle()
		if built := len(w.factory.sessions.Transports(kbA)); built != 0 {
			t.Errorf("%d sessions were built", built)
		}
	})
}

func TestAKnowledgeBaseWhoseTokensTheStorageWillNotForgetIsNotRemoved(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		w.with(kbOfA(), kbOfB())
		storage := &refusing{SharedStorage: w.storage}
		browser := w.browserOver(storage)
		live(t, browser)
		storage.deletes.Store(true)

		if err := browser.RemoveKb(kbA); !errors.Is(err, errFull) {
			t.Fatalf("removing A says %v", err)
		}
		both := []api.KnowledgeBase{kbOfA(), kbOfB()}
		if !same(t, browser.KnowledgeBases().Value(), both) || !same(t, registry.LoadKnowledgeBases(w.storage), both) {
			t.Errorf("registered %+v, stored %+v", browser.KnowledgeBases().Value(), registry.LoadKnowledgeBases(w.storage))
		}
		if _, ok := registry.StoredSessionOf(w.storage, kbA); !ok {
			t.Error("A's tokens are gone")
		}
		if sessionOf(browser) != kbA || closed(w.factory.sessions.Transports(kbA)[0]) {
			t.Error("A's session did not stay")
		}
	})
}

func TestASignOutTheStorageWillNotKeepLeavesTheSessionAsItWas(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		w.with(kbOfA())
		storage := &refusing{SharedStorage: w.storage}
		browser := w.browserOver(storage)
		live(t, browser)
		storage.deletes.Store(true)

		if err := browser.SignOut(kbA); !errors.Is(err, errFull) {
			t.Fatalf("signing out says %v", err)
		}
		settle()
		if refresh, ok := w.storedRefresh(kbA); !ok || refresh != "r" {
			t.Errorf("the stored refresh token is %q", refresh)
		}
		if sessionOf(browser) != kbA || closed(w.factory.sessions.Transports(kbA)[0]) {
			t.Error("the session did not stay")
		}
		if revoked := w.factory.sessions.Revoked(); len(revoked) != 0 {
			t.Errorf("the issuer was told: %+v", revoked)
		}
	})
}

func TestMakingNoneActiveWhenTheStorageWillNotForgetTheActiveOneChangesNothing(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		w.with(kbOfA())
		storage := &refusing{SharedStorage: w.storage}
		browser := w.browserOver(storage)
		live(t, browser)
		storage.deletes.Store(true)

		if err := browser.SetActiveKb(""); !errors.Is(err, errFull) {
			t.Fatalf("making none active says %v", err)
		}
		if browser.ActiveKbId().Value() != kbA || sessionOf(browser) != kbA {
			t.Errorf("the active one is %q, its session %q", browser.ActiveKbId().Value(), sessionOf(browser))
		}
		if active, _ := w.storage.Get(registry.ActiveKey); active != kbA {
			t.Errorf("the active one is stored as %q", active)
		}
	})
}

func TestAnAnswerTheStorageWillNotRecordIsWhatAskingAgainSays(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		w.with(kbOfA())
		w.factory.says(kbA, description("KB A", "example.org:kb-a", ""))
		storage := &refusing{SharedStorage: w.storage}
		browser := w.browserOver(storage)
		live(t, browser)
		storage.sets.Store(true)

		w.factory.says(kbA, description("KB A, renamed", "example.org:kb-a", ""))
		if _, err := browser.ReadActiveKb(context.Background()); !errors.Is(err, errFull) {
			t.Fatalf("asking again says %v", err)
		}
		if label := browser.KnowledgeBases().Value()[0].Label; label != "KB A" {
			t.Errorf("the entry is now named %q", label)
		}
		if label := registry.LoadKnowledgeBases(w.storage)[0].Label; label != "KB A" {
			t.Errorf("the entry is stored as %q", label)
		}
	})
}

func TestACheckTheStorageWillNotKeepIsWhatClosingSays(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		w.with(kbOfA()).opened(kbA, "kept", "gone")
		w.factory.behind.mu.Lock()
		w.factory.behind.gone["gone"] = true
		w.factory.behind.mu.Unlock()
		storage := &refusing{SharedStorage: w.storage}
		storage.updates.Store(true)
		browser := w.browserOver(storage)
		live(t, browser)

		// What is open is as it was, there and here.
		want := []string{"kept", "gone"}
		if !equalStrings(open(browser), want) || !equalStrings(w.storedOpen(kbA), want) {
			t.Errorf("open %v, stored %v", open(browser), w.storedOpen(kbA))
		}
		if err := browser.Close(); !errors.Is(err, errFull) {
			t.Errorf("closing says %v", err)
		}
	})
}

// ── How it ends ─────────────────────────────────────────────────────────

func TestClosingTheRegistryClosesItsSessionAndEndsWhatItHolds(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		browser := w.with(kbOfA()).browser()
		live(t, browser)
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		errs := browser.Errors(ctx)

		must(t, browser.Close())
		must(t, browser.Close())

		if !closed(w.factory.sessions.Transports(kbA)[0]) {
			t.Error("the session is not closed")
		}
		if !ended(browser.KnowledgeBases()) || !ended(browser.ActiveSession()) || !ended(browser.ActiveSignals()) {
			t.Error("what the registry holds has not ended")
		}
		for range browser.Bus().FramesAmong(ctx) {
			t.Error("the application's bus still delivers")
		}
		for err := range errs {
			t.Errorf("a failure is said after closing: %+v", err)
		}
		if ctx.Err() != nil {
			t.Error("the bus or the failures did not end")
		}
		// Nothing it is told afterwards does anything, and what is stored stays.
		must(t, browser.SetActiveKb(""))
		must(t, browser.SignIn(kbA, tokens("late")))
		if active, _ := w.storage.Get(registry.ActiveKey); active != kbA {
			t.Errorf("the active one is stored as %q", active)
		}
		if refresh, _ := w.storedRefresh(kbA); refresh != "r" {
			t.Errorf("the stored refresh token is %q", refresh)
		}
	})
}

// closingAsItBuilds is a factory that closes its registry while the registry
// is building the session it began with, and says what closing returned.
type closingAsItBuilds struct {
	registry.SessionFactory
	browser chan *registry.SemiontBrowser
	closed  chan error
}

func (c closingAsItBuilds) Session(ctx context.Context, _ registry.SessionFactoryOptions) (*semiont.Session, func(), error) {
	c.closed <- (<-c.browser).Close()
	// Closing ended the registry's wait for this session, which is never built.
	<-ctx.Done()
	return nil, nil, ctx.Err()
}

func TestClosingFromWithinTheFactoryEndsTheRegistryWithoutWaitingForItself(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		w.with(kbOfA())
		factory := closingAsItBuilds{SessionFactory: w.factory.sessions, browser: make(chan *registry.SemiontBrowser, 1), closed: make(chan error, 1)}
		browser, err := registry.NewSemiontBrowser(registry.SemiontBrowserConfig{Storage: w.storage, SessionFactory: factory})
		must(t, err)
		factory.browser <- browser

		must(t, <-factory.closed)
		if !ended(browser.KnowledgeBases()) || !ended(browser.ActiveSession()) || !ended(browser.ActiveSignals()) {
			t.Error("what the registry holds has not ended")
		}
		// Closing again is closing once.
		must(t, browser.Close())
	})
}

// deaf is a factory that builds a session once the test lets it, and does not
// hear the registry end meanwhile.
type deaf struct {
	registry.SessionFactory
	asked chan struct{}
	open  chan struct{}
}

func (d deaf) Session(_ context.Context, options registry.SessionFactoryOptions) (*semiont.Session, func(), error) {
	close(d.asked)
	<-d.open
	return d.SessionFactory.Session(context.Background(), options)
}

func TestClosingDoesNotWaitForAFactoryThatDoesNotHearTheRegistryEnd(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		w.with(kbOfA())
		factory := deaf{SessionFactory: w.factory.sessions, asked: make(chan struct{}), open: make(chan struct{})}
		browser, err := registry.NewSemiontBrowser(registry.SemiontBrowserConfig{Storage: w.storage, SessionFactory: factory})
		must(t, err)
		<-factory.asked

		// The factory is still building: closing returns all the same.
		must(t, browser.Close())
		if !ended(browser.ActiveSession()) || sessionOf(browser) != "" {
			t.Error("a session is shown after closing")
		}

		// What the factory hands back afterwards is ended at once.
		close(factory.open)
		synctest.Wait()
		if !closed(w.factory.sessions.Transports(kbA)[0]) {
			t.Error("the session built after closing is still open")
		}
	})
}
