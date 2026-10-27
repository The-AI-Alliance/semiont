package registry_test

// The registry over HTTP: sessions HttpSessionFactory brings up against a
// stand-in gateway and the issuer it trusts, a person's sign-in by a page
// redirect, and what a completed sign-in asks the knowledge base.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/registry"
)

// stage is a stand-in gateway and the issuer it trusts. The gateway says who
// a token is, holds streams, and answers on every stream a request to
// describe itself, as it describes itself or refusing, and a request for a
// resource; an emit carrying a token it refuses on the bus is refused. The
// issuer grants what it is told to.
type stage struct {
	gateway, issuer *httptest.Server

	mu sync.Mutex
	// describes is what the knowledge base says of itself; nil refuses.
	describes json.RawMessage
	// grants is the tokens the token endpoint grants next, one each.
	grants [][2]string
	// tokenForms and revokeForms are every form those endpoints were sent.
	tokenForms, revokeForms []url.Values
	// askedWho is every token the gateway was asked who it is.
	askedWho []string
	// refusedOnTheBus is the tokens whose emits the gateway refuses.
	refusedOnTheBus map[string]bool
	// subscriptions is every stream asked for.
	subscriptions []api.BusSubscribeRequest
	streams       []chan string
}

func newStage(t *testing.T) *stage {
	t.Helper()
	s := &stage{describes: description("KB A", "example.org:kb-a", "main"), refusedOnTheBus: map[string]bool{}}
	s.issuer = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			answerJSON(w, http.StatusOK, map[string]any{
				"issuer": s.issuer.URL, "authorization_endpoint": s.issuer.URL + "/auth", "token_endpoint": s.issuer.URL + "/token",
				"device_authorization_endpoint": s.issuer.URL + "/device", "revocation_endpoint": s.issuer.URL + "/revoke",
			})
		case "/token":
			_ = r.ParseForm()
			s.mu.Lock()
			s.tokenForms = append(s.tokenForms, r.PostForm)
			var grant [2]string
			granted := len(s.grants) > 0
			if granted {
				grant, s.grants = s.grants[0], s.grants[1:]
			}
			s.mu.Unlock()
			if !granted {
				answerJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_grant"})
				return
			}
			answerJSON(w, http.StatusOK, map[string]any{"access_token": grant[0], "refresh_token": grant[1], "token_type": "Bearer", "expires_in": 3600})
		case "/revoke":
			_ = r.ParseForm()
			s.mu.Lock()
			s.revokeForms = append(s.revokeForms, r.PostForm)
			s.mu.Unlock()
			w.WriteHeader(http.StatusOK)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(s.issuer.Close)
	s.gateway = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		switch r.URL.Path {
		case "/.well-known/oauth-protected-resource":
			answerJSON(w, http.StatusOK, map[string]any{"resource": "https://kb.example", "authorization_servers": []string{s.issuer.URL}, "bearer_methods_supported": []string{"header"}})
		case "/api/users/me":
			s.mu.Lock()
			s.askedWho = append(s.askedWho, token)
			s.mu.Unlock()
			answerJSON(w, http.StatusOK, map[string]any{"did": "did:web:example.org:users:alice", "email": "alice@example.org", "domain": "example.org", "name": "Alice", "image": nil})
		case "/bus/subscribe":
			s.stream(w, r)
		case "/bus/emit":
			s.emitted(w, r, token)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(s.gateway.Close)
	return s
}

func answerJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func (s *stage) stream(w http.ResponseWriter, r *http.Request) {
	var subscription api.BusSubscribeRequest
	if err := json.NewDecoder(r.Body).Decode(&subscription); err != nil {
		answerJSON(w, http.StatusBadRequest, map[string]any{"error": "not a subscription"})
		return
	}
	sent := make(chan string, 16)
	s.mu.Lock()
	s.subscriptions = append(s.subscriptions, subscription)
	s.streams = append(s.streams, sent)
	s.mu.Unlock()
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	w.(http.Flusher).Flush()
	for {
		select {
		case <-r.Context().Done():
			return
		case data := <-sent:
			_, _ = fmt.Fprint(w, data)
			w.(http.Flusher).Flush()
		}
	}
}

func (s *stage) emitted(w http.ResponseWriter, r *http.Request, token string) {
	var emitted api.BusEmitRequest
	if err := json.NewDecoder(r.Body).Decode(&emitted); err != nil {
		answerJSON(w, http.StatusBadRequest, map[string]any{"error": "not an emit"})
		return
	}
	s.mu.Lock()
	refused, describes := s.refusedOnTheBus[token], s.describes
	s.mu.Unlock()
	if refused {
		answerJSON(w, http.StatusUnauthorized, map[string]any{"error": "Invalid token"})
		return
	}
	switch {
	case emitted.CorrelationId == nil:
	case emitted.Channel == string(kbRequested) && describes == nil:
		s.send("", fmt.Sprintf(`{"channel":"browse:kb-failed","correlationId":%q,"payload":{"message":"this knowledge base cannot say what it is"}}`, *emitted.CorrelationId))
	case emitted.Channel == string(kbRequested):
		s.send("", fmt.Sprintf(`{"channel":"browse:kb-result","correlationId":%q,"payload":{"response":%s}}`, *emitted.CorrelationId, describes))
	case emitted.Channel == string(resourceRequested):
		s.send("", fmt.Sprintf(`{"channel":"browse:resource-result","correlationId":%q,"payload":{"response":{"resource":{"@context":"https://schema.org","@id":%q,"name":%q,"representations":[]},"lastSequence":1}}}`,
			*emitted.CorrelationId, emitted.Payload["resourceId"], emitted.Payload["resourceId"]))
	}
	answerJSON(w, http.StatusAccepted, map[string]any{"subscribers": 1})
}

// send gives every stream a frame, with id when it is not "": a reply reaches
// the client that asked, and the others pass it by.
func (s *stage) send(id, data string) {
	event := fmt.Sprintf("event: bus-event\ndata: %s\n\n", data)
	if id != "" {
		event = fmt.Sprintf("event: bus-event\nid: %s\ndata: %s\n\n", id, data)
	}
	s.mu.Lock()
	streams := append([]chan string(nil), s.streams...)
	s.mu.Unlock()
	for _, stream := range streams {
		stream <- event
	}
}

func (s *stage) grant(access, refresh string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.grants = append(s.grants, [2]string{access, refresh})
}

func (s *stage) target(t *testing.T) api.HttpEndpoint {
	t.Helper()
	at, err := url.Parse(s.gateway.URL)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(at.Port())
	if err != nil {
		t.Fatal(err)
	}
	return api.HttpEndpoint{Kind: api.HttpEndpointKindHttp, Protocol: api.HttpEndpointProtocol(at.Scheme), Host: at.Hostname(), Port: port}
}

func (s *stage) registered(t *testing.T, kbID string) api.KnowledgeBase {
	t.Helper()
	var at api.KbEndpoint
	must(t, at.FromHttpEndpoint(s.target(t)))
	return api.KnowledgeBase{Id: kbID, Label: "KB A", Did: didA, Endpoint: at}
}

func (s *stage) stored(access, refresh string) registry.StoredSession {
	return registry.StoredSession{Access: access, Refresh: refresh, ClientID: semiont.BrowserClientID, TokenEndpoint: s.issuer.URL + "/token", RevocationEndpoint: s.issuer.URL + "/revoke"}
}

func (s *stage) issuerOf() semiont.Issuer {
	timing := semiont.DefaultTiming()
	timing.HttpRequestTimeout = 5 * time.Second
	return semiont.Issuer{HTTP: &http.Client{}, Timing: timing}
}

func (s *stage) browser(t *testing.T, storage semiont.SessionStorage) *registry.SemiontBrowser {
	t.Helper()
	issuer := s.issuerOf()
	browser := registry.NewSemiontBrowser(registry.SemiontBrowserConfig{Storage: storage, SessionFactory: registry.HttpSessionFactory{HTTP: issuer.HTTP, Timing: issuer.Timing}})
	t.Cleanup(browser.Close)
	return browser
}

func (s *stage) begin(t *testing.T) semiont.BeginAuthorizationOptions {
	return semiont.BeginAuthorizationOptions{Target: s.target(t), RedirectURI: "http://127.0.0.1:9/callback"}
}

// sentBack begins a sign-in through the registry and gives the callback URL
// the issuer would send the person back to.
func (s *stage) sentBack(t *testing.T, browser *registry.SemiontBrowser, options semiont.BeginAuthorizationOptions) string {
	t.Helper()
	address, err := registry.BeginSignIn(context.Background(), browser, s.issuerOf(), options)
	must(t, err)
	parsed, err := url.Parse(address)
	must(t, err)
	return "http://127.0.0.1:9/callback?state=" + parsed.Query().Get("state") + "&code=the-code"
}

// liveOver is the registry's live session, once it has one, waited for in
// real time.
func liveOver(t *testing.T, browser *registry.SemiontBrowser) *semiont.Session {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for session := range browser.ActiveSession().Changes(ctx) {
		if session != nil {
			return session
		}
	}
	t.Fatal("no session came up")
	return nil
}

// until waits, up to ten seconds, for probe to hold.
func until(t *testing.T, what string, probe func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !probe() {
		if time.Now().After(deadline) {
			t.Fatalf("never happened: %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestARegistryBringsUpASessionThatSaysWhoItIsAndRenewsAnExpiredToken(t *testing.T) {
	s := newStage(t)
	storage := semiont.NewMemoryStorage()
	must(t, registry.SaveKnowledgeBases(storage, []api.KnowledgeBase{s.registered(t, "kb-a")}))
	renewed := jwt(time.Hour)
	must(t, registry.StoreSession(storage, "kb-a", s.stored(jwt(-time.Minute), "r1")))
	s.grant(renewed, "r2")

	browser := s.browser(t, storage)
	session := liveOver(t, browser)

	if session.Token().Value() != renewed {
		t.Error("the session does not hold the renewed token")
	}
	s.mu.Lock()
	askedWho := append([]string(nil), s.askedWho...)
	s.mu.Unlock()
	if !reflect.DeepEqual(askedWho, []string{renewed}) {
		t.Errorf("the gateway was asked who %d tokens are", len(askedWho))
	}
	if user := session.User().Value(); user == nil || user.Did.String() != "did:web:example.org:users:alice" {
		t.Errorf("the session says it is %+v", user)
	}
	if stored, _ := registry.StoredSessionOf(storage, "kb-a"); stored != s.stored(renewed, "r2") {
		t.Errorf("stored: %+v", stored)
	}
}

func TestRenewalsAskedForTogetherAreOneRequestOfTheIssuer(t *testing.T) {
	s := newStage(t)
	storage := semiont.NewMemoryStorage()
	must(t, registry.SaveKnowledgeBases(storage, []api.KnowledgeBase{s.registered(t, "kb-a")}))
	must(t, registry.StoreSession(storage, "kb-a", s.stored(jwt(time.Hour), "r1")))
	browser := s.browser(t, storage)
	session := liveOver(t, browser)
	renewed := jwt(2 * time.Hour)
	s.grant(renewed, "r2")

	var refreshed sync.WaitGroup
	tokens := make([]string, 3)
	for i := range tokens {
		refreshed.Go(func() { tokens[i], _ = session.Refresh(context.Background()) })
	}
	refreshed.Wait()

	if !reflect.DeepEqual(tokens, []string{renewed, renewed, renewed}) {
		t.Error("the renewals asked for together did not all give the renewed token")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.tokenForms) != 1 {
		t.Errorf("the issuer was asked %d times", len(s.tokenForms))
	}
}

func TestARegistryOverHTTPCannotBuildASessionForWhatIsNotAtAGateway(t *testing.T) {
	s := newStage(t)
	storage := semiont.NewMemoryStorage()
	local := s.registered(t, "kb-local")
	must(t, local.Endpoint.FromLocalEndpoint(api.LocalEndpoint{Kind: api.LocalEndpointKindLocal, KbId: "here"}))
	must(t, registry.SaveKnowledgeBases(storage, []api.KnowledgeBase{local}))
	gate := gated{SessionFactory: registry.HttpSessionFactory{HTTP: &http.Client{}, Timing: semiont.DefaultTiming()}, open: make(chan struct{})}
	browser := registry.NewSemiontBrowser(registry.SemiontBrowserConfig{Storage: storage, SessionFactory: gate})
	t.Cleanup(browser.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	errs := browser.Errors(ctx)
	close(gate.open)

	var refused *semiont.SessionError
	for err := range errs {
		refused = err
		break
	}
	if refused == nil || refused.Code != semiont.SessionErrorCodeConstructFailed || refused.KbID != "kb-local" || !strings.Contains(refused.Message, `"local"`) {
		t.Errorf("the failure said is %+v", refused)
	}
}

func TestSigningOutOfARegistryRevokesTheRefreshTokenAtItsIssuer(t *testing.T) {
	s := newStage(t)
	storage := semiont.NewMemoryStorage()
	must(t, registry.SaveKnowledgeBases(storage, []api.KnowledgeBase{s.registered(t, "kb-a")}))
	must(t, registry.StoreSession(storage, "kb-a", s.stored(jwt(time.Hour), "r1")))
	browser := s.browser(t, storage)
	liveOver(t, browser)

	browser.SignOut("kb-a")
	until(t, "the issuer is told", func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return len(s.revokeForms) > 0
	})

	s.mu.Lock()
	revoked := s.revokeForms[0]
	s.mu.Unlock()
	if revoked.Get("token") != "r1" || revoked.Get("client_id") != "semiont-browser" {
		t.Errorf("the issuer was sent %v", revoked)
	}
	if _, ok := registry.StoredSessionOf(storage, "kb-a"); ok {
		t.Error("the tokens are still stored")
	}
}

func TestARegistrysSignInRegistersTheKnowledgeBaseUnderWhatItSaysItIs(t *testing.T) {
	s := newStage(t)
	storage := semiont.NewMemoryStorage()
	browser := s.browser(t, storage)
	access := jwt(time.Hour)
	s.grant(access, "a-refresh-token")
	options := s.begin(t)
	options.ExpectedDid, options.ExpectedName = "did:web:example.org:another", "Another"

	callback := s.sentBack(t, browser, options)
	outcome, err := registry.CompleteSignIn(context.Background(), browser, s.issuerOf(), callback)
	must(t, err)

	var at api.KbEndpoint
	must(t, at.FromHttpEndpoint(s.target(t)))
	if outcome.Kb.Did != didA || outcome.Kb.Label != "KB A" || !same(t, outcome.Kb.Endpoint, at) {
		t.Errorf("the entry is %+v", outcome.Kb)
	}
	if read := outcome.Kb.LastRead; read == nil || read.GitBranch == nil || *read.GitBranch != "main" {
		t.Errorf("what it last said is %+v", read)
	}
	// What the person believed they clicked is said back, not acted on.
	if outcome.Expected == nil || outcome.Expected.Did != "did:web:example.org:another" {
		t.Errorf("expected: %+v", outcome.Expected)
	}
	if !same(t, browser.KnowledgeBases().Value(), []api.KnowledgeBase{outcome.Kb}) {
		t.Errorf("the registered knowledge bases are %+v", browser.KnowledgeBases().Value())
	}
	if stored, _ := registry.StoredSessionOf(storage, outcome.Kb.Id); stored != s.stored(access, "a-refresh-token") {
		t.Errorf("stored: %+v", stored)
	}
	if liveOver(t, browser).Kb().Id != outcome.Kb.Id {
		t.Error("the session is not the knowledge base signed in to")
	}
}

func TestAKnowledgeBaseThatCannotSayWhoItIsIsNotRegistered(t *testing.T) {
	s := newStage(t)
	browser := s.browser(t, semiont.NewMemoryStorage())

	s.mu.Lock()
	s.describes = nil
	s.mu.Unlock()
	s.grant(jwt(time.Hour), "r")
	_, err := registry.CompleteSignIn(context.Background(), browser, s.issuerOf(), s.sentBack(t, browser, s.begin(t)))
	var unverifiable *semiont.IdentityUnverifiableError
	if !errors.As(err, &unverifiable) || unverifiable.Reason != semiont.IdentityUnverifiableReasonNotReported {
		t.Errorf("a knowledge base that cannot say who it is: %v", err)
	}

	// An emit the gateway refuses reaches nobody to ask.
	unwelcome := jwt(2 * time.Hour)
	s.mu.Lock()
	s.refusedOnTheBus[unwelcome] = true
	s.mu.Unlock()
	s.grant(unwelcome, "r")
	_, err = registry.CompleteSignIn(context.Background(), browser, s.issuerOf(), s.sentBack(t, browser, s.begin(t)))
	if !errors.As(err, &unverifiable) || unverifiable.Reason != semiont.IdentityUnverifiableReasonUnreachable {
		t.Errorf("a knowledge base not reached: %v", err)
	}

	if len(browser.KnowledgeBases().Value()) != 0 || browser.ActiveKbId().Value() != "" {
		t.Error("a knowledge base whose identity is unknown was registered")
	}
}

func TestACallbackThatIsNotThePendingSignInsRegistersNothing(t *testing.T) {
	s := newStage(t)
	browser := s.browser(t, semiont.NewMemoryStorage())
	s.sentBack(t, browser, s.begin(t))

	_, err := registry.CompleteSignIn(context.Background(), browser, s.issuerOf(), "http://127.0.0.1:9/callback?state=another&code=the-code")

	var refused *semiont.SignInError
	if !errors.As(err, &refused) || refused.Code != semiont.SignInErrorCodeState || refused.Message != "The sign-in response does not belong to the pending sign-in" {
		t.Errorf("a callback of another sign-in: %v", err)
	}
	if len(browser.KnowledgeBases().Value()) != 0 {
		t.Error("something was registered")
	}
}

func TestAskedWithATokenTheKnowledgeBaseSaysWhoItIs(t *testing.T) {
	s := newStage(t)
	issuer := s.issuerOf()

	identity, err := semiont.DescribeConnection(context.Background(), s.target(t), jwt(time.Hour), issuer.HTTP, issuer.Timing)
	must(t, err)

	if identity.Did.String() != didA || identity.Description.Name != "KB A" || identity.Description.GitBranch == nil || *identity.Description.GitBranch != "main" {
		t.Errorf("it says it is %+v", identity)
	}
}

func TestARegistrysSessionResumesItsStreamFromThePlaceItsStorageKept(t *testing.T) {
	s := newStage(t)
	storage := semiont.NewMemoryStorage()
	must(t, registry.SaveKnowledgeBases(storage, []api.KnowledgeBase{s.registered(t, "kb-a")}))
	must(t, registry.StoreSession(storage, "kb-a", s.stored(jwt(time.Hour), "r1")))
	must(t, storage.Set("semiont.lastEventId.kb-a", `{"res-1":"p-5"}`))
	browser := s.browser(t, storage)
	session := liveOver(t, browser)

	// Watching a query of the resource holds its scope.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		for range session.Client().Browse.Resource(id("res-1")).States(ctx) {
		}
	}()
	resumedFrom := func() string {
		s.mu.Lock()
		defer s.mu.Unlock()
		for _, subscription := range s.subscriptions {
			if subscription.Scoped == nil {
				continue
			}
			for _, scoped := range *subscription.Scoped {
				if scoped.Scope.String() == "res-1" && scoped.LastEventId != nil {
					return *scoped.LastEventId
				}
			}
		}
		return ""
	}
	until(t, "the stream names the scope", func() bool { return resumedFrom() != "" })
	if from := resumedFrom(); from != "p-5" {
		t.Errorf("the stream resumes the scope from %q", from)
	}

	// A recorded event of the scope moves the place, and the place is kept
	// once the caches have taken the event in and written what they hold:
	// an archived resource is asked for again, and its description written.
	s.send("p-9", `{"channel":"mark:archived","scope":"res-1","payload":{"id":"0e2f8c0a-4a34-4a8e-9b47-0d6d5a3f8a11","type":"mark:archived","timestamp":"2026-10-27T12:00:00.000Z","userId":"did:web:example.org:users:alice","resourceId":"res-1","version":1,"metadata":{"sequenceNumber":9},"payload":{}}}`)
	until(t, "the place is kept", func() bool {
		kept, _ := storage.Get("semiont.lastEventId.kb-a")
		var places map[string]string
		return json.Unmarshal([]byte(kept), &places) == nil && reflect.DeepEqual(places, map[string]string{"res-1": "p-9"})
	})
}
