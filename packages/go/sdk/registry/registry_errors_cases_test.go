package registry_test

// protocol/specs/src/session/registry-errors-cases.json: how a registry reads
// the errors of each session it activates, as their one reader. Every row is
// run here, over a factory that reads none of its sessions' errors, and a
// difference fails.
//
// Two factories build the sessions. A session's own keep-failed and
// save-refused are said only by one whose client keeps what it holds, which
// semiont.SessionFromKept makes over the stage's gateway (keepingSessions):
// every row that says any of the session's own errors, and closing, runs over
// it. A refusal for lack of permission among them is the gateway's refusal of
// a read of a resource's bytes, in the row's message, which the transport
// says as the gateway's words. A row of only the transport's failures runs
// over the scripted transport (startedSessions), which fails with exactly a
// row's code and message and does not renew a refused token itself, and
// whose renewal records the token it is handed: a renewal it records is the
// registry's, which no row allows.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/registry"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/semionttest"
)

// registryErrorsCases is the table. Each code is read as the generated
// vocabulary's type, whose constants are errors/codes.json's codes.
type registryErrorsCases struct {
	Comment       string               `json:"$comment"`
	NotYetReached map[string]string    `json:"notYetReached"`
	RunBy         map[string][]string  `json:"runBy"`
	Cases         []registryErrorsCase `json:"cases"`
	Closing       []registryClosingRow `json:"closing"`
}

type registryErrorsCase struct {
	Why   string `json:"why"`
	While string `json:"while"`
	// Said is what the session says on its errors, in order: each one of its
	// own errors, or a failure of its transport with that message.
	Said []struct {
		Own       *semiont.SessionErrorCode   `json:"own"`
		Transport *semiont.TransportErrorCode `json:"transport"`
		Message   *string                     `json:"message"`
	} `json:"said"`
	RegistryErrors []semiont.SessionErrorCode `json:"registryErrors"`
	// PermissionDenied is nil for a case that says no refusal for lack of
	// permission through the session's signals.
	PermissionDenied *string `json:"permissionDenied"`
}

type registryClosingRow struct {
	Why            string                     `json:"why"`
	Owed           *bool                      `json:"owed"`
	RegistryErrors []semiont.SessionErrorCode `json:"registryErrors"`
}

// readRegistryErrorsCases is the table, read whole: a member it gains that
// this runner does not read fails here.
func readRegistryErrorsCases(t *testing.T) registryErrorsCases {
	t.Helper()
	text, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "protocol", "specs", "src", "session", "registry-errors-cases.json"))
	must(t, err)
	decoder := json.NewDecoder(bytes.NewReader(text))
	decoder.DisallowUnknownFields()
	var table registryErrorsCases
	must(t, decoder.Decode(&table))
	if len(table.Cases) == 0 || len(table.Closing) == 0 {
		t.Fatal("a part of the registry's errors cases has no rows")
	}
	return table
}

func TestTheRegistryErrorsCases(t *testing.T) {
	table := readRegistryErrorsCases(t)
	t.Run("cases", func(t *testing.T) {
		for _, c := range table.Cases {
			t.Run(c.Why, func(t *testing.T) { runRegistryErrorsCase(t, c) })
		}
	})
	t.Run("closing", func(t *testing.T) {
		for _, row := range table.Closing {
			t.Run(row.Why, func(t *testing.T) { runRegistryClosing(t, row) })
		}
	})
}

func runRegistryErrorsCase(t *testing.T, c registryErrorsCase) {
	if len(c.Said) == 0 || c.RegistryErrors == nil {
		t.Fatal("the case states nothing said, or no registryErrors")
	}
	failures := 0
	for _, each := range c.Said {
		switch {
		case each.Own != nil && each.Transport == nil && each.Message == nil:
		case each.Own == nil && each.Transport != nil && each.Message != nil:
			failures++
		default:
			t.Fatalf("%s is neither one of the session's own errors nor a failure of its transport with its message", marshal(each))
		}
	}
	if failures == len(c.Said) {
		runTransportFailuresCase(t, c)
	} else {
		runOwnErrorsCase(t, c)
	}
}

// ── The session's own errors, over the stage ────────────────────────────

// keepingSessions is a factory of sessions over the stage's gateway, made by
// semiont.SessionFromKept over kept: each session's client keeps what it holds
// for the person kept names, in caches, a save saveWait after what it holds
// last changed. It reads none of its sessions' errors.
type keepingSessions struct {
	stage    *stage
	kept     semiont.SignInKept
	caches   semiont.SessionStorage
	saveWait time.Duration
}

func (f keepingSessions) Session(ctx context.Context, options registry.SessionFactoryOptions) (*semiont.Session, func(), error) {
	issuer := f.stage.issuerOf()
	timing := issuer.Timing
	timing.SaveDebounce = f.saveWait
	return semiont.SessionFromKept(ctx, semiont.SessionFromKeptConfig{
		Kb:           api.KbTarget{Endpoint: options.Kb.Endpoint, Id: options.Kb.Id, Label: options.Kb.Label},
		Kept:         f.kept,
		HTTP:         issuer.HTTP,
		Timing:       timing,
		Channels:     bus.BridgedChannels,
		Storage:      f.caches,
		OnAuthFailed: options.Signals.NotifySessionEnded,
	})
}

func (keepingSessions) Revoke(context.Context, registry.StoredSession) {}

// stagedRegistry is a registry of kb-a at the stage, its sessions built by
// factory, closed when the test ends.
func stagedRegistry(t *testing.T, s *stage, factory registry.SessionFactory) *registry.SemiontBrowser {
	t.Helper()
	storage := semiont.NewMemoryStorage()
	must(t, registry.SaveKnowledgeBases(storage, []api.KnowledgeBase{s.registered(t, kbA)}))
	browser, err := registry.NewSemiontBrowser(registry.SemiontBrowserConfig{Storage: storage, SessionFactory: factory})
	must(t, err)
	closedAtTheEnd(t, browser)
	return browser
}

// keptNamingAlice keeps in kept a sign-in of the stage's issuer that names
// alice, whom the stage's gateway names too.
func keptNamingAlice(ctx context.Context, t *testing.T, s *stage, kept semiont.SignInKept) {
	t.Helper()
	person := alicesKey
	must(t, kept.Keep(ctx, s.heldSignIn(jwt(time.Hour), "r1", &person)))
}

// runOwnErrorsCase has kb-a's session over the stage say each of what the
// case says, its own errors and its transport's refusals for lack of
// permission. While its factory builds it, a keep-failed is its sign-in
// unable to record the person the gateway names. Once it is active, a
// save-refused is the caches refusing the save a fresh resource makes, a
// keep-failed its sign-in unable to be read at that save, and a refusal for
// lack of permission the gateway's refusal of a read of a resource's bytes.
// Each is read off the registry's errors, or said through the signals, before
// the next is made, since each own error needs a save of its own.
func runOwnErrorsCase(t *testing.T, c registryErrorsCase) {
	s := newStage(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	caches := &refusing{SharedStorage: semionttest.NewSharedStorage()}
	readable := &unreadableSignIn{MemorySignIn: &semiont.MemorySignIn{}}
	var kept semiont.SignInKept
	switch c.While {
	case "opening":
		for _, each := range c.Said {
			if each.Own == nil || *each.Own != semiont.SessionErrorCodeKeepFailed {
				t.Fatalf("this runner cannot have a session over the stage say %s as its factory builds it", marshal(each))
			}
		}
		kept = unrecordable{&semiont.MemorySignIn{}}
	case "active":
		kept = readable
	default:
		t.Fatalf("while %q is none this runner knows", c.While)
	}
	keptNamingAlice(ctx, t, s, kept)
	gate := gated{SessionFactory: keepingSessions{stage: s, kept: kept, caches: caches, saveWait: time.Millisecond}, open: make(chan struct{})}
	browser := stagedRegistry(t, s, gate)
	heard := hearRegistry(ctx, browser)
	close(gate.open)
	session := liveOver(t, browser)
	refusals := watchPermissionRefusals(ctx, t, browser)

	codes := []semiont.SessionErrorCode{}
	for n, each := range c.Said {
		resource := id(fmt.Sprintf("res-%d", n+1))
		if each.Transport != nil {
			if *each.Transport != semiont.TransportErrorCodeForbidden {
				t.Fatalf("over the stage this runner has the gateway refuse a read for lack of permission only, not %s", *each.Transport)
			}
			s.refuseRead(resource, *each.Message)
			if _, err := session.Client().Browse.ResourceRepresentation(ctx, resource); err == nil {
				t.Fatal("the gateway's refusal of a read was not met")
			}
			until(t, "the refusal for lack of permission is said", func() bool {
				return slices.ContainsFunc(refusals.said(), detailed(*each.Message))
			})
			continue
		}
		if c.While == "active" {
			switch *each.Own {
			case semiont.SessionErrorCodeSaveRefused:
				caches.sets.Store(true)
			case semiont.SessionErrorCodeKeepFailed:
				readable.unreadable.Store(true)
			default:
				t.Fatalf("this runner cannot have an active session say %s", *each.Own)
			}
			_, err := session.Client().Browse.Resource(resource).Fresh(ctx)
			must(t, err)
		}
		for {
			said := heard.next(t, string(*each.Own))
			codes = append(codes, said.Code)
			if said.Code == *each.Own {
				break
			}
		}
		caches.sets.Store(false)
	}

	holdSaid(t, c, codes, refusals.said())
	// Over the stage a renewal is a request of its issuer.
	s.mu.Lock()
	asked := len(s.tokenForms)
	s.mu.Unlock()
	if asked != 0 {
		t.Errorf("the issuer was asked for a token %d times; nothing renews the session", asked)
	}
}

// ── The transport's failures, over a scripted transport ─────────────────

// failingAsItBuilds is startedSessions whose session's transport fails with
// each of failures before the session is handed back: as its factory builds
// it, before the registry has read anything.
type failingAsItBuilds struct {
	*startedSessions
	failures []*semiont.TransportError
}

func (f failingAsItBuilds) Session(ctx context.Context, options registry.SessionFactoryOptions) (*semiont.Session, func(), error) {
	session, end, err := f.startedSessions.Session(ctx, options)
	if err != nil {
		return nil, nil, err
	}
	for _, failure := range f.failures {
		f.last().Fail(failure)
	}
	return session, end, nil
}

// runTransportFailuresCase has kb-a's session's scripted transport fail with
// each of the case's failures, and waits for the last's effect: a refusal for
// lack of permission said through the session's signals. Once the session is
// active each is read before the next is said, so each refusal said through
// the signals is seen; as its factory builds it, all are said before the
// registry reads any.
func runTransportFailuresCase(t *testing.T, c registryErrorsCase) {
	last := c.Said[len(c.Said)-1]
	if *last.Transport != semiont.TransportErrorCodeForbidden {
		t.Fatalf("a case whose last failure is %s has no effect this runner can wait for", *last.Transport)
	}
	failures := make([]*semiont.TransportError, len(c.Said))
	for i, each := range c.Said {
		failures[i] = &semiont.TransportError{Code: *each.Transport, Message: *each.Message}
	}
	bubble(t, func(t *testing.T, w *world) {
		w.with(kbOfA())
		person := alice()
		sessions := &startedSessions{who: &person, renewed: jwt(2 * time.Hour)}
		var factory registry.SessionFactory
		switch c.While {
		case "opening":
			factory = failingAsItBuilds{startedSessions: sessions, failures: failures}
		case "active":
			factory = sessions
		default:
			t.Fatalf("while %q is none this runner knows", c.While)
		}
		gate := gated{SessionFactory: factory, open: make(chan struct{})}
		browser, err := registry.NewSemiontBrowser(registry.SemiontBrowserConfig{Storage: w.storage, SessionFactory: gate})
		must(t, err)
		closedAtTheEnd(t, browser)
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		heard := hearRegistry(ctx, browser)
		close(gate.open)
		live(t, browser)
		refusals := watchPermissionRefusals(ctx, t, browser)
		if c.While == "active" {
			for _, failure := range failures {
				sessions.last().Fail(failure)
				settle()
			}
		}

		until(t, "the last refusal for lack of permission is said", func() bool {
			return slices.ContainsFunc(refusals.said(), detailed(*last.Message))
		})
		settle()

		holdSaid(t, c, codesOf(heard.sofar()), refusals.said())
		if handed := sessions.renewals(); len(handed) != 0 {
			t.Errorf("the registry renewed the session, handing %v", handed)
		}
	})
}

// ── What a case holds ───────────────────────────────────────────────────

// hearRegistry is what a registry says on its errors, read from now until
// they end.
func hearRegistry(ctx context.Context, browser *registry.SemiontBrowser) *hearing {
	h := &hearing{said: make(chan *semiont.SessionError, 64), ended: make(chan struct{})}
	errs := browser.Errors(ctx)
	go func() {
		defer close(h.ended)
		for failure := range errs {
			h.said <- failure
		}
	}()
	return h
}

// permissionRefusals is each refusal for lack of permission said through the
// signals of a registry's live session, from when they are watched.
type permissionRefusals struct {
	mu   sync.Mutex
	told []semiont.PermissionDenied
}

func watchPermissionRefusals(ctx context.Context, t *testing.T, browser *registry.SemiontBrowser) *permissionRefusals {
	t.Helper()
	signals := browser.ActiveSignals().Value()
	if signals == nil {
		t.Fatal("the registry shows no signals of a live session")
	}
	refusals := &permissionRefusals{}
	changes := signals.PermissionDenied().Changes(ctx)
	go func() {
		for refusal := range changes {
			if refusal == nil {
				continue
			}
			refusals.mu.Lock()
			refusals.told = append(refusals.told, *refusal)
			refusals.mu.Unlock()
		}
	}()
	return refusals
}

func (r *permissionRefusals) said() []semiont.PermissionDenied {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.told)
}

// detailed is whether a refusal's detail is detail.
func detailed(detail string) func(semiont.PermissionDenied) bool {
	return func(refusal semiont.PermissionDenied) bool { return refusal.Detail != nil && *refusal.Detail == detail }
}

// holdSaid holds what the case says the registry made of what its session
// said, once the last of it had its effect: codes, said on the registry's
// errors, and refusals, said through the session's signals.
func holdSaid(t *testing.T, c registryErrorsCase, codes []semiont.SessionErrorCode, refusals []semiont.PermissionDenied) {
	t.Helper()
	if !slices.Equal(codes, c.RegistryErrors) {
		t.Errorf("the registry said %v on its errors; the case's are %v", codes, c.RegistryErrors)
	}
	switch {
	case c.PermissionDenied == nil:
		if len(refusals) != 0 {
			t.Errorf("the signals said %s; the case says no refusal for lack of permission", marshal(refusals))
		}
	case len(refusals) != 1 || !detailed(*c.PermissionDenied)(refusals[0]):
		t.Errorf("the signals said %s; the case says one refusal for lack of permission, %q", marshal(refusals), *c.PermissionDenied)
	}
}

// ── How a registry's close reads ────────────────────────────────────────

// runRegistryClosing has kb-a's session over the stage owe a save of a fresh
// resource, or nothing, to caches that refuse every write once the registry
// closes, and reads the registry's errors from its close until they end.
func runRegistryClosing(t *testing.T, row registryClosingRow) {
	if row.Owed == nil || row.RegistryErrors == nil {
		t.Fatal("the row states no owed, or no registryErrors")
	}
	s := newStage(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	kept := &semiont.MemorySignIn{}
	keptNamingAlice(ctx, t, s, kept)
	caches := &refusing{SharedStorage: semionttest.NewSharedStorage()}
	// Nothing the client holds is written before the registry closes.
	browser := stagedRegistry(t, s, keepingSessions{stage: s, kept: kept, caches: caches, saveWait: time.Hour})
	session := liveOver(t, browser)
	if *row.Owed {
		_, err := session.Client().Browse.Resource(id("res-1")).Fresh(ctx)
		must(t, err)
		if session.Client().PersistenceSettled() {
			t.Fatal("the client owes no save before the registry closes")
		}
	} else {
		until(t, "the client owes nothing", session.Client().PersistenceSettled)
	}

	caches.sets.Store(true)
	caches.deletes.Store(true)
	caches.updates.Store(true)
	heard := hearRegistry(ctx, browser)
	must(t, browser.Close())

	codes := codesOf(heard.rest(t))
	if ctx.Err() != nil {
		t.Fatal("the registry's errors did not end once it closed: what ended them was the wait")
	}
	if !slices.Equal(codes, row.RegistryErrors) {
		t.Errorf("from its close until its errors ended the registry said %v; the row's are %v", codes, row.RegistryErrors)
	}
}
