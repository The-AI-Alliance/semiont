package semiont_test

// The root package's state units held to the state-unit axioms (the cache,
// the session, the session's signals), what the session's signals' cases in
// specs/src/client/state-units.json cannot count, and the census that every
// state unit of the module is held to the axioms somewhere.

import (
	"context"
	"io/fs"
	"iter"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"
	"testing/synctest"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/semionttest"
)

func TestTheCacheKeepsTheStateUnitAxioms(t *testing.T) {
	semionttest.AssertStateUnitAxioms(t, semionttest.AxiomSubject[*semiont.Cache[string, int]]{
		Setup: func(t *testing.T) semionttest.Fresh[*semiont.Cache[string, int]] {
			fetch := func(context.Context, string) (int, error) { return 1, nil }
			run := func(work func(context.Context)) { go work(context.Background()) }
			return semionttest.Fresh[*semiont.Cache[string, int]]{Unit: semiont.NewCache(fetch, run, nil, semiont.DefaultTiming().SaveDebounce)}
		},
		// One key observed, and what moves a key.
		Surfaces: func(unit *semiont.Cache[string, int]) []semionttest.Surface {
			return []semionttest.Surface{semionttest.Events(func(ctx context.Context) iter.Seq[semiont.CacheState] { return unit.Observe(ctx, "a") })}
		},
		Invocations: func(unit *semiont.Cache[string, int]) []func() {
			return []func(){func() { unit.Set("a", 1) }, func() { unit.Invalidate("a") }, unit.InvalidateAll}
		},
	})
}

func TestASessionKeepsTheStateUnitAxiomsAndNeverClosesItsClient(t *testing.T) {
	semionttest.AssertStateUnitAxioms(t, semionttest.AxiomSubject[*semiont.Session]{
		Setup: func(t *testing.T) semionttest.Fresh[*semiont.Session] {
			made := semionttest.NewTestClient(semionttest.TestClientConfig{Timing: semiont.DefaultTiming()})
			t.Cleanup(func() {
				made.Client.Close()
				made.Transport.Close()
			})
			session, err := semiont.StartSession(context.Background(), semiont.SessionConfig{
				Kb:     api.KbTarget{Id: "kb-1"},
				Client: made.Client,
				Token:  semiont.NewVariable(""),
				Kept:   &semiont.MemorySignIn{},
				Timing: semiont.DefaultTiming(),
			})
			if err != nil {
				t.Fatal(err)
			}
			return semionttest.Fresh[*semiont.Session]{Unit: session}.With(semionttest.TheClient(made.Client))
		},
		// Its stream state and its errors are its client's, and end with it.
		Surfaces: func(unit *semiont.Session) []semionttest.Surface {
			return []semionttest.Surface{semionttest.Watching(unit.Token()), semionttest.Watching(unit.User())}
		},
	})
}

func TestTheSessionSignalsKeepTheStateUnitAxioms(t *testing.T) {
	conflict := semiont.KbIdentityConflict{ExpectedDid: "did:web:kb.example.org", ObservedDid: "did:web:other.example.org"}
	detail := "no"
	semionttest.AssertStateUnitAxioms(t, semionttest.AxiomSubject[*semiont.SessionSignals]{
		Setup: func(*testing.T) semionttest.Fresh[*semiont.SessionSignals] {
			return semionttest.Fresh[*semiont.SessionSignals]{Unit: semiont.NewSessionSignals()}
		},
		Surfaces: func(unit *semiont.SessionSignals) []semionttest.Surface {
			return []semionttest.Surface{
				semionttest.Watching(unit.SessionEnded()),
				semionttest.Watching(unit.PermissionDenied()),
				semionttest.Watching(unit.KbIdentityConflict()),
			}
		},
		Invocations: func(unit *semiont.SessionSignals) []func() {
			return []func(){
				func() { unit.NotifySessionEnded(semiont.SessionEndRefused) },
				func() { unit.NotifyPermissionDenied(&detail) },
				func() { unit.NotifyKbIdentityConflict(conflict) },
				unit.AcknowledgeSessionEnded,
				unit.AcknowledgePermissionDenied,
				unit.AcknowledgeKbIdentityConflict,
			}
		},
	})
}

// gathered is each value a reader of watched is given, read on a goroutine
// of its own until ctx is done.
func gathered[T any](ctx context.Context, watched semiont.Watched[T]) func() []T {
	var mu sync.Mutex
	var given []T
	go func() {
		for value := range watched.Changes(ctx) {
			mu.Lock()
			given = append(given, value)
			mu.Unlock()
		}
	}()
	return func() []T {
		synctest.Wait()
		mu.Lock()
		defer mu.Unlock()
		return slices.Clone(given)
	}
}

func TestASecondOccurrenceIsToldEvenWhenItSaysTheSame(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		signals := semiont.NewSessionSignals()
		defer signals.Close()
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		ended, denied := gathered(ctx, signals.SessionEnded()), gathered(ctx, signals.PermissionDenied())
		if len(ended()) != 1 || len(denied()) != 1 {
			t.Fatal("a reader was not first given what is raised now")
		}
		for occurrence := 2; occurrence <= 3; occurrence++ {
			signals.NotifySessionEnded(semiont.SessionEndExpired)
			signals.NotifyPermissionDenied(nil)
			told, refused := ended(), denied()
			if len(told) != occurrence || told[occurrence-1] == nil || told[occurrence-1].Reason != semiont.SessionEndExpired {
				t.Fatalf("occurrence %d of the session's end was not told: %v", occurrence, told)
			}
			if len(refused) != occurrence || refused[occurrence-1] == nil || refused[occurrence-1].Detail != nil {
				t.Fatalf("occurrence %d of the refusal was not told: %v", occurrence, refused)
			}
		}
	})
}

// ── The census ──────────────────────────────────────────────────────────

var (
	// declaredUnit is a type said to be a StateUnit where it is declared.
	declaredUnit = regexp.MustCompile(`(?m)^\s*(?:var\s+)?_\s+(?:semiont\.)?StateUnit\s*=\s*\(\*(\w+)`)
	// heldUnit is a unit a test hands to the axioms.
	heldUnit = regexp.MustCompile(`AxiomSubject\[\*(?:\w+\.)?(\w+)`)
	// commentLine is a line that is only a comment.
	commentLine = regexp.MustCompile(`(?m)^\s*//.*$`)
)

func TestEveryStateUnitIsHeldToTheAxioms(t *testing.T) {
	declared := map[string]string{}
	held := map[string]bool{}
	err := filepath.WalkDir(".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		// The test double's probe and the conformance drivers are no unit of the SDK's.
		if entry.IsDir() && (path == "semionttest" || path == "conformance") {
			return filepath.SkipDir
		}
		if entry.IsDir() || !strings.HasSuffix(path, ".go") {
			return nil
		}
		text, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		code := commentLine.ReplaceAllString(string(text), "")
		if strings.HasSuffix(path, "_test.go") {
			for _, match := range heldUnit.FindAllStringSubmatch(code, -1) {
				held[match[1]] = true
			}
			return nil
		}
		for _, match := range declaredUnit.FindAllStringSubmatch(code, -1) {
			declared[match[1]] = path
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, known := range []string{"Cache", "Session", "SessionSignals", "MarkStateUnit", "SearchPipeline"} {
		if _, ok := declared[known]; !ok {
			t.Fatalf("the census read no %s: it reads no unit where it should", known)
		}
	}
	for unit, path := range declared {
		if !held[unit] {
			t.Errorf("%s: %s is a StateUnit that no test holds to the axioms (semionttest.AssertStateUnitAxioms)", path, unit)
		}
	}
}
