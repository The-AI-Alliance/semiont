package verbs

// The invisible session refresh, as EVERY verb gets it.
//
// `semiont login` stores a short-lived access token and the refresh token that
// renews it. A verb's session is the Go SDK's, held to the session table every
// SDK runs (specs/src/session/cases.json): it asks the gateway who its token
// is at its start, renews a token that has expired or that the gateway
// refuses, goes on under the renewed token and keeps the rotation, and
// forgets a sign-in it cannot renew. The user is sent back to `semiont login`
// only when the renewal itself fails, or the gateway refuses the token it
// renewed to.
//
// In process, over the SDK's real transport and session: the gateway is a
// stub that accepts the tokens each test says it does, and records every one
// it was shown; the issuer is the one other real HTTP server here. What is
// asserted is the launcher's part: how many grants the issuer sees, what is
// kept, and what the user is told. A token is told apart by its `tag` claim.
//
// Failure messages name counts and positions, never a token's value: even a
// stub's token stays out of test output on principle.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	launcher "github.com/The-AI-Alliance/semiont/packages/go/launcher"
	"github.com/The-AI-Alliance/semiont/packages/go/launcher/harness"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
)

// issuerStub is the token endpoint: it answers the refresh grant as scripted
// and records every form it received.
type issuerStub struct {
	*httptest.Server
	mu     sync.Mutex
	grants []url.Values
}

func newIssuerStub(t *testing.T, status int, body string) *issuerStub {
	t.Helper()
	s := &issuerStub{}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		s.mu.Lock()
		s.grants = append(s.grants, r.PostForm)
		s.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(s.Close)
	return s
}

func (s *issuerStub) refreshGrants() []url.Values {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]url.Values(nil), s.grants...)
}

// tokenTagged is an access token as an issuer issues one, told apart by its
// tag, that expires lifetime from now.
func tokenTagged(tag string, lifetime time.Duration) string {
	now := time.Now()
	claims, _ := json.Marshal(map[string]any{
		"tag": tag, "email": "t@example.com", "iss": "http://issuer.test/realms/semiont",
		"iat": now.Unix(), "exp": now.Add(lifetime).Unix(),
	})
	return "eyJhbGciOiJub25lIn0." + base64.RawURLEncoding.EncodeToString(claims) + ".c2ln"
}

// tagOf is the tag of a token tokenTagged made; "" for any other.
func tagOf(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var claims struct {
		Tag string `json:"tag"`
	}
	_ = json.Unmarshal(payload, &claims)
	return claims.Tag
}

// renewed is the issuer's answer to a refresh grant it honours: a new access
// token, token-2, living 300 seconds, and a ROTATED refresh token, which the
// launcher must keep.
func renewed() string {
	return `{"access_token":"` + tokenTagged("token-2", 300*time.Second) + `","refresh_token":"refresh-2","token_type":"Bearer","expires_in":300}`
}

// storeSession replaces the fixture's bare token with a renewable session:
// access token token-1, living lifetime from now (an expired one when it is
// negative), refresh token refresh-1, the stub as its issuer.
func storeSession(t *testing.T, issuer *issuerStub, lifetime time.Duration) {
	t.Helper()
	store := semiont.NewSignInStore(filepath.Join(launcher.StateDir(), semiont.SignInFile))
	if err := store.Entry(localKey).Keep(context.Background(), semiont.HeldSignIn{
		Access: tokenTagged("token-1", lifetime), Refresh: "refresh-1",
		ClientID: semiont.ScriptClientID, TokenEndpoint: issuer.URL + "/token",
	}); err != nil {
		t.Fatal(err)
	}
}

// kept is the sign-in the store holds for the local stack; false when none.
func kept(t *testing.T) (semiont.SignIn, bool) {
	t.Helper()
	signIn, ok := launcher.LoadTokens()[localKey]
	return signIn, ok
}

// shown is one bearer the gateway stub was shown: on which route, and
// whether it accepted it.
type shown struct {
	route    string
	token    string
	accepted bool
}

// gatewayStub is the stack's gateway, as much of it as a verb's session
// meets: the bus's two routes, and who a token is. It accepts the tokens
// accepts says it does, by their tag, and refuses every other with 401. A
// request on an operation it was given a reply for is answered on the
// requester's stream.
type gatewayStub struct {
	*httptest.Server
	accepts func(token string) bool
	// replies: request channel → the response its result carries.
	replies map[bus.Channel]string

	mu    sync.Mutex
	shown []shown
	// emits is the channels of the emits it accepted, in order.
	emits []bus.Channel
	// streams: clientId → the events its stream is sent.
	streams map[string]chan string
	done    chan struct{}
}

func newGatewayStub(t *testing.T, accepts func(token string) bool) *gatewayStub {
	t.Helper()
	g := &gatewayStub{
		accepts: accepts,
		replies: map[bus.Channel]string{},
		streams: map[string]chan string{},
		done:    make(chan struct{}),
	}
	g.Server = httptest.NewServer(http.HandlerFunc(g.serve))
	// Cleanups run last first: the held streams end, then the server closes.
	t.Cleanup(g.Close)
	t.Cleanup(func() { close(g.done) })
	return g
}

func (g *gatewayStub) admit(r *http.Request) bool {
	token := tagOf(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	accepted := g.accepts(token)
	g.mu.Lock()
	g.shown = append(g.shown, shown{route: r.URL.Path, token: token, accepted: accepted})
	g.mu.Unlock()
	return accepted
}

func (g *gatewayStub) serve(w http.ResponseWriter, r *http.Request) {
	if !g.admit(r) {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	switch r.URL.Path {
	case "/api/users/me":
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, `{"did":"did:web:example.org:users:t","email":"t@example.com","domain":"example.org","name":null,"image":null}`)
	case "/bus/subscribe":
		var body struct {
			ClientID string `json:"clientId"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		events := make(chan string, 16)
		g.mu.Lock()
		g.streams[body.ClientID] = events
		g.mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher := w.(http.Flusher)
		flusher.Flush()
		for {
			select {
			case <-r.Context().Done():
				return
			case <-g.done:
				return
			case event := <-events:
				_, _ = io.WriteString(w, event)
				flusher.Flush()
			}
		}
	case "/bus/emit":
		var body struct {
			Channel       bus.Channel `json:"channel"`
			ClientID      string      `json:"clientId"`
			CorrelationID string      `json:"correlationId"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		g.mu.Lock()
		g.emits = append(g.emits, body.Channel)
		response, scripted := g.replies[body.Channel]
		stream := g.streams[body.ClientID]
		g.mu.Unlock()
		if operation, isOperation := bus.Operations[body.Channel]; isOperation && scripted && body.CorrelationID != "" && stream != nil {
			data, _ := json.Marshal(map[string]any{
				"channel":       operation.Result,
				"correlationId": body.CorrelationID,
				"payload":       json.RawMessage(`{"response":` + response + `}`),
			})
			stream <- fmt.Sprintf("event: bus-event\nid: e-%s:%s\ndata: %s\n\n", operation.Result, body.CorrelationID, data)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_, _ = io.WriteString(w, `{"subscribers":1}`)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

// bearers is every bearer the gateway was shown, in order.
func (g *gatewayStub) bearers() []shown {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]shown(nil), g.shown...)
}

// acceptedEmits is the channels of the emits the gateway accepted, in order.
func (g *gatewayStub) acceptedEmits() []bus.Channel {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]bus.Channel(nil), g.emits...)
}

// times is how often the token tagged token was shown on route; "" is every
// route.
func (g *gatewayStub) times(route, token string) int {
	n := 0
	for _, s := range g.bearers() {
		if s.token == token && (route == "" || s.route == route) {
			n++
		}
	}
	return n
}

// gatewayFixture is verbFixture with the recorded stack's gateway the stub.
func gatewayFixture(t *testing.T, gateway *gatewayStub) {
	t.Helper()
	gatewayAt(t, gateway.URL)
}

// gatewayAt is verbFixture with the recorded stack's gateway at base.
func gatewayAt(t *testing.T, base string) {
	t.Helper()
	verbFixture(t)
	recordStacks(t, localStack(launcher.ServiceState{Endpoint: base + "/api/health"}))
}

// only accepts the one token tagged token.
func only(token string) func(string) bool {
	return func(presented string) bool { return presented == token }
}

// nothing accepts no token.
func nothing(string) bool { return false }

// A gateway that is not there is said at once. The transport takes a first
// connect that gets no answer as a state, not a failure, and a request waits
// out its deadline for a stream to open; the verb must not: it fails as soon
// as the first connect does, naming the gateway.
func TestBusVerbAgainstAGatewayThatIsNotThereFailsAtOnce(t *testing.T) {
	gone := httptest.NewServer(http.NotFoundHandler())
	base := gone.URL
	gone.Close()
	gatewayAt(t, base)

	began := time.Now()
	_, stderr := harness.CaptureOutput(t, func() {
		if code := Browse([]string{"--json"}); code == 0 {
			t.Error("browse: exit 0 against a gateway that is not there")
		}
	})
	if took := time.Since(began); took > 10*time.Second {
		t.Errorf("browse took %s to fail: it waited out the request's deadline", took.Round(time.Second))
	}
	harness.MustContainAll(t, "stderr", stderr, base, "did not open the event stream")
}

func TestBusVerbRenewsARejectedSessionAndGoesOn(t *testing.T) {
	gateway := newGatewayStub(t, only("token-2"))
	gateway.replies["browse:resources-requested"] = `{"resources":[],"total":0}`
	gatewayFixture(t, gateway)
	issuer := newIssuerStub(t, http.StatusOK, renewed())
	storeSession(t, issuer, time.Hour)

	stdout, stderr := harness.CaptureOutput(t, func() {
		if code := Browse([]string{"--json"}); code != 0 {
			t.Errorf("browse: exit %d — a session the issuer can renew must not fail", code)
		}
	})

	// The stale token was refused, and once the renewed one was offered it
	// was never offered again.
	renewedAt := -1
	for i, s := range gateway.bearers() {
		switch {
		case s.token == "token-2" && renewedAt < 0:
			renewedAt = i
		case s.token == "token-1" && renewedAt >= 0:
			t.Errorf("bearer #%d is the stale token, offered after the renewed one", i+1)
		}
	}
	if gateway.times("", "token-1") == 0 || renewedAt < 0 {
		t.Errorf("want the stale token refused and then the renewed one used")
	}
	// The request went out once, under the renewed token.
	if emits := gateway.acceptedEmits(); len(emits) != 1 || emits[0] != "browse:resources-requested" {
		t.Errorf("want the one request accepted, got %v", emits)
	}

	// Exactly one refresh grant: the public client's, with the stored refresh token.
	grants := issuer.refreshGrants()
	if len(grants) != 1 {
		t.Fatalf("want exactly one refresh grant at the issuer, got %d", len(grants))
	}
	if g := grants[0]; g.Get("grant_type") != "refresh_token" || g.Get("client_id") != semiont.ScriptClientID || g.Get("refresh_token") != "refresh-1" {
		t.Errorf("the grant was not the public client's refresh_token grant carrying the stored refresh token")
	}

	// The rotation is SAVED: the next command starts from the renewed pair,
	// and knows when the renewed access token expires.
	e, _ := kept(t)
	if tagOf(e.Token) != "token-2" || e.RefreshToken != "refresh-2" {
		t.Errorf("tokens.json was not rotated to the renewed access and refresh tokens")
	}
	if left := time.Until(e.ExpiresAt); left < 4*time.Minute || left > 5*time.Minute+time.Second {
		t.Errorf("tokens.json must record the renewed token's expiry from expires_in (300s)")
	}

	// The renewal is narrated on stderr and nowhere near the result: a --json
	// reply piped to jq must still be one JSON document.
	harness.MustContainAll(t, "stderr", stderr, "Session refreshed")
	if !json.Valid([]byte(strings.TrimSpace(stdout))) {
		t.Errorf("--json output is no longer one JSON document:\n%s", stdout)
	}
	// A rejection that was put right is not reported as one.
	for _, s := range []string{stdout, stderr} {
		if strings.Contains(s, "rejected") || strings.Contains(s, "semiont login") {
			t.Errorf("a renewed session was still reported as rejected:\n%s", s)
		}
	}
}

// The same session for a fire-and-forget verb. Its emit and its stream are
// refused together, and answered by one renewal.
func TestEmitVerbRenewsARejectedSessionToo(t *testing.T) {
	gateway := newGatewayStub(t, only("token-2"))
	gatewayFixture(t, gateway)
	issuer := newIssuerStub(t, http.StatusOK, renewed())
	storeSession(t, issuer, time.Hour)

	harness.CaptureOutput(t, func() {
		if code := Beckon([]string{"--resource", "res-1", "--annotation", "ann-2"}); code != 0 {
			t.Errorf("beckon: exit %d — a session the issuer can renew must not fail", code)
		}
	})
	if emits := gateway.acceptedEmits(); len(emits) != 1 || emits[0] != bus.BeckonFocus.Channel() {
		t.Errorf("want the one signal accepted, got %v", emits)
	}
	if n := len(issuer.refreshGrants()); n != 1 {
		t.Errorf("want exactly one refresh grant, got %d", n)
	}
	if e, _ := kept(t); tagOf(e.Token) != "token-2" {
		t.Errorf("tokens.json was not rotated to the renewed access token")
	}
}

func TestBusVerbReportsRejectionWhenTheRefreshFails(t *testing.T) {
	gateway := newGatewayStub(t, nothing)
	gatewayFixture(t, gateway)
	issuer := newIssuerStub(t, http.StatusBadRequest, `{"error":"invalid_grant","error_description":"Token is not active"}`)
	storeSession(t, issuer, time.Hour)

	_, stderr := harness.CaptureOutput(t, func() {
		if code := Browse(nil); code == 0 {
			t.Errorf("browse must fail when the session is rejected and the issuer will not renew it")
		}
	})
	// The refusal names the verb, the rejection, WHY the renewal failed, and
	// the one fix that applies.
	harness.MustContainAll(t, "stderr", stderr, "browse", "session was rejected", "could not renew", "invalid_grant", "semiont login")
	// A renewal that failed earns nothing more: no second grant, and nothing
	// sent after the refusal. The stored token is shown once to be asked
	// about, and at most once on the stream, which the client opens with the
	// token its session holds while the session asks, as every SDK's does.
	if n := gateway.times("/api/users/me", "token-1"); n != 1 {
		t.Errorf("want the gateway asked once who the stored token is, got %d", n)
	}
	if n := gateway.times("/bus/subscribe", "token-1"); n > 1 {
		t.Errorf("want the stored token offered to the stream at most once, got %d", n)
	}
	if got := gateway.bearers(); len(got) != gateway.times("/api/users/me", "token-1")+gateway.times("/bus/subscribe", "token-1") {
		t.Errorf("want nothing shown but the stored token, asked about and offered to the stream, got %v", got)
	}
	if n := len(issuer.refreshGrants()); n != 1 {
		t.Errorf("want exactly one refresh grant, got %d", n)
	}
	// A sign-in that cannot be renewed is forgotten, as the session table's
	// ending states: the next command says there is no session, and how to
	// get one.
	if _, still := kept(t); still {
		t.Errorf("a sign-in whose renewal failed is still kept")
	}
}

func TestBusVerbRefusedAfterASuccessfulRefreshSaysSo(t *testing.T) {
	gateway := newGatewayStub(t, nothing)
	gatewayFixture(t, gateway)
	issuer := newIssuerStub(t, http.StatusOK, renewed())
	storeSession(t, issuer, time.Hour)

	_, stderr := harness.CaptureOutput(t, func() {
		if code := Browse(nil); code == 0 {
			t.Errorf("browse must fail when the renewed token is refused too")
		}
	})
	// The renewal WORKED; "could not renew" would contradict the refresh line
	// just printed. This is the gateway refusing the account.
	harness.MustContainAll(t, "stderr", stderr, "after a successful refresh", "semiont login")
	if strings.Contains(stderr, "could not renew") {
		t.Errorf("claimed the refresh failed when it succeeded:\n%s", stderr)
	}
	// One renewal, and the gateway asked once who the renewed token is. A
	// second refusal is not an invitation to loop: the renewed token is shown
	// to be asked about, and at most once on the stream, never again.
	if n := gateway.times("", "token-2"); n != gateway.times("/api/users/me", "token-2")+gateway.times("/bus/subscribe", "token-2") || gateway.times("/bus/subscribe", "token-2") > 1 {
		t.Errorf("want the renewed token shown to be asked about and at most once on the stream, got %d showings", n)
	}
	if n := gateway.times("/api/users/me", "token-2"); n != 1 {
		t.Errorf("want the gateway asked once who the renewed token is, got %d", n)
	}
	if n := len(issuer.refreshGrants()); n != 1 {
		t.Errorf("want exactly one refresh grant, got %d", n)
	}
}

// A session with nothing to renew from — the fixture's bare access token — is
// refused plainly, without a grant nobody could send.
func TestBusVerbWithNoRefreshTokenReportsRejection(t *testing.T) {
	gateway := newGatewayStub(t, nothing)
	gatewayFixture(t, gateway)

	_, stderr := harness.CaptureOutput(t, func() {
		if code := Browse(nil); code == 0 {
			t.Errorf("browse must fail when the session is rejected and there is no refresh token")
		}
	})
	harness.MustContainAll(t, "stderr", stderr, "session was rejected", "semiont login")
	if got := gateway.bearers(); len(got) != 1 {
		t.Errorf("want the stored token shown once and nothing after, got %d bearer(s)", len(got))
	}
}

// PROACTIVE: a token the store already knows is expired is renewed before the
// stream opens, so the verb never spends a round-trip to be told 401.
func TestExpiredSessionIsRenewedBeforeTheFirstRequest(t *testing.T) {
	gateway := newGatewayStub(t, only("token-2"))
	gateway.replies["browse:resources-requested"] = `{"resources":[],"total":0}`
	gatewayFixture(t, gateway)
	issuer := newIssuerStub(t, http.StatusOK, renewed())
	storeSession(t, issuer, -time.Minute)

	harness.CaptureOutput(t, func() {
		if code := Browse(nil); code != 0 {
			t.Errorf("browse: exit %d", code)
		}
	})
	if n := gateway.times("", "token-1"); n != 0 {
		t.Errorf("an access token known to be expired still reached the gateway (%d time(s))", n)
	}
	if emits := gateway.acceptedEmits(); len(emits) != 1 {
		t.Errorf("want exactly one request under the renewed token, got %d", len(emits))
	}
	if n := len(issuer.refreshGrants()); n != 1 {
		t.Errorf("want exactly one refresh grant, got %d", n)
	}
}

// …and one that is NOT yet expired is sent as it is. Renewing on every call
// would make the refresh token the access token.
func TestALiveSessionIsSentWithoutRenewal(t *testing.T) {
	gateway := newGatewayStub(t, only("token-1"))
	gateway.replies["browse:resources-requested"] = `{"resources":[],"total":0}`
	gatewayFixture(t, gateway)
	issuer := newIssuerStub(t, http.StatusOK, renewed())
	storeSession(t, issuer, time.Hour)

	harness.CaptureOutput(t, func() {
		if code := Browse(nil); code != 0 {
			t.Errorf("browse: exit %d", code)
		}
	})
	if n := len(issuer.refreshGrants()); n != 0 {
		t.Errorf("a live session was renewed unasked (%d grant(s))", n)
	}
	// Asked about once, at the session's start, as the session table states.
	if n := gateway.times("/api/users/me", "token-1"); n != 1 {
		t.Errorf("a live session's token was asked about %d time(s), want once at its start", n)
	}
}

// An expired token whose renewal fails is not tried: the sign-in is forgotten,
// as the session table's startup states, and the user is sent to log in.
func TestExpiredSessionWhoseRenewalFailsIsForgottenUntried(t *testing.T) {
	gateway := newGatewayStub(t, nothing)
	gatewayFixture(t, gateway)
	issuer := newIssuerStub(t, http.StatusBadRequest, `{"error":"invalid_grant"}`)
	storeSession(t, issuer, -time.Minute)

	_, stderr := harness.CaptureOutput(t, func() {
		if code := Browse(nil); code == 0 {
			t.Errorf("browse must fail when the stored token expired and cannot be renewed")
		}
	})
	harness.MustContainAll(t, "stderr", stderr, "browse", "session was rejected", "could not renew", "expired", "semiont login")
	if n := gateway.times("", "token-1"); n != 0 {
		t.Errorf("an expired token that could not be renewed was sent anyway (%d time(s))", n)
	}
	if n := len(issuer.refreshGrants()); n != 1 {
		t.Errorf("want exactly one refresh grant, got %d", n)
	}
	if _, still := kept(t); still {
		t.Errorf("a sign-in whose renewal failed is still kept")
	}
}
