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
			writeJSON(w, http.StatusOK, map[string]any{"device_code": "dc", "user_code": "U", "verification_uri": "https://issuer.example/device", "interval": 0})
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
	session, err := ResumeSession(context.Background(), ResumeConfig{
		Kb: gatewayTarget(t, "local", s.gateway.URL), Kept: entry, Token: token,
		HTTP: &http.Client{}, Timing: quickTiming(), AskWhoTokenIs: true,
		OnError: func(err *SessionError) { t.Errorf("the session said %s: %s", err.Code, err.Message) },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
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
