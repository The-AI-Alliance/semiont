package semiont

// An agent's token: a service account's token from its issuer, exchanged at
// the gateway for the agent's, kept until it is due and renewed when refused.

import (
	"context"
	"encoding/json"
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

	mu        sync.Mutex
	grants    int
	exchanges []string // the Authorization each exchange came with
	asked     []agentAsked
	refuse    bool
}

type agentAsked struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
}

func newAgentWorld(t *testing.T) *agentWorld {
	t.Helper()
	w := &agentWorld{}
	w.issuer = httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/realms/semiont/.well-known/openid-configuration":
			writeJSON(rw, http.StatusOK, map[string]any{"token_endpoint": w.issuer.URL + "/realms/semiont/token"})
		case "/realms/semiont/token":
			if r.FormValue("grant_type") != "client_credentials" || r.FormValue("client_id") != "semiont-worker" || r.FormValue("client_secret") != "s3cret" {
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
		if r.URL.Path != "/api/tokens/agent" || r.Method != http.MethodPost {
			http.NotFound(rw, r)
			return
		}
		var asked agentAsked
		_ = json.NewDecoder(r.Body).Decode(&asked)
		w.mu.Lock()
		w.exchanges = append(w.exchanges, r.Header.Get("Authorization"))
		w.asked = append(w.asked, asked)
		n, refuse := len(w.exchanges), w.refuse
		w.mu.Unlock()
		if refuse {
			writeJSON(rw, http.StatusForbidden, map[string]any{"error": "not an agent"})
			return
		}
		writeJSON(rw, http.StatusOK, map[string]any{"token": signedToken(200 + n), "did": "did:web:kb.example:agents:ollama:gemma2"})
	}))
	t.Cleanup(w.gateway.Close)
	return w
}

func (w *agentWorld) signIn(t *testing.T, secret string) (*AgentToken, error) {
	t.Helper()
	issuer := Issuer{HTTP: &http.Client{}, Timing: quickTiming()}
	service := NewServiceToken(Credential{Issuer: w.issuer.URL + "/realms/semiont", ClientID: "semiont-worker", ClientSecret: secret}, issuer)
	return SignInAgent(context.Background(), AgentConfig{Gateway: w.gateway.URL, Provider: "ollama", Model: "gemma2", Service: service, HTTP: &http.Client{}, Timing: quickTiming()})
}

func TestAnAgentIsSignedInAsTheGatewayNamesIt(t *testing.T) {
	w := newAgentWorld(t)
	agent, err := w.signIn(t, "s3cret")
	if err != nil {
		t.Fatal(err)
	}
	defer agent.Close()
	if agent.Token().Value() != signedToken(201) || agent.DID().String() != "did:web:kb.example:agents:ollama:gemma2" {
		t.Errorf("signed in as %q with a token that is not the gateway's", agent.DID())
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.exchanges) != 1 || w.exchanges[0] != "Bearer "+signedToken(101) || w.asked[0] != (agentAsked{Provider: "ollama", Model: "gemma2"}) {
		t.Errorf("the exchange was %v of %v", w.exchanges, w.asked)
	}
}

// A refusal is answered by another exchange, under the service token kept
// until it is due: no second grant.
func TestARefusedAgentTokenIsExchangedAgain(t *testing.T) {
	w := newAgentWorld(t)
	agent, err := w.signIn(t, "s3cret")
	if err != nil {
		t.Fatal(err)
	}
	defer agent.Close()
	token, ok := agent.Refresh(context.Background())
	if !ok || token != signedToken(202) || agent.Token().Value() != token {
		t.Errorf("refreshed to the gateway's second token: %v, %v", token == signedToken(202), ok)
	}
	w.mu.Lock()
	grants := w.grants
	w.refuse = true
	w.mu.Unlock()
	if grants != 1 {
		t.Errorf("%d grants for two exchanges: the service token was not kept", grants)
	}
	if _, ok := agent.Refresh(context.Background()); ok {
		t.Error("a refused exchange gave a token")
	}
	if agent.Token().Value() != signedToken(202) {
		t.Error("a refused exchange took away the token the agent had")
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
