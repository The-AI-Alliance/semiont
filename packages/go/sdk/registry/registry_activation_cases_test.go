package registry_test

// protocol/specs/src/session/registry-activation-cases.json: how a registry
// activates a knowledge base when its factory refuses the session, once its
// close has begun, and when another knowledge base's session is active; and
// protocol/specs/src/session/registry-factory-failure-cases.json: what it
// says when its factory fails with something that is not one of the
// session's own errors. Every row is run here, and a difference fails.
//
// Every row's factory takes a step for each knowledge base it is asked for a
// session of, in order, and then refuses as the row says or builds the
// session. A refused row runs in a bubble, over a storage in which kb-a is
// registered with a sign-in kept, and its factory refuses at once. A closed
// or switching row runs over the stage, kb-a and kb-b registered there, their
// sessions built by keepingSessions: a fresh read of a resource leaves kb-a's
// client owing its save, still waiting out its debounce, and its caches take
// a step as that save's write is asked for, in the list the factory takes its
// steps in. So switching holds the order of the two to the rule, and closing
// holds that write open, activating kb-b from within it and from the test
// while it is held.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/registry"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/semionttest"
)

// registryActivationCases is the activation table. Each code is read as the
// generated vocabulary's type, whose constants are errors/codes.json's codes.
type registryActivationCases struct {
	Comment       string                   `json:"$comment"`
	RunBy         map[string][]string      `json:"runBy"`
	NotYetReached map[string]string        `json:"notYetReached"`
	Refused       []activationRefusedRow   `json:"refused"`
	Closed        []activationClosedRow    `json:"closed"`
	Switching     []activationSwitchingRow `json:"switching"`
}

// ownError is one of the session's own errors, by its code, with its
// message.
type ownError struct {
	Own     semiont.SessionErrorCode `json:"own"`
	Message string                   `json:"message"`
}

// saidError is what a registry says on its errors, by its code and its
// message.
type saidError struct {
	Code    semiont.SessionErrorCode `json:"code"`
	Message string                   `json:"message"`
}

type activationRefusedRow struct {
	Why            string      `json:"why"`
	Refusal        ownError    `json:"refusal"`
	RegistryErrors []saidError `json:"registryErrors"`
}

type activationClosedRow struct {
	Why   string `json:"why"`
	While string `json:"while"`
}

type activationSwitchingRow struct {
	Why     string `json:"why"`
	Storage string `json:"storage"`
	// Next is "built", or the refusal of the next session, as ownError.
	Next           json.RawMessage            `json:"next"`
	RegistryErrors []semiont.SessionErrorCode `json:"registryErrors"`
	Active         *bool                      `json:"active"`
}

// registryFactoryFailureCases is the factory-failure table.
type registryFactoryFailureCases struct {
	Comment       string              `json:"$comment"`
	RunBy         map[string][]string `json:"runBy"`
	Absent        map[string]string   `json:"absent"`
	NotYetReached map[string]string   `json:"notYetReached"`
	Cases         []factoryFailureRow `json:"cases"`
}

type factoryFailureRow struct {
	Why     string `json:"why"`
	Failure struct {
		Transport semiont.TransportErrorCode `json:"transport"`
		Message   string                     `json:"message"`
	} `json:"failure"`
	RegistryErrors []saidError `json:"registryErrors"`
}

func TestTheRegistryActivationCases(t *testing.T) {
	var table registryActivationCases
	readSessionTable(t, "registry-activation-cases.json", &table)
	if len(table.Refused) == 0 || len(table.Closed) == 0 || len(table.Switching) == 0 {
		t.Fatal("a part of the registry's activation cases has no rows")
	}
	t.Run("refused", func(t *testing.T) {
		for _, row := range table.Refused {
			t.Run(row.Why, func(t *testing.T) {
				if row.Refusal.Own == "" || row.Refusal.Message == "" || row.RegistryErrors == nil {
					t.Fatal("the row states no refusal by its code and its message, or no registryErrors")
				}
				runRefused(t, &semiont.SessionError{Code: row.Refusal.Own, Message: row.Refusal.Message, KbID: kbA}, row.RegistryErrors)
			})
		}
	})
	t.Run("closed", func(t *testing.T) {
		for _, row := range table.Closed {
			t.Run(row.Why, func(t *testing.T) { runActivationClosed(t, row) })
		}
	})
	t.Run("switching", func(t *testing.T) {
		for _, row := range table.Switching {
			t.Run(row.Why, func(t *testing.T) { runActivationSwitching(t, row) })
		}
	})
}

func TestTheRegistryFactoryFailureCases(t *testing.T) {
	var table registryFactoryFailureCases
	readSessionTable(t, "registry-factory-failure-cases.json", &table)
	if len(table.Cases) == 0 {
		t.Fatal("the registry's factory-failure cases have no rows")
	}
	for _, row := range table.Cases {
		t.Run(row.Why, func(t *testing.T) {
			if row.Failure.Transport == "" || row.Failure.Message == "" || row.RegistryErrors == nil {
				t.Fatal("the row states no failure by its code and its message, or no registryErrors")
			}
			runRefused(t, &semiont.TransportError{Code: row.Failure.Transport, Message: row.Failure.Message}, row.RegistryErrors)
		})
	}
}

// ── What a row's factory and caches were asked ──────────────────────────

// steps is what a row's factory was asked for, and its caches asked to
// write, in the order each was.
type steps struct {
	mu    sync.Mutex
	taken []string
}

func (s *steps) take(step string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.taken = append(s.taken, step)
}

func (s *steps) sofar() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.taken)
}

func askedFor(kbID string) string { return "asked for " + kbID }

const wroteTheOwedSave = "wrote the owed save"

// recording is a factory that takes a step for each knowledge base it is
// asked for a session of, and then refuses with that knowledge base's
// refusal, or has its SessionFactory build the session.
type recording struct {
	registry.SessionFactory
	steps    *steps
	refusals map[string]error
}

func (r recording) Session(ctx context.Context, options registry.SessionFactoryOptions) (*semiont.Session, func(), error) {
	r.steps.take(askedFor(options.Kb.Id))
	if refusal, ok := r.refusals[options.Kb.Id]; ok {
		return nil, nil, refusal
	}
	return r.SessionFactory.Session(ctx, options)
}

// owedSave is where the save kb-a's client owes is written: what it keeps,
// for alice, of the resource it read.
var owedSave = semiont.CacheKey(kbA, alicesKey, semiont.CacheQueryResource)

// ofTheFirstClient is whether key is one kb-a's client writes under: its
// kept queries' documents, and its stream's place.
func ofTheFirstClient(key string) bool {
	return key == semiont.LastEventIDKey(kbA, alicesKey) || slices.ContainsFunc(semiont.PersistedCacheQueries, func(query semiont.CacheQuery) bool {
		return key == semiont.CacheKey(kbA, alicesKey, query)
	})
}

// steppedCaches is the caches of the stage's sessions. Its write of the owed
// save takes a step as it is asked for, and the first such write runs within
// first, unless it is nil, holding the write open while it runs. While
// refuses holds, it refuses every write of kb-a's client.
type steppedCaches struct {
	*semionttest.SharedStorage
	steps   *steps
	refuses atomic.Bool
	within  func()
	once    sync.Once
}

func (c *steppedCaches) Set(key, value string) error {
	if key == owedSave {
		c.steps.take(wroteTheOwedSave)
		if c.within != nil {
			c.once.Do(c.within)
		}
	}
	if c.refuses.Load() && ofTheFirstClient(key) {
		return errFull
	}
	return c.SharedStorage.Set(key, value)
}

func (c *steppedCaches) Delete(key string) error {
	if c.refuses.Load() && ofTheFirstClient(key) {
		return errFull
	}
	return c.SharedStorage.Delete(key)
}

// Update is told what to store, and refuses to store it, while it refuses.
func (c *steppedCaches) Update(key string, change func(stored string, has bool) (string, bool)) error {
	if c.refuses.Load() && ofTheFirstClient(key) {
		change(c.Get(key))
		return errFull
	}
	return c.SharedStorage.Update(key, change)
}

// refusedAsClosed is whether err refuses an activation because the
// registry's close has begun.
func refusedAsClosed(err error) bool {
	var refused *semiont.BusRequestError
	return errors.As(err, &refused) && refused.Code == semiont.BusRequestErrorCodeClosed
}

// refusalOfNext is the refusal of a switching row's next session; nil when
// it is built.
func refusalOfNext(t *testing.T, next json.RawMessage) *ownError {
	t.Helper()
	var built string
	if json.Unmarshal(next, &built) == nil {
		if built != "built" {
			t.Fatalf("this runner knows no next session that is %q", built)
		}
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(next))
	decoder.DisallowUnknownFields()
	var refusal ownError
	if err := decoder.Decode(&refusal); err != nil || refusal.Own == "" || refusal.Message == "" {
		t.Fatalf("this runner knows no next session that is %s", next)
	}
	return &refusal
}

// ── refused, and the factory's other failures ───────────────────────────

// runRefused has a registry of kb-a, with a sign-in kept and no session
// active, activate it over a factory that refuses with refusal, and holds
// what the registry said on its errors once the activation had returned,
// each by its code and its message, to want. Then its factory was asked for
// one session, none is active, and the storage's active key names kb-a.
func runRefused(t *testing.T, refusal error, want []saidError) {
	bubble(t, func(t *testing.T, w *world) {
		w.with(kbOfA())
		asked := &steps{}
		factory := recording{SessionFactory: w.factory.sessions, steps: asked, refusals: map[string]error{kbA: refusal}}
		browser, err := registry.NewSemiontBrowser(registry.SemiontBrowserConfig{Storage: w.storage, SessionFactory: factory})
		must(t, err)
		closedAtTheEnd(t, browser)
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		heard := hearRegistry(ctx, browser)
		settle()

		said := []saidError{}
		for _, each := range heard.sofar() {
			said = append(said, saidError{Code: each.Code, Message: each.Message})
		}
		if !slices.Equal(said, want) {
			t.Errorf("the registry said %v on its errors; the row's are %v", said, want)
		}
		if got := asked.sofar(); !slices.Equal(got, []string{askedFor(kbA)}) {
			t.Errorf("the factory was %v", got)
		}
		if browser.ActiveSession().Value() != nil || browser.ActiveSignals().Value() != nil || browser.SessionActivating().Value() {
			t.Error("a session that was refused left something")
		}
		if active, _ := w.storage.Get(registry.ActiveKey); active != kbA {
			t.Errorf("the storage's active key names %q", active)
		}
	})
}

// ── closed ──────────────────────────────────────────────────────────────

// runActivationClosed has a registry with kb-a's session active activate
// kb-b once its close has returned, kb-a's client owing nothing; or while its
// close waits for the write of the save kb-a's client owes, from within that
// write and from the test while it is held. Each activation is refused with
// bus.closed: the factory is asked for no session, nothing is said, the
// storage's active key still names kb-a, and a second close does nothing.
func runActivationClosed(t *testing.T, row activationClosedRow) {
	if row.While != "closed" && row.While != "closing" {
		t.Fatalf("while %q is none this runner knows", row.While)
	}
	s := newStage(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	kept := &semiont.MemorySignIn{}
	keptNamingAlice(ctx, t, s, kept)
	asked := &steps{}
	caches := &steppedCaches{SharedStorage: semionttest.NewSharedStorage(), steps: asked}
	factory := recording{SessionFactory: keepingSessions{stage: s, kept: kept, caches: caches, saveWait: time.Hour}, steps: asked}
	browser := stagedRegistry(t, s, factory, kbA, kbB)
	heard := hearRegistry(ctx, browser)
	session := liveOver(t, browser)

	var refusals []error
	want := []string{askedFor(kbA)}
	switch row.While {
	case "closed":
		until(t, "the client owes nothing", session.Client().PersistenceSettled)
		must(t, browser.Close())
		refusals = append(refusals, browser.SetActiveKb(kbB))
	case "closing":
		owingItsSave(ctx, t, session)
		fromWithin := make(chan error, 1)
		entered, release := make(chan struct{}), make(chan struct{})
		caches.within = func() {
			fromWithin <- browser.SetActiveKb(kbB)
			close(entered)
			select {
			case <-release:
			case <-ctx.Done():
			}
		}
		closing := make(chan error, 1)
		go func() { closing <- browser.Close() }()
		select {
		case <-entered:
		case <-ctx.Done():
			t.Fatal("the registry's close never wrote the save its session's client owed")
		}
		refusals = append(refusals, <-fromWithin, browser.SetActiveKb(kbB))
		close(release)
		select {
		case err := <-closing:
			must(t, err)
		case <-ctx.Done():
			t.Fatal("the registry's close did not return once the write it waited for was let go")
		}
		want = append(want, wroteTheOwedSave)
	}

	for _, refusal := range refusals {
		if !refusedAsClosed(refusal) {
			t.Errorf("an activation begun once the registry's close had begun returned %v", refusal)
		}
	}
	if got := asked.sofar(); !slices.Equal(got, want) {
		t.Errorf("the factory and the caches were %v; the row's are %v", got, want)
	}
	if said := codesOf(heard.rest(t)); len(said) != 0 {
		t.Errorf("the registry said %v on its errors", said)
	}
	if active, _ := browser.Storage().Get(registry.ActiveKey); active != kbA {
		t.Errorf("the storage's active key names %q", active)
	}
	must(t, browser.Close())
	if got := asked.sofar(); !slices.Equal(got, want) {
		t.Errorf("a second close left the factory and the caches %v", got)
	}
}

// ── switching ───────────────────────────────────────────────────────────

// runActivationSwitching has a registry with kb-a's session active, its
// client owing its save to caches that write it or refuse every write of that
// client, activate kb-b over a factory that builds its session or refuses
// with the row's refusal. kb-a's session ends, its owed save asked to be
// written once, before the factory is asked for kb-b's. What the registry
// says on its errors is read until they end, once it has closed: kb-b's
// session, if there is one, owes nothing as it closes.
func runActivationSwitching(t *testing.T, row activationSwitchingRow) {
	if row.Storage != "writes" && row.Storage != "refuses" {
		t.Fatalf("a storage that %q is none this runner knows", row.Storage)
	}
	if row.RegistryErrors == nil || row.Active == nil {
		t.Fatal("the row states no registryErrors, or no active")
	}
	next := refusalOfNext(t, row.Next)
	s := newStage(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	kept := &semiont.MemorySignIn{}
	keptNamingAlice(ctx, t, s, kept)
	asked := &steps{}
	caches := &steppedCaches{SharedStorage: semionttest.NewSharedStorage(), steps: asked}
	refusals := map[string]error{}
	if next != nil {
		refusals[kbB] = &semiont.SessionError{Code: next.Own, Message: next.Message, KbID: kbB}
	}
	factory := recording{SessionFactory: keepingSessions{stage: s, kept: kept, caches: caches, saveWait: time.Hour}, steps: asked, refusals: refusals}
	browser := stagedRegistry(t, s, factory, kbA, kbB)
	heard := hearRegistry(ctx, browser)
	owingItsSave(ctx, t, liveOver(t, browser))
	caches.refuses.Store(row.Storage == "refuses")

	must(t, browser.SetActiveKb(kbB))

	if got, want := asked.sofar(), []string{askedFor(kbA), wroteTheOwedSave, askedFor(kbB)}; !slices.Equal(got, want) {
		t.Errorf("the factory and the caches were %v; the rule's order is %v", got, want)
	}
	if active := browser.ActiveSession().Value() != nil; active != *row.Active {
		t.Errorf("a session is active: %v; the row says %v", active, *row.Active)
	}
	if id := browser.ActiveKbId().Value(); id != kbB {
		t.Errorf("the knowledge base active is %q", id)
	}
	if active, _ := browser.Storage().Get(registry.ActiveKey); active != kbB {
		t.Errorf("the storage's active key names %q", active)
	}
	must(t, browser.Close())
	if said := codesOf(heard.rest(t)); !slices.Equal(said, row.RegistryErrors) {
		t.Errorf("the registry said %v on its errors; the row's are %v", said, row.RegistryErrors)
	}
}
