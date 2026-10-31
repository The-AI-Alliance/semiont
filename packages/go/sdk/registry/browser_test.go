package registry_test

// The registry of knowledge bases an application holds: the list, the active
// one and its session, a sign-in landing on the entry for the knowledge base
// that answered, what is open in each, and what a session's arrival checks.
//
// Sessions are built by semionttest.ScriptedSessions, each over a scripted
// transport: a test says what each knowledge base answers when asked who it is
// and what of each resource, and reads what was asked. Each test runs in a
// testing/synctest bubble, whose clock moves the moment nothing in it can run,
// so every wait is bounded and none costs time.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/registry"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/semionttest"
)

// ── The knowledge bases behind the factory ──────────────────────────────

// describes is what a knowledge base says when it is asked who it is: a
// description, or, refusing, that it cannot say.
type describes struct {
	as       json.RawMessage
	refusing bool
}

// behind is what the knowledge bases behind the factory say.
type behind struct {
	mu sync.Mutex
	// describes is by knowledge base id. One with no entry does not answer at
	// all.
	describes map[string]describes
	// gone is the resources the knowledge base says do not exist.
	gone map[string]bool
	// failing is the resources whose read fails some other way.
	failing    map[string]bool
	mediaTypes map[string]string
}

// factory is scripted sessions, and what their knowledge bases say of
// themselves and of each resource.
type factory struct {
	sessions *semionttest.ScriptedSessions
	behind   *behind
}

const (
	kbA  = "kb-a"
	kbB  = "kb-b"
	didA = "did:web:example.org:kb-a"
	didB = "did:web:example.org:kb-b"
)

const (
	kbRequested       bus.Channel = "browse:kb-requested"
	resourceRequested bus.Channel = "browse:resource-requested"
)

func alice() api.UserResponse {
	var user api.UserResponse
	if err := json.Unmarshal([]byte(`{"did":"did:web:example.org:users:alice","email":"alice@example.org","name":"Alice","image":null,"domain":"example.org"}`), &user); err != nil {
		panic(err)
	}
	return user
}

func resourceIDOf(payload json.RawMessage) string {
	var asked struct {
		ResourceID string `json:"resourceId"`
	}
	_ = json.Unmarshal(payload, &asked)
	return asked.ResourceID
}

func newFactory() *factory {
	held := &behind{describes: map[string]describes{}, gone: map[string]bool{}, failing: map[string]bool{}, mediaTypes: map[string]string{}}
	sessions := semionttest.NewScriptedSessions(func(kbID string, operation bus.Channel, payload json.RawMessage) (json.RawMessage, error) {
		held.mu.Lock()
		defer held.mu.Unlock()
		switch operation {
		case kbRequested:
			if said, ok := held.describes[kbID]; ok && !said.refusing {
				return said.as, nil
			}
			return nil, errors.New("the knowledge base does not answer")
		case resourceRequested:
			id := resourceIDOf(payload)
			if held.failing[id] {
				return nil, fmt.Errorf("%s could not be read", id)
			}
			representations := []map[string]string{}
			if mediaType, ok := held.mediaTypes[id]; ok {
				representations = append(representations, map[string]string{"mediaType": mediaType})
			}
			return marshal(map[string]any{
				"resource":     map[string]any{"@context": "https://schema.org", "@id": id, "name": "name-" + id, "representations": representations},
				"lastSequence": 1,
			}), nil
		}
		return nil, fmt.Errorf("%s is not answered here", operation)
	})
	sessions.RefuseWhen(func(kbID string, operation bus.Channel, payload json.RawMessage) json.RawMessage {
		held.mu.Lock()
		defer held.mu.Unlock()
		switch operation {
		case kbRequested:
			if held.describes[kbID].refusing {
				return json.RawMessage(`{"message":"this knowledge base cannot say what it is"}`)
			}
		case resourceRequested:
			if held.gone[resourceIDOf(payload)] {
				return json.RawMessage(`{"code":"not-found","message":"no such resource"}`)
			}
		}
		return nil
	})
	sessions.SaysWho(alice())
	return &factory{sessions: sessions, behind: held}
}

func (f *factory) says(kbID string, description json.RawMessage) {
	f.behind.mu.Lock()
	defer f.behind.mu.Unlock()
	f.behind.describes[kbID] = describes{as: description}
}

// askedAbout is the resources a knowledge base's sessions were asked about,
// in order.
func (f *factory) askedAbout(kbID string) []string {
	var asked []string
	for _, transport := range f.sessions.Transports(kbID) {
		for _, entry := range transport.RequestLog() {
			if entry.Channel == resourceRequested {
				asked = append(asked, resourceIDOf(entry.Payload))
			}
		}
	}
	return asked
}

// askedWho is how often a knowledge base's sessions asked it who it is.
func (f *factory) askedWho(kbID string) int {
	asked := 0
	for _, transport := range f.sessions.Transports(kbID) {
		for _, entry := range transport.RequestLog() {
			if entry.Channel == kbRequested {
				asked++
			}
		}
	}
	return asked
}

// ── Helpers ─────────────────────────────────────────────────────────────

func marshal(value any) json.RawMessage {
	text, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return text
}

func endpoint(host string, port int) api.KbEndpoint {
	protocol := api.HttpEndpointProtocolHttps
	if host == "localhost" || host == "127.0.0.1" {
		protocol = api.HttpEndpointProtocolHttp
	}
	var at api.KbEndpoint
	if err := at.FromHttpEndpoint(api.HttpEndpoint{Host: host, Kind: api.HttpEndpointKindHttp, Port: port, Protocol: protocol}); err != nil {
		panic(err)
	}
	return at
}

func kb(id, label, did string, at api.KbEndpoint) api.KnowledgeBase {
	return api.KnowledgeBase{Id: id, Label: label, Did: did, Endpoint: at}
}

func kbOfA() api.KnowledgeBase { return kb(kbA, "KB A", didA, endpoint("localhost", 4000)) }
func kbOfB() api.KnowledgeBase { return kb(kbB, "KB B", didB, endpoint("example.com", 443)) }

func jwt(expiresIn time.Duration) string {
	now := time.Now().Unix()
	encode := base64.RawURLEncoding.EncodeToString
	return encode([]byte(`{"alg":"none"}`)) + "." + encode(marshal(map[string]int64{"iat": now, "exp": now + int64(expiresIn/time.Second)})) + ".sig"
}

func tokens(refresh string) registry.StoredSession {
	return registry.StoredSession{
		Access:             jwt(time.Hour),
		Refresh:            refresh,
		ClientID:           "semiont-browser",
		TokenEndpoint:      "https://issuer.test/token",
		RevocationEndpoint: "https://issuer.test/revoke",
	}
}

func id(text string) api.ResourceId {
	parsed, err := api.ParseResourceId(text)
	if err != nil {
		panic(err)
	}
	return parsed
}

// world is a storage and a factory, and the registries over them.
type world struct {
	t       *testing.T
	storage *semionttest.SharedStorage
	factory *factory
}

// bubble runs a test in a bubble of its own, over an empty storage.
func bubble(t *testing.T, test func(t *testing.T, w *world)) {
	t.Helper()
	synctest.Test(t, func(t *testing.T) {
		test(t, &world{t: t, storage: semionttest.NewSharedStorage(), factory: newFactory()})
	})
}

// with is a storage that already holds these knowledge bases, signed in, with
// the first of them active.
func (w *world) with(kbs ...api.KnowledgeBase) *world {
	must(w.t, registry.SaveKnowledgeBases(w.storage, kbs))
	for _, each := range kbs {
		must(w.t, registry.StoreSession(w.storage, each.Id, tokens("r")))
	}
	if len(kbs) > 0 {
		must(w.t, w.storage.Set(registry.ActiveKey, kbs[0].Id))
	}
	return w
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func (w *world) browser() *registry.SemiontBrowser { return w.browserOver(w.storage) }

// browserOver is a registry over storage, closed when the test ends.
func (w *world) browserOver(storage semiont.SessionStorage) *registry.SemiontBrowser {
	browser, err := registry.NewSemiontBrowser(registry.SemiontBrowserConfig{Storage: storage, SessionFactory: w.factory.sessions})
	must(w.t, err)
	closedAtTheEnd(w.t, browser)
	return browser
}

// closedAtTheEnd closes a registry when the test ends: a failure of what it
// ran fails the test.
func closedAtTheEnd(t *testing.T, browser *registry.SemiontBrowser) {
	t.Cleanup(func() {
		if err := browser.Close(); err != nil {
			t.Errorf("closing the registry: %v", err)
		}
	})
}

func (w *world) stored(key string, into any) {
	w.t.Helper()
	if stored, ok := w.storage.Get(key); ok {
		if err := json.Unmarshal([]byte(stored), into); err != nil {
			w.t.Fatalf("what is stored under %s does not read: %v", key, err)
		}
	}
}

func (w *world) storedOpen(kbID string) []string {
	var byKb map[string][]registry.OpenResource
	w.stored(registry.OpenResourcesByKbKey, &byKb)
	ids := []string{}
	for _, resource := range byKb[kbID] {
		ids = append(ids, resource.ID.String())
	}
	return ids
}

func (w *world) storedLastViewed() map[string]string {
	viewed := map[string]string{}
	w.stored(registry.LastViewedResourceByKbKey, &viewed)
	return viewed
}

func (w *world) storedRefresh(kbID string) (string, bool) {
	stored, ok := registry.StoredSessionOf(w.storage, kbID)
	return stored.Refresh, ok
}

// settle lets what is ready run, and what that makes ready, a moment on.
func settle() {
	time.Sleep(time.Millisecond)
	synctest.Wait()
}

// live is the registry's live session, once it has one, with what its arrival
// starts let run: who it is, and what is open.
func live(t *testing.T, browser *registry.SemiontBrowser) *semiont.Session {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	for session := range browser.ActiveSession().Changes(ctx) {
		if session != nil {
			settle()
			return session
		}
	}
	t.Fatal("no session came up")
	return nil
}

func sessionOf(browser *registry.SemiontBrowser) string {
	if session := browser.ActiveSession().Value(); session != nil {
		return session.Kb().Id
	}
	return ""
}

func open(browser *registry.SemiontBrowser) []string {
	ids := []string{}
	for _, resource := range browser.OpenResources().Value() {
		ids = append(ids, resource.ID.String())
	}
	return ids
}

func closed(transport *semionttest.FaultyTransport) bool {
	return transport.State().Value() == semiont.ConnectionStateClosed
}

func description(name, domain, branch string) json.RawMessage {
	said := map[string]string{"name": name, "domain": domain}
	if branch != "" {
		said["gitBranch"] = branch
	}
	return marshal(said)
}

// same says whether two values write as the same JSON: an endpoint holds its
// own encoding, which compares as bytes.
func same(t *testing.T, got, want any) bool {
	t.Helper()
	var read [2]any
	for i, value := range []any{got, want} {
		if err := json.Unmarshal(marshal(value), &read[i]); err != nil {
			t.Fatal(err)
		}
	}
	return reflect.DeepEqual(read[0], read[1])
}

func equalStrings(got, want []string) bool { return slices.Equal(got, want) }

// ── The knowledge bases ─────────────────────────────────────────────────

func TestAKnowledgeBaseThatIsAddedIsKeptSignedInAndMadeActive(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		browser := w.browser()
		if len(browser.KnowledgeBases().Value()) != 0 || browser.ActiveKbId().Value() != "" {
			t.Fatal("a new registry over nothing holds something")
		}
		branch := "main"
		read := api.KbRead{At: "2027-01-15T08:00:00.000Z", GitBranch: &branch}
		added, err := browser.AddKb(api.NewKnowledgeBase{Label: "KB A", Did: didA, Endpoint: endpoint("localhost", 4000), LastRead: &read}, tokens("r"))
		must(t, err)

		if !same(t, browser.KnowledgeBases().Value(), []api.KnowledgeBase{added}) {
			t.Errorf("the registered knowledge bases are %+v", browser.KnowledgeBases().Value())
		}
		if browser.ActiveKbId().Value() != added.Id || sessionOf(browser) != added.Id {
			t.Errorf("the active one is %q, its session %q", browser.ActiveKbId().Value(), sessionOf(browser))
		}
		if active, _ := w.storage.Get(registry.ActiveKey); active != added.Id {
			t.Errorf("the active one is stored as %q", active)
		}
		if _, ok := registry.StoredSessionOf(w.storage, added.Id); !ok {
			t.Error("its tokens are not stored")
		}

		// Its identity and what it last said survive a new registry on the
		// storage.
		must(t, browser.Close())
		reopened := w.browser()
		kbs := reopened.KnowledgeBases().Value()
		if !same(t, kbs, []api.KnowledgeBase{added}) || kbs[0].Did != didA || !same(t, kbs[0].LastRead, read) {
			t.Errorf("a new registry reads %+v", kbs)
		}
		if live(t, reopened).Kb().Id != added.Id {
			t.Error("the new registry's session is not the one added")
		}
	})
}

func TestAnEntryThatIsNotAKnowledgeBaseWithADidIsDroppedFromTheStorageToo(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		must(t, w.storage.Set(registry.KnowledgeBasesKey, `[
			{"id":"old","label":"No did","endpoint":{"kind":"http","host":"localhost","port":4000,"protocol":"http"}},
			{"id":"kb-a","label":"KB A","did":"did:web:example.org:kb-a","email":"someone@example.org",
			 "endpoint":{"kind":"http","host":"localhost","port":4000,"protocol":"http"}},
			"not an entry"
		]`))
		must(t, w.storage.Set(registry.ActiveKey, "old"))
		browser := w.browser()

		if !same(t, browser.KnowledgeBases().Value(), []api.KnowledgeBase{kbOfA()}) {
			t.Errorf("the registered knowledge bases are %+v", browser.KnowledgeBases().Value())
		}
		// The active one was the one dropped: the first that is left takes over.
		if browser.ActiveKbId().Value() != kbA {
			t.Errorf("the active one is %q", browser.ActiveKbId().Value())
		}
		// What is written back is what was read, and nothing else an entry
		// carried.
		var written any
		w.stored(registry.KnowledgeBasesKey, &written)
		var want any
		must(t, json.Unmarshal([]byte(`[{"id":"kb-a","label":"KB A","did":"did:web:example.org:kb-a","endpoint":{"kind":"http","host":"localhost","port":4000,"protocol":"http"}}]`), &want))
		if !reflect.DeepEqual(written, want) {
			t.Errorf("written back: %v", written)
		}
	})
}

func TestRemovingAKnowledgeBaseForgetsItAndTheNextOneTakesOver(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		browser := w.with(kbOfA(), kbOfB()).browser()
		live(t, browser)
		must(t, browser.AddOpenResource(id("res-1"), "One", "", ""))
		must(t, browser.SetLastViewedResource(id("res-1")))
		if got := w.storedOpen(kbA); !equalStrings(got, []string{"res-1"}) {
			t.Fatalf("stored open: %v", got)
		}

		must(t, browser.RemoveKb(kbA))
		if !same(t, browser.KnowledgeBases().Value(), []api.KnowledgeBase{kbOfB()}) || sessionOf(browser) != kbB {
			t.Errorf("after removing A: %+v, session %q", browser.KnowledgeBases().Value(), sessionOf(browser))
		}
		if _, ok := registry.StoredSessionOf(w.storage, kbA); ok {
			t.Error("A's tokens are still stored")
		}
		if len(w.storedOpen(kbA)) != 0 {
			t.Error("what was open in A is still stored")
		}
		if _, ok := w.storedLastViewed()[kbA]; ok {
			t.Error("where the person was in A is still stored")
		}
		if !closed(w.factory.sessions.Transports(kbA)[0]) {
			t.Error("A's session is not closed")
		}

		must(t, browser.RemoveKb(kbB))
		if len(browser.KnowledgeBases().Value()) != 0 || browser.ActiveKbId().Value() != "" || sessionOf(browser) != "" {
			t.Error("removing the last leaves something")
		}
		if _, ok := w.storage.Get(registry.ActiveKey); ok {
			t.Error("an active one is still stored")
		}
	})
}

func TestAnEntryTakesWhatItsKnowledgeBaseLastSaidAndKeepsItsDid(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		browser := w.with(kbOfA(), kbOfB()).browser()
		read := api.KbRead{At: "2026-10-15T08:00:00.000Z"}
		renamed := "Renamed"

		must(t, browser.UpdateKb(kbB, &renamed, &read))

		kbs := browser.KnowledgeBases().Value()
		if !same(t, kbs[0], kbOfA()) || kbs[1].Label != "Renamed" || kbs[1].Did != didB || kbs[1].LastRead == nil || kbs[1].LastRead.GitBranch != nil {
			t.Errorf("the entries are %+v", kbs)
		}
		var stored []api.KnowledgeBase
		w.stored(registry.KnowledgeBasesKey, &stored)
		if !same(t, stored, kbs) {
			t.Errorf("stored: %+v", stored)
		}
	})
}

func TestAStoredCredentialSaysWhetherItIsGoodExpiredOrNotThere(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		w.with(kbOfA(), kbOfB())
		expired := tokens("r")
		expired.Access = jwt(-time.Minute)
		must(t, registry.StoreSession(w.storage, kbB, expired))
		browser := w.browser()

		for kbID, want := range map[string]registry.KbSessionStatus{kbA: registry.KbSessionAuthenticated, kbB: registry.KbSessionExpired, "another": registry.KbSessionSignedOut} {
			if got := browser.KbSessionStatus(kbID); got != want {
				t.Errorf("%s: %s, not %s", kbID, got, want)
			}
		}
	})
}

func TestTheIdentityTokenIsWhatItWasLastSetTo(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		browser := w.browser()
		if browser.IdentityToken().Value() != "" {
			t.Fatal("a new registry holds an identity token")
		}
		browser.SetIdentityToken("an-identity-token")
		if browser.IdentityToken().Value() != "an-identity-token" {
			t.Error("the identity token set is not held")
		}
		browser.SetIdentityToken("")
		if browser.IdentityToken().Value() != "" {
			t.Error("the identity token is not cleared")
		}
	})
}

// ── The active session ──────────────────────────────────────────────────

// watchSessions records the knowledge base of each session the registry shows,
// "" for none, until the returned stop is called.
func watchSessions(browser *registry.SemiontBrowser) (seen func() []string, stop func()) {
	ctx, cancel := context.WithCancel(context.Background())
	var mu sync.Mutex
	var shown []string
	done := make(chan struct{})
	go func() {
		defer close(done)
		for session := range browser.ActiveSession().Changes(ctx) {
			kbID := ""
			if session != nil {
				kbID = session.Kb().Id
			}
			mu.Lock()
			shown = append(shown, kbID)
			mu.Unlock()
		}
	}()
	synctest.Wait()
	return func() []string {
			mu.Lock()
			defer mu.Unlock()
			return slices.Clone(shown)
		}, func() {
			cancel()
			<-done
		}
}

func TestMakingAnotherKnowledgeBaseActiveShowsNoSessionAndThenTheNewOne(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		browser := w.with(kbOfA(), kbOfB()).browser()
		live(t, browser)
		// B's session takes a moment to come up: a reader that is behind is
		// given the latest value, and one that came up at once could be given
		// it before "no session".
		w.factory.sessions.AnswersAfter(2 * time.Second)
		seen, stop := watchSessions(browser)
		defer stop()

		must(t, browser.SetActiveKb(kbB))
		settle()

		if got := seen(); !equalStrings(got, []string{kbA, "", kbB}) {
			t.Errorf("the sessions shown were %q", got)
		}
		if active, _ := w.storage.Get(registry.ActiveKey); active != kbB {
			t.Errorf("the active one is stored as %q", active)
		}
		// The session it replaced is closed, and its client with it.
		if !closed(w.factory.sessions.Transports(kbA)[0]) || closed(w.factory.sessions.Transports(kbB)[0]) {
			t.Error("the sessions closed are not the replaced one alone")
		}
	})
}

func TestMakingNoneActiveClosesTheSessionAndLeavesNone(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		browser := w.with(kbOfA()).browser()
		live(t, browser)

		must(t, browser.SetActiveKb(""))

		if sessionOf(browser) != "" || browser.ActiveKbId().Value() != "" || browser.ActiveSignals().Value() != nil || browser.SessionActivating().Value() {
			t.Error("making none active leaves something active")
		}
		if !closed(w.factory.sessions.Transports(kbA)[0]) {
			t.Error("the session is not closed")
		}
		if _, ok := w.storage.Get(registry.ActiveKey); ok {
			t.Error("an active one is still stored")
		}
	})
}

func TestMakingTheActiveOneActiveAgainChangesNothing(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		browser := w.with(kbOfA()).browser()
		session := live(t, browser)

		must(t, browser.SetActiveKb(kbA))

		if live(t, browser).Id() != session.Id() || len(w.factory.sessions.Transports(kbA)) != 1 {
			t.Error("making the active one active again built another session")
		}
	})
}

func TestOfTwoActivationsAskedForTogetherTheLastOneAskedForStands(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		browser := w.with(kbOfA(), kbOfB()).browser()
		live(t, browser)

		// Asked one after another, without waiting for any: what stands is the
		// last one asked for.
		var asked sync.WaitGroup
		for _, kbID := range []string{kbB, kbA, kbB} {
			asked.Go(func() { must(t, browser.SetActiveKb(kbID)) })
			synctest.Wait()
		}
		asked.Wait()

		if sessionOf(browser) != kbB || browser.ActiveKbId().Value() != kbB || browser.SessionActivating().Value() {
			t.Errorf("the session is %q, the active one %q", sessionOf(browser), browser.ActiveKbId().Value())
		}
		// Every session but the one that stands is closed.
		open := 0
		for _, kbID := range []string{kbA, kbB} {
			for _, transport := range w.factory.sessions.Transports(kbID) {
				if !closed(transport) {
					open++
				}
			}
		}
		if open != 1 {
			t.Errorf("%d sessions are open", open)
		}
	})
}

func TestAnActivationOvertakenWhileItWaitedItsTurnBuildsNoSession(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		browser := w.with(kbOfA(), kbOfB()).browser()
		live(t, browser)
		// The first activation holds the turn while its session comes up, and
		// the other two are asked for behind it.
		w.factory.sessions.AnswersAfter(2 * time.Second)

		var asked sync.WaitGroup
		for _, kbID := range []string{kbB, kbA, kbB} {
			asked.Go(func() { must(t, browser.SetActiveKb(kbID)) })
			synctest.Wait()
		}
		asked.Wait()

		if sessionOf(browser) != kbB {
			t.Errorf("the session is %q", sessionOf(browser))
		}
		// A had the session it started with, and no other was built for it.
		if built := len(w.factory.sessions.Transports(kbA)); built != 1 {
			t.Errorf("%d sessions were built for A", built)
		}
	})
}

func TestASessionThatComesUpAfterItsKnowledgeBaseStoppedBeingActiveIsNeverShown(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		browser := w.with(kbOfA(), kbOfB()).browser()
		live(t, browser)
		w.factory.sessions.AnswersAfter(2 * time.Second)

		// Every session shown: the knowledge base that was active then, and the
		// session's own.
		var mu sync.Mutex
		var shown [][2]string
		ctx, cancel := context.WithCancel(context.Background())
		watching := make(chan struct{})
		go func() {
			defer close(watching)
			first := true
			for session := range browser.ActiveSession().Changes(ctx) {
				if first {
					first = false
					continue
				}
				if session != nil {
					mu.Lock()
					shown = append(shown, [2]string{browser.ActiveKbId().Value(), session.Kb().Id})
					mu.Unlock()
				}
			}
		}()
		synctest.Wait()

		var asked sync.WaitGroup
		asked.Go(func() { must(t, browser.SetActiveKb(kbB)) })
		// B's session is still coming up when A is asked for again.
		settle()
		asked.Go(func() { must(t, browser.SetActiveKb(kbA)) })
		asked.Wait()
		settle()
		cancel()
		<-watching

		if !reflect.DeepEqual(shown, [][2]string{{kbA, kbA}}) {
			t.Errorf("shown: %v", shown)
		}
		// The session that came up too late was closed, and not left running.
		if !closed(w.factory.sessions.Transports(kbB)[0]) {
			t.Error("B's late session is still open")
		}
	})
}

func TestASessionBeingBroughtUpIsSaidToBeOnItsWay(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		w.with(kbOfA())
		// A session that takes a moment to come up: one that is up at once is
		// up before anyone could be told it was coming.
		w.factory.sessions.AnswersAfter(2 * time.Second)
		browser := w.browser()

		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		said := false
		for activating := range browser.SessionActivating().Changes(ctx) {
			if activating {
				said = true
				break
			}
		}
		if !said || sessionOf(browser) != "" {
			t.Fatal("a session coming up is not said to be on its way")
		}

		live(t, browser)
		if browser.SessionActivating().Value() {
			t.Error("a session that is up is still said to be on its way")
		}
	})
}

// gated is a factory whose sessions are built once the test opens the gate:
// a registry starts its first activation as it is made, before a test could
// listen for what it says.
type gated struct {
	registry.SessionFactory
	open chan struct{}
}

func (g gated) Session(ctx context.Context, options registry.SessionFactoryOptions) (*semiont.Session, func(), error) {
	select {
	case <-g.open:
	case <-ctx.Done():
		return nil, nil, ctx.Err()
	}
	return g.SessionFactory.Session(ctx, options)
}

func TestASessionThatCannotBeBuiltIsSaidAndThereIsNone(t *testing.T) {
	bubble(t, func(t *testing.T, w *world) {
		w.with(kbOfA())
		w.factory.sessions.RefuseToBuild("this factory builds nothing")
		gate := gated{SessionFactory: w.factory.sessions, open: make(chan struct{})}
		browser, err := registry.NewSemiontBrowser(registry.SemiontBrowserConfig{Storage: w.storage, SessionFactory: gate})
		must(t, err)
		closedAtTheEnd(t, browser)
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		errs := browser.Errors(ctx)
		close(gate.open)

		var refused *semiont.SessionError
		for err := range errs {
			refused = err
			break
		}
		settle()

		if refused == nil || refused.Code != semiont.SessionErrorCodeConstructFailed || refused.KbID != kbA {
			t.Fatalf("the failure said is %+v", refused)
		}
		if sessionOf(browser) != "" || browser.ActiveSignals().Value() != nil || browser.SessionActivating().Value() {
			t.Error("a session that could not be built left something")
		}
	})
}
