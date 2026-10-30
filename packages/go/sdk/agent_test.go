package semiont

// An agent's token: its account's token from its issuer, its bearer at the
// gateway, which names it; kept until it is due and renewed when refused.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

type agentWorld struct {
	issuer, gateway *httptest.Server

	mu     sync.Mutex
	grants int
	asked  []string // each request the gateway was asked: its path and the Authorization it came with
	refuse bool     // the issuer refuses every grant
}

// agentDID is the DID the gateway names the worker's account by.
const agentDID = "did:web:kb.example:agents:service-account-semiont-worker"

func newAgentWorld(t *testing.T) *agentWorld {
	t.Helper()
	w := &agentWorld{}
	w.issuer = httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/realms/semiont/.well-known/openid-configuration":
			writeJSON(rw, http.StatusOK, map[string]any{"token_endpoint": w.issuer.URL + "/realms/semiont/token"})
		case "/realms/semiont/token":
			w.mu.Lock()
			refuse := w.refuse
			w.mu.Unlock()
			if refuse || r.FormValue("grant_type") != "client_credentials" || r.FormValue("client_id") != "semiont-worker" || r.FormValue("client_secret") != "s3cret" {
				writeJSON(rw, http.StatusUnauthorized, map[string]any{"error": "invalid_client", "error_description": "s3cret is wrong"})
				return
			}
			w.mu.Lock()
			w.grants++
			n := w.grants
			w.mu.Unlock()
			writeJSON(rw, http.StatusOK, map[string]any{"access_token": signedToken(100 + n), "expires_in": 3600})
		default:
			http.NotFound(rw, r)
		}
	}))
	t.Cleanup(w.issuer.Close)
	w.gateway = httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		w.mu.Lock()
		w.asked = append(w.asked, r.Method+" "+r.URL.Path+" "+r.Header.Get("Authorization"))
		w.mu.Unlock()
		if r.Method != http.MethodGet || r.URL.Path != "/api/users/me" {
			http.NotFound(rw, r)
			return
		}
		writeJSON(rw, http.StatusOK, map[string]any{"did": agentDID, "email": nil, "name": nil, "image": nil, "domain": "kb.example"})
	}))
	t.Cleanup(w.gateway.Close)
	return w
}

func (w *agentWorld) signIn(t *testing.T, secret string) (*AgentToken, error) {
	t.Helper()
	issuer := Issuer{HTTP: &http.Client{}, Timing: quickTiming()}
	service := NewServiceToken(Credential{Issuer: w.issuer.URL + "/realms/semiont", ClientID: "semiont-worker", ClientSecret: secret}, issuer)
	return SignInAgent(context.Background(), AgentConfig{Gateway: w.gateway.URL, Service: service, HTTP: &http.Client{}, Timing: quickTiming()})
}

// An agent signs in as its account: the issuer's token is its bearer, and the
// gateway names it by that account. Nothing is exchanged.
func TestAnAgentIsSignedInAsItsAccount(t *testing.T) {
	w := newAgentWorld(t)
	agent, err := w.signIn(t, "s3cret")
	if err != nil {
		t.Fatal(err)
	}
	defer agent.Close()
	if agent.Token().Value() != signedToken(101) || agent.DID().String() != agentDID {
		t.Errorf("signed in as %q with a token that is not the issuer's", agent.DID())
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if want := "GET /api/users/me Bearer " + signedToken(101); len(w.asked) != 1 || w.asked[0] != want {
		t.Errorf("the gateway was asked %v, want only %q", w.asked, want)
	}
}

// A refusal is answered by a new grant from the issuer; one the issuer refuses
// leaves the agent the token it had.
func TestARefusedAgentTokenIsGrantedAgain(t *testing.T) {
	w := newAgentWorld(t)
	agent, err := w.signIn(t, "s3cret")
	if err != nil {
		t.Fatal(err)
	}
	defer agent.Close()
	token, ok := agent.Refresh(context.Background(), signedToken(101))
	if !ok || token != signedToken(102) || agent.Token().Value() != token {
		t.Errorf("refreshed to the issuer's second token: %v, %v", token == signedToken(102), ok)
	}
	w.mu.Lock()
	w.refuse = true
	w.mu.Unlock()
	if _, ok := agent.Refresh(context.Background(), signedToken(102)); ok {
		t.Error("a refused grant gave a token")
	}
	if agent.Token().Value() != signedToken(102) {
		t.Error("a refused grant took away the token the agent had")
	}
}

// A refusal of a token the agent has renewed since is answered by the token
// it holds: nothing is asked again.
func TestARefusalOfATokenRenewedSinceIsAnsweredByTheNewOne(t *testing.T) {
	w := newAgentWorld(t)
	agent, err := w.signIn(t, "s3cret")
	if err != nil {
		t.Fatal(err)
	}
	defer agent.Close()
	if _, ok := agent.Refresh(context.Background(), signedToken(101)); !ok {
		t.Fatal("the first refusal was not answered")
	}
	token, ok := agent.Refresh(context.Background(), signedToken(101))
	if !ok || token != signedToken(102) {
		t.Errorf("a refusal of the token renewed since was not answered with the token held (given one: %v)", ok)
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.grants != 2 {
		t.Errorf("a sign-in and two refusals of one token made %d grants, want 2", w.grants)
	}
}

// A gateway that does not name the agent fails the sign-in.
func TestAnAgentTheGatewayDoesNotNameIsNotSignedIn(t *testing.T) {
	w := newAgentWorld(t)
	w.gateway.Close()
	_, err := w.signIn(t, "s3cret")
	var failed *TransportError
	if !errors.As(err, &failed) {
		t.Errorf("signed in, or failed as %v, with no gateway to name it", err)
	}
}

// A service account the issuer refuses fails as a sign-in, and the failure
// says nothing of the secret.
func TestARefusedServiceAccountNamesNoSecret(t *testing.T) {
	w := newAgentWorld(t)
	_, err := w.signIn(t, "wrong")
	if err == nil {
		t.Fatal("signed in with the wrong secret")
	}
	var failed *SignInError
	if !errors.As(err, &failed) || failed.Code != SignInErrorCodeExchange {
		t.Errorf("failed as %v", err)
	}
	if strings.Contains(err.Error(), "s3cret") || strings.Contains(err.Error(), "wrong") {
		t.Errorf("the failure says the secret: %v", err)
	}
	credential := Credential{Issuer: "https://issuer.example", ClientID: "semiont-worker", ClientSecret: "s3cret"}
	for _, shown := range []string{fmt.Sprint(credential), fmt.Sprintf("%+v", credential), fmt.Sprintf("%#v", credential)} {
		if strings.Contains(shown, "s3cret") {
			t.Errorf("a credential printed its secret: %s", shown)
		}
	}
}
