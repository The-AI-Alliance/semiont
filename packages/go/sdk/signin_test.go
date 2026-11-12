package semiont

// Signing in and staying signed in, against a stand-in gateway and issuer:
// finding the issuer, the device grant, the refresh grant and its retries,
// the renewal of a kept sign-in, a resumed session, and signing out.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"slices"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// stack is a stand-in gateway and the issuer it trusts. Each handler of the
// issuer is the test's to set; what is not set is not found.
type stack struct {
	gateway, issuer *httptest.Server

	mu      sync.Mutex
	token   func(w http.ResponseWriter, r *http.Request)
	device  func(w http.ResponseWriter, r *http.Request)
	revoke  func(w http.ResponseWriter, r *http.Request)
	accepts func(token string) bool
	grants  int
	asked   []string
}

func newStack(t *testing.T) *stack {
	t.Helper()
	s := &stack{accepts: func(string) bool { return true }}
	s.issuer = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		handler := map[string]func(http.ResponseWriter, *http.Request){"/token": s.token, "/device": s.device, "/revoke": s.revoke}[r.URL.Path]
		if r.URL.Path == "/token" {
			s.grants++
		}
		s.mu.Unlock()
		switch {
		case r.URL.Path == "/.well-known/openid-configuration":
			writeJSON(w, http.StatusOK, map[string]any{
				"issuer": s.issuer.URL, "authorization_endpoint": s.issuer.URL + "/authorize", "token_endpoint": s.issuer.URL + "/token",
				"device_authorization_endpoint": s.issuer.URL + "/device", "revocation_endpoint": s.issuer.URL + "/revoke",
			})
		case handler != nil:
			handler(w, r)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(s.issuer.Close)
	s.gateway = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/.well-known/oauth-protected-resource":
			writeJSON(w, http.StatusOK, map[string]any{"resource": "https://kb.example", "authorization_servers": []string{s.issuer.URL}, "bearer_methods_supported": []string{"header"}})
		case "/api/users/me":
			token := r.Header.Get("Authorization")[len("Bearer "):]
			s.mu.Lock()
			s.asked = append(s.asked, token)
			accepted := s.accepts(token)
			s.mu.Unlock()
			if !accepted {
				writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "Invalid token"})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"did": "did:web:example.org:users:alice", "email": "a@example.com", "domain": "example.org", "name": "Alice", "image": nil})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(s.gateway.Close)
	return s
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func (s *stack) set(set func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	set()
}

func (s *stack) grantsMade() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.grants
}

func quickTiming() Timing {
	timing := DefaultTiming()
	timing.RefreshRetry = RetryPolicy{Attempts: 3, InitialDelay: time.Millisecond, MaxDelay: time.Millisecond}
	timing.HttpRequestTimeout = 5 * time.Second
	return timing
}

func issuerOf() Issuer { return Issuer{HTTP: &http.Client{}, Timing: quickTiming()} }

// issuing answers a token request with a rotated pair, named by n.
func issuing(n int) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"access_token": signedToken(n), "refresh_token": fmt.Sprintf("refresh-%d", n), "token_type": "Bearer", "expires_in": 3600})
	}
}

func TestTheIssuerIsTheOneTheKnowledgeBaseNames(t *testing.T) {
	s := newStack(t)
	endpoints, err := issuerOf().Discover(context.Background(), s.gateway.URL)
	if err != nil {
		t.Fatal(err)
	}
	if endpoints.Issuer != s.issuer.URL || endpoints.Token != s.issuer.URL+"/token" || endpoints.Device != s.issuer.URL+"/device" || endpoints.Revocation != s.issuer.URL+"/revoke" {
		t.Errorf("found %+v", endpoints)
	}
}

func TestAKnowledgeBaseThatNamesNoIssuerHasNowhereToSignIn(t *testing.T) {
	gateway := httptest.NewServer(http.NotFoundHandler())
	defer gateway.Close()
	var failed *SignInError
	if _, err := issuerOf().Discover(context.Background(), gateway.URL); !errors.As(err, &failed) || failed.Code != SignInErrorCodeNoIssuer {
		t.Errorf("got %v, want no-issuer", err)
	}
}

// The device grant: the code is shown, the token endpoint is asked until
// the person approves, and what is issued is kept.
func TestADeviceSignInIsKeptOnceThePersonApproves(t *testing.T) {
	s := newStack(t)
	asks := 0
	s.set(func() {
		s.device = func(w http.ResponseWriter, r *http.Request) {
			if r.FormValue("client_id") != ScriptClientID || r.FormValue("scope") != SignInScope {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_client"})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"device_code": "dc", "user_code": "ABCD-EFGH", "verification_uri": "https://issuer.example/device", "expires_in": 60, "interval": 0})
		}
		s.token = func(w http.ResponseWriter, r *http.Request) {
			if r.FormValue("grant_type") != deviceGrant || r.FormValue("device_code") != "dc" {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_grant"})
				return
			}
			if asks++; asks == 1 {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": "authorization_pending"})
				return
			}
			issuing(1)(w, r)
		}
	})
	store := NewSignInStore(filepath.Join(t.TempDir(), SignInFile))
	var shown DeviceCode
	endpoints, err := SignInWithDevice(context.Background(), issuerOf(), s.gateway.URL, store.Entry("local"), func(code DeviceCode) { shown = code })
	if err != nil {
		t.Fatal(err)
	}
	if shown.UserCode != "ABCD-EFGH" || shown.ExpiresIn != time.Minute {
		t.Errorf("shown %+v", shown)
	}
	if endpoints.Token != s.issuer.URL+"/token" {
		t.Errorf("signed in at %+v", endpoints)
	}
	signIn, ok, err := store.SignIn("local")
	if err != nil || !ok || signIn.RefreshToken != "refresh-1" || signIn.TokenEndpoint != s.issuer.URL+"/token" || signIn.RevocationEndpoint != s.issuer.URL+"/revoke" {
		t.Errorf("kept %+v (%v, %v)", signIn, ok, err)
	}
}

func TestADeviceSignInTheIssuerDeniesIsDenied(t *testing.T) {
	s := newStack(t)
	s.set(func() {
		s.device = func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, http.StatusOK, map[string]any{"device_code": "dc", "user_code": "U", "verification_uri": "https://issuer.example/device", "expires_in": 60, "interval": 0})
		}
		s.token = func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "access_denied"})
		}
	})
	endpoints, err := issuerOf().Discover(context.Background(), s.gateway.URL)
	if err != nil {
		t.Fatal(err)
	}
	var failed *SignInError
	_, err = issuerOf().SignInWithDeviceGrant(context.Background(), endpoints, func(DeviceCode) {})
	if !errors.As(err, &failed) || failed.Code != SignInErrorCodeDenied {
		t.Errorf("got %v, want denied", err)
	}
}

// RFC 8628 §3.2 requires `expires_in` of a device authorization answer: one
// without it has answered without what was asked for, and nobody is shown a
// code whose lifetime nobody knows.
func TestADeviceAuthorizationAnswerWithNoLifetimeIsRefused(t *testing.T) {
	s := newStack(t)
	s.set(func() {
		s.device = func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, http.StatusOK, map[string]any{"device_code": "dc", "user_code": "U", "verification_uri": "https://issuer.example/device", "interval": 0})
		}
		s.token = issuing(1)
	})
	endpoints, err := issuerOf().Discover(context.Background(), s.gateway.URL)
	if err != nil {
		t.Fatal(err)
	}
	shown := 0
	var failed *SignInError
	_, err = issuerOf().SignInWithDeviceGrant(context.Background(), endpoints, func(DeviceCode) { shown++ })
	if !errors.As(err, &failed) || failed.Code != SignInErrorCodeExchange {
		t.Fatalf("got %v, want exchange", err)
	}
	if status, ok := failed.Status(); !ok || status != http.StatusOK {
		t.Errorf("refused with status %d (%v), want the issuer's 200", status, ok)
	}
	s.mu.Lock()
	grants := s.grants
	s.mu.Unlock()
	if shown != 0 || grants != 0 {
		t.Errorf("showed %d codes and asked the token endpoint %d times, want neither", shown, grants)
	}
}

func keptAt(t *testing.T, s *stack, n int) (*SignInStore, SignInKept) {
	t.Helper()
	store := NewSignInStore(filepath.Join(t.TempDir(), SignInFile))
	entry := store.Entry("local")
	held := heldFor(n)
	held.TokenEndpoint, held.RevocationEndpoint = s.issuer.URL+"/token", s.issuer.URL+"/revoke"
	if err := entry.Keep(context.Background(), held); err != nil {
		t.Fatal(err)
	}
	return store, entry
}

// An issuer that is down for a moment is asked again; one that refuses the
// grant is not.
func TestARenewalIsTriedAgainOnlyWhenTheIssuerSaysNotNow(t *testing.T) {
	s := newStack(t)
	failures := 0
	s.set(func() {
		s.token = func(w http.ResponseWriter, r *http.Request) {
			if failures++; failures <= 2 {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			issuing(2)(w, r)
		}
	})
	store, entry := keptAt(t, s, 1)
	renewed, err := issuerOf().RenewKept(context.Background(), entry, signedToken(1))
	if err != nil || renewed != signedToken(2) {
		t.Fatalf("renewed: %v", err)
	}
	if signIn, _, _ := store.SignIn("local"); signIn.RefreshToken != "refresh-2" {
		t.Errorf("the rotation was not kept: %+v", signIn)
	}

	s.set(func() {
		s.grants = 0
		s.token = func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_grant", "error_description": "Token is not active"})
		}
	})
	var failed *SignInError
	_, err = issuerOf().RenewKept(context.Background(), entry, signedToken(2))
	if !errors.As(err, &failed) || failed.Code != SignInErrorCodeExchange {
		t.Fatalf("got %v, want a refused exchange", err)
	}
	if status, ok := failed.Status(); !ok || status != http.StatusBadRequest || s.grantsMade() != 1 {
		t.Errorf("a refused grant was made %d times, its status %d (%v)", s.grantsMade(), status, ok)
	}
}

// A resumed session: the gateway refuses the kept token, the session renews
// it at the issuer and keeps the rotation, and the gateway accepts the new
// one.
func TestAResumedSessionRenewsARefusedTokenAndKeepsTheRotation(t *testing.T) {
	s := newStack(t)
	s.set(func() {
		s.token = issuing(2)
		s.accepts = func(token string) bool { return token == signedToken(2) }
	})
	store, entry := keptAt(t, s, 1)
	token := NewVariable("")
	// The session's client, over a wire nothing is sent on.
	wire := newWorkerWire()
	client := NewClient(ClientConfig{Transport: wire, Timing: quickTiming()})
	session, err := ResumeSession(context.Background(), ResumeConfig{
		Kb: gatewayTarget(t, "local", s.gateway.URL), Client: client, Kept: entry, Token: token,
		HTTP: &http.Client{}, Timing: quickTiming(),
	})
	if err != nil {
		client.Close()
		wire.Close()
		t.Fatal(err)
	}
	errs := session.Errors()
	var said []string
	heard := make(chan struct{})
	go func() {
		defer close(heard)
		for failure := range errs {
			var own *SessionError
			if errors.As(failure, &own) {
				said = append(said, fmt.Sprintf("%s: %s", own.Code, own.Message))
			}
		}
	}()
	closed := sync.OnceFunc(func() {
		client.Close()
		session.Close()
		wire.Close()
	})
	defer closed()
	ready, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := session.Ready(ready); err != nil {
		t.Fatal(err)
	}
	if token.Value() != signedToken(2) {
		t.Error("the session does not hold the renewed token")
	}
	if user := session.User().Value(); user == nil || user.Email == nil || *user.Email != "a@example.com" {
		t.Errorf("the session says it is %+v", user)
	}
	if signIn, _, _ := store.SignIn("local"); signIn.RefreshToken != "refresh-2" {
		t.Errorf("the rotation was not kept: %+v", signIn)
	}
	if grants := s.grantsMade(); grants != 1 {
		t.Errorf("%d grants, want one", grants)
	}
	closed()
	select {
	case <-heard:
	case <-time.After(10 * time.Second):
		t.Fatal("the session's errors stream did not end once the session was closed")
	}
	if len(said) != 0 {
		t.Errorf("the session said %v on its errors stream", said)
	}
}

// The session closes while a refusal's renewal of the kept sign-in is under
// way. The refusal is given no token at once; the renewal finishes, and Close
// returns only once it has, so the rotation the issuer answered is kept; the
// closed session does not take the renewed token, and nothing is signed out.
// A refusal once the session is closed is given none, whatever token it
// names, and asks the issuer nothing.
func TestASessionClosedWhileItsSignInIsRenewedGivesTheRefusalNoTokenAndKeepsTheRotation(t *testing.T) {
	s := newStack(t)
	arrived, release := make(chan struct{}), make(chan struct{})
	arrive, released := sync.OnceFunc(func() { close(arrived) }), sync.OnceFunc(func() { close(release) })
	defer released()
	s.set(func() {
		s.token = func(w http.ResponseWriter, r *http.Request) {
			arrive()
			<-release
			issuing(2)(w, r)
		}
	})
	store, entry := keptAt(t, s, 1)
	token := NewVariable("")
	// The session's client, over a wire nothing is sent on.
	wire := newWorkerWire()
	client := NewClient(ClientConfig{Transport: wire, Timing: quickTiming()})
	defer func() {
		client.Close()
		wire.Close()
	}()
	var mu sync.Mutex
	var ended []SessionEndReason
	session, err := ResumeSession(context.Background(), ResumeConfig{
		Kb: gatewayTarget(t, "local", s.gateway.URL), Client: client, Kept: entry, Token: token,
		HTTP: &http.Client{}, Timing: quickTiming(),
		OnAuthFailed: func(reason SessionEndReason) {
			mu.Lock()
			defer mu.Unlock()
			ended = append(ended, reason)
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	ready, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := session.Ready(ready); err != nil {
		t.Fatal(err)
	}
	given := make(chan bool, 1)
	go func() {
		renewed, ok := session.Refresh(context.Background(), signedToken(1))
		given <- ok || renewed != ""
	}()
	<-arrived
	closed := make(chan struct{})
	go func() {
		session.Close()
		close(closed)
	}()
	select {
	case tokenGiven := <-given:
		if tokenGiven {
			t.Error("the refusal waiting on the renewal was given a token")
		}
	case <-time.After(time.Second):
		t.Fatal("the refusal waiting on the renewal was not answered at the close")
	}
	settledFor()
	select {
	case <-closed:
		t.Error("the close returned before the renewal under way had finished")
	default:
	}
	released()
	select {
	case <-closed:
	case <-time.After(10 * time.Second):
		t.Fatal("the close did not return once the renewal had finished")
	}
	if signIn, _, _ := store.SignIn("local"); signIn.RefreshToken != "refresh-2" {
		t.Errorf("the rotation the renewal brought was not kept: %+v", signIn)
	}
	if token.Value() != signedToken(1) {
		t.Error("the closed session took the token its renewal brought")
	}
	// The token it holds, and one it does not.
	for _, refused := range []string{signedToken(1), signedToken(0)} {
		if renewed, ok := session.Refresh(context.Background(), refused); ok || renewed != "" {
			t.Error("a refusal once the session is closed was given a token")
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if grants := s.grantsMade(); grants != 1 || len(ended) != 0 {
		t.Errorf("%d grants, want one; the session ended as %v, want not at all", grants, ended)
	}
}

// The gateway refuses a kept token that has not expired, and its renewal gets
// no answer: the renewal on the reconnect backoff is handed that token, so
// the kept sign-in's renewal asks the issuer for a grant. Handed none, it
// would give back the kept token, which the gateway has refused, and the
// session would end as if the issuer had issued it.
func TestARenewalOnTheBackoffIsHandedTheTokenWhoseRenewalGotNoAnswer(t *testing.T) {
	s := newStack(t)
	timing := quickTiming()
	timing.Reconnect, timing.MaxReconnect = 20*time.Millisecond, 20*time.Millisecond
	s.set(func() {
		s.token = func(w http.ResponseWriter, r *http.Request) {
			// Every attempt of the first renewal finds the issuer down.
			if s.grantsMade() <= timing.RefreshRetry.Attempts {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			issuing(2)(w, r)
		}
		s.accepts = func(token string) bool { return token == signedToken(2) }
	})
	_, entry := keptAt(t, s, 1)
	token := NewVariable("")
	wire := newWorkerWire()
	client := NewClient(ClientConfig{Transport: wire, Timing: timing})
	session, err := ResumeSession(context.Background(), ResumeConfig{
		Kb: gatewayTarget(t, "local", s.gateway.URL), Client: client, Kept: entry, Token: token,
		HTTP: &http.Client{}, Timing: timing,
	})
	if err != nil {
		client.Close()
		wire.Close()
		t.Fatal(err)
	}
	errs := session.Errors()
	var said []SessionErrorCode
	heard := make(chan struct{})
	go func() {
		defer close(heard)
		for failure := range errs {
			var own *SessionError
			if errors.As(failure, &own) {
				said = append(said, own.Code)
			}
		}
	}()
	closed := sync.OnceFunc(func() {
		client.Close()
		session.Close()
		wire.Close()
	})
	defer closed()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for user := range session.User().Changes(ctx) {
		if user != nil {
			break
		}
	}
	if token.Value() != signedToken(2) || session.User().Value() == nil {
		t.Fatal("the session was not renewed on the backoff, and signed in")
	}
	s.mu.Lock()
	asked := slices.Clone(s.asked)
	s.mu.Unlock()
	if !slices.Equal(asked, []string{signedToken(1), signedToken(2)}) {
		t.Errorf("the gateway was asked about %d tokens, want the one it refused and then the one the issuer granted", len(asked))
	}
	if _, held, err := entry.Held(ctx); err != nil || !held {
		t.Errorf("the sign-in is kept: %v (%v)", held, err)
	}
	closed()
	select {
	case <-heard:
	case <-time.After(10 * time.Second):
		t.Fatal("the session's errors stream did not end once the session was closed")
	}
	if !slices.Equal(said, []SessionErrorCode{SessionErrorCodeRefreshExhausted}) {
		t.Errorf("the session said %v on its errors stream, want the one %s", said, SessionErrorCodeRefreshExhausted)
	}
}

// What the session's schedule does when a wait runs out: a wait for a token
// renewed some other way since, here by a refusal, renews nothing, since the
// token held has a wait of its own; a wait for the token held renews it, and
// the renewal is handed that token. The race that brings a wait to run out
// for a token since replaced is not run here: this is the step it comes to.
func TestAWaitThatRanOutForATokenSinceReplacedRenewsNothing(t *testing.T) {
	kept := &MemorySignIn{}
	if err := kept.Keep(context.Background(), heldFor(1)); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var handed []string
	token := NewVariable("")
	wire := newWorkerWire()
	client := NewClient(ClientConfig{Transport: wire, Timing: quickTiming()})
	session, err := StartSession(context.Background(), SessionConfig{
		Kb: api.KbTarget{Id: "local"}, Client: client, Token: token, Kept: kept,
		Refresh: func(_ context.Context, renewing string) (string, error) {
			mu.Lock()
			defer mu.Unlock()
			handed = append(handed, renewing)
			return signedToken(len(handed) + 1), nil
		},
		Timing: quickTiming(),
	})
	if err != nil {
		client.Close()
		wire.Close()
		t.Fatal(err)
	}
	defer func() {
		client.Close()
		session.Close()
		wire.Close()
	}()
	ready, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := session.Ready(ready); err != nil {
		t.Fatal(err)
	}
	if renewed, ok := session.Refresh(context.Background(), signedToken(1)); !ok || renewed != signedToken(2) {
		t.Fatal("the refusal of the kept token was not answered by its renewal")
	}

	session.renewDue(signedToken(1))
	mu.Lock()
	stale := slices.Clone(handed)
	mu.Unlock()
	if !slices.Equal(stale, []string{signedToken(1)}) || token.Value() != signedToken(2) {
		t.Errorf("a wait for the token the refusal renewed renewed %d times in all, want once: the refusal's", len(stale))
	}

	session.renewDue(signedToken(2))
	mu.Lock()
	defer mu.Unlock()
	if !slices.Equal(handed, []string{signedToken(1), signedToken(2)}) || token.Value() != signedToken(3) {
		t.Errorf("a wait for the token held renewed %d times in all, want twice, the second handed the token that fell due", len(handed))
	}
}

// A session opened over a kept sign-in asks the gateway who its token is,
// once, and so knows who is signed in, unless it is told not to.
func TestASessionFromAKeptSignInAsksWhoItsTokenIsUnlessToldNotTo(t *testing.T) {
	for _, row := range []struct {
		why  string
		skip bool
		asks int
	}{
		{"left to ask", false, 1},
		{"told not to", true, 0},
	} {
		t.Run(row.why, func(t *testing.T) {
			s := newStack(t)
			_, entry := keptAt(t, s, 1)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			session, end, err := SessionFromKept(ctx, SessionFromKeptConfig{
				Kb: gatewayTarget(t, "local", s.gateway.URL), Kept: entry, HTTP: &http.Client{}, Timing: quickTiming(),
				SkipAskingWhoTokenIs: row.skip,
			})
			if err != nil {
				t.Fatal(err)
			}
			defer end()
			s.mu.Lock()
			asked := len(s.asked)
			s.mu.Unlock()
			if asked != row.asks {
				t.Errorf("the gateway was asked %d times, want %d", asked, row.asks)
			}
			if knows := session.User().Value() != nil; knows != (row.asks == 1) {
				t.Errorf("the session knows who is signed in: %v", knows)
			}
			if session.Token().Value() != signedToken(1) {
				t.Error("the session does not hold the kept token")
			}
		})
	}
}

// Signing out revokes the refresh token at the issuer and forgets the
// sign-in; an issuer that cannot be told does not keep the person signed in.
func TestSigningOutForgetsTheSignInWhateverTheIssuerAnswers(t *testing.T) {
	s := newStack(t)
	var revoked string
	s.set(func() {
		s.revoke = func(w http.ResponseWriter, r *http.Request) {
			revoked = r.FormValue("token")
			w.WriteHeader(http.StatusOK)
		}
	})
	store, entry := keptAt(t, s, 1)
	told, err := SignOut(context.Background(), issuerOf(), entry)
	if err != nil || !told || revoked != "refresh-1" {
		t.Errorf("signed out: told %v, revoked %q (%v)", told, revoked, err)
	}
	if _, kept, _ := store.SignIn("local"); kept {
		t.Error("the sign-in is still kept")
	}

	s.set(func() {
		s.revoke = func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusServiceUnavailable) }
	})
	store, entry = keptAt(t, s, 2)
	told, err = SignOut(context.Background(), issuerOf(), entry)
	if err != nil || told {
		t.Errorf("an issuer that could not be told was told (%v)", err)
	}
	if _, kept, _ := store.SignIn("local"); kept {
		t.Error("the sign-in is still kept after an issuer that could not be told")
	}
}

// gatewayTarget is the knowledge base id, at the gateway whose origin is
// origin.
func gatewayTarget(t *testing.T, id, origin string) api.KbTarget {
	t.Helper()
	at, err := url.Parse(origin)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(at.Port())
	if err != nil {
		t.Fatal(err)
	}
	var endpoint api.KbEndpoint
	if err := endpoint.FromHttpEndpoint(api.HttpEndpoint{Kind: api.HttpEndpointKindHttp, Protocol: api.HttpEndpointProtocol(at.Scheme), Host: at.Hostname(), Port: port}); err != nil {
		t.Fatal(err)
	}
	return api.KbTarget{Id: id, Label: id, Endpoint: endpoint}
}
