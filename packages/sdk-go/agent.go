package semiont

// An agent's token at a knowledge base's gateway. A service account signs in
// at its issuer (OIDC discovery, then the client-credentials grant), and its
// token is exchanged at POST /api/tokens/agent for the token of the software
// agent (provider, model), which names the work it does. The gateway answers
// with the agent's DID beside the token: who that work is attributed to, and
// it decides how long the agent token lives.
//
// An AgentToken is a transport's token source, as a person's session is: it
// holds the current token (Token), renews it on the schedule every Semiont
// client keeps, and renews it at once when the gateway refuses it (Refresh, a
// TokenRefresher). It is not a session: an agent whose renewal fails keeps the
// token it has and tries again, since a process holding a token that still
// works does not stop working over one bad round trip.
//
// A failure names the issuer and the client, and never the secret, nor any
// part of a token.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
)

// Credential is a service account at an issuer.
type Credential struct {
	Issuer       string
	ClientID     string
	ClientSecret string
}

// String names the account and never its secret.
func (c Credential) String() string { return fmt.Sprintf("%s at %s", c.ClientID, c.Issuer) }

// GoString names the account and never its secret, for %#v.
func (c Credential) GoString() string { return "semiont.Credential{" + c.String() + "}" }

// ServiceToken is a service account's token, fetched on first use and kept
// until it is due for renewal by the schedule every Semiont client keeps. A
// service reaches another as itself with it.
type ServiceToken struct {
	credential Credential
	issuer     Issuer

	// asking is one grant at a time: those who ask while one is under way are
	// given what it brings.
	asking        sync.Mutex
	tokenEndpoint string
	held          string
	until         time.Time
}

// NewServiceToken is the token of the account credential names, asked of its
// issuer over issuer's HTTP client.
func NewServiceToken(credential Credential, issuer Issuer) *ServiceToken {
	return &ServiceToken{credential: credential, issuer: issuer}
}

func (s *ServiceToken) endpoint(ctx context.Context) (string, error) {
	if s.tokenEndpoint != "" {
		return s.tokenEndpoint, nil
	}
	discovery := strings.TrimRight(s.credential.Issuer, "/") + "/.well-known/openid-configuration"
	status, document, err := s.issuer.get(ctx, discovery)
	if err != nil {
		return "", signInUnanswered(SignInErrorCodeDiscovery, fmt.Sprintf("OIDC discovery for %s got no answer: %v", s.credential.Issuer, err))
	}
	if status < 200 || status > 299 {
		return "", signInRefused(SignInErrorCodeDiscovery, fmt.Sprintf("OIDC discovery for %s failed: HTTP %d from %s", s.credential.Issuer, status, discovery), status)
	}
	endpoint, ok := document.text("token_endpoint")
	if !ok {
		return "", signInRefused(SignInErrorCodeDiscovery, fmt.Sprintf("OIDC discovery for %s returned no token_endpoint", s.credential.Issuer), status)
	}
	s.tokenEndpoint = endpoint
	return endpoint, nil
}

// Authorization is the Authorization header's value: the account's token,
// renewed when it is due. Its own exp and iat say how long it lives, or
// failing those the grant's expires_in; a token that says neither is not
// kept.
func (s *ServiceToken) Authorization(ctx context.Context) (string, error) {
	s.asking.Lock()
	defer s.asking.Unlock()
	if s.held != "" && time.Now().Before(s.until) {
		return "Bearer " + s.held, nil
	}
	endpoint, err := s.endpoint(ctx)
	if err != nil {
		return "", err
	}
	status, answered, err := s.issuer.postForm(ctx, endpoint, url.Values{
		"grant_type": {"client_credentials"}, "client_id": {s.credential.ClientID}, "client_secret": {s.credential.ClientSecret},
	})
	if err != nil {
		return "", signInUnanswered(SignInErrorCodeExchange, fmt.Sprintf("Client-credentials grant for %s at %s got no answer", s.credential.ClientID, s.credential.Issuer))
	}
	if status < 200 || status > 299 {
		// The status, never the body: an error body can echo the secret.
		return "", signInRefused(SignInErrorCodeExchange, fmt.Sprintf("Client-credentials grant for %s at %s failed (HTTP %d)", s.credential.ClientID, s.credential.Issuer, status), status)
	}
	token, ok := answered.text("access_token")
	if !ok {
		return "", signInRefused(SignInErrorCodeExchange, fmt.Sprintf("Token endpoint for %s returned no access_token", s.credential.Issuer), status)
	}
	// Used until it is due for renewal, and never past its expiry.
	lifetime, hasLifetime := answered.seconds("expires_in")
	renewIn, scheduled := refreshDelay(token, time.Now(), s.issuer.Timing)
	if !scheduled && hasLifetime {
		renewIn, scheduled = renewalDelay(lifetime, lifetime, s.issuer.Timing), true
	}
	s.held, s.until = "", time.Time{}
	if scheduled {
		if hasLifetime {
			renewIn = min(renewIn, lifetime)
		}
		s.held, s.until = token, time.Now().Add(renewIn)
	}
	return "Bearer " + token, nil
}

// AgentConfig is what an agent's sign-in is made of.
type AgentConfig struct {
	// Gateway is the gateway's origin.
	Gateway string
	// Provider and Model name the software agent.
	Provider string
	Model    string
	// Service is the service account the agent's token is exchanged for.
	Service *ServiceToken
	// HTTP is the client the exchange is made over.
	HTTP   *http.Client
	Timing Timing
}

// AgentToken is the token of an agent at a gateway, kept signed in until it is
// closed.
type AgentToken struct {
	config AgentConfig
	token  *Variable[string]
	did    api.UserId

	alive  context.Context
	cancel context.CancelFunc
	work   sync.WaitGroup
}

var _ TokenRefresher = (*AgentToken)(nil)

// SignInAgent signs the agent config names in, and keeps it signed in until
// it is closed. It fails when the agent cannot be: a *SignInError when its
// service account could not sign in, a *TransportError when the gateway did
// not make the exchange.
func SignInAgent(ctx context.Context, config AgentConfig) (*AgentToken, error) {
	alive, cancel := context.WithCancel(context.Background())
	a := &AgentToken{config: config, token: NewVariable(""), alive: alive, cancel: cancel}
	signedIn, err := a.exchange(ctx)
	if err != nil {
		cancel()
		return nil, err
	}
	a.did = signedIn.Did
	a.token.Set(signedIn.Token)
	a.work.Add(1)
	go func() {
		defer a.work.Done()
		renewWhenDue(alive, a.token, config.Timing, a.renewWithinBudget)
	}()
	return a, nil
}

// Token is the agent token: the current one, and each one after it. A
// transport is given it as its token, and the AgentToken as its refresher.
func (a *AgentToken) Token() *Variable[string] { return a.token }

// DID is the agent's DID, as the gateway minted it under the knowledge base's
// own domain, carried as it came.
func (a *AgentToken) DID() api.UserId { return a.did }

// Gateway is the gateway the agent is signed in at.
func (a *AgentToken) Gateway() string { return a.config.Gateway }

// Refresh answers the gateway's refusal of the token: it exchanges again. The
// new token; false when the exchange failed.
func (a *AgentToken) Refresh(ctx context.Context) (string, bool) {
	token, err := a.renew(ctx)
	return token, err == nil
}

// Close stops keeping the agent signed in, and returns once that has stopped.
func (a *AgentToken) Close() {
	a.cancel()
	a.work.Wait()
}

func (a *AgentToken) renew(ctx context.Context) (string, error) {
	signedIn, err := a.exchange(ctx)
	if err != nil {
		return "", err
	}
	a.token.Set(signedIn.Token)
	return signedIn.Token, nil
}

// renewWithinBudget is a due renewal. One that fails is tried again inside the
// renewal budget when the failure is transient; spent or refused, the token is
// left as it is and the next is due an interval later, by the schedule's
// floor. A refused credential is not transient, whatever its status: the same
// token gets the same answer.
func (a *AgentToken) renewWithinBudget() {
	_, _ = retryWithBackoff(a.alive, a.config.Timing.RefreshRetry, a.renew,
		func(err error) bool {
			var failed Error
			if !errors.As(err, &failed) || failed.ErrorCode() == string(TransportErrorCodeUnauthorized) {
				return false
			}
			post := http.MethodPost
			facts := RetryFacts{Method: &post}
			if status, ok := failed.Status(); ok {
				facts.Status = &status
			}
			return RetryRuleRefresh.Retryable(facts)
		},
		func(err error) (time.Duration, bool) {
			var refused *TransportError
			if errors.As(err, &refused) {
				return refused.RetryAfter()
			}
			return 0, false
		})
}

// exchange is one exchange: the service account's token for the agent's, and
// the DID the gateway names the agent by.
func (a *AgentToken) exchange(ctx context.Context) (api.AgentTokenResponse, error) {
	authorization, err := a.config.Service.Authorization(ctx)
	if err != nil {
		return api.AgentTokenResponse{}, err
	}
	target := strings.TrimRight(a.config.Gateway, "/") + "/api/tokens/agent"
	body, err := json.Marshal(api.AgentTokenRequest{Provider: a.config.Provider, Model: a.config.Model})
	if err != nil {
		return api.AgentTokenResponse{}, err
	}
	asking, cancel := context.WithTimeout(ctx, a.config.Timing.HttpRequestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(asking, http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		return api.AgentTokenResponse{}, err
	}
	request.Header.Set("Authorization", authorization)
	request.Header.Set("Content-Type", "application/json")
	response, err := a.config.HTTP.Do(request)
	if err != nil {
		return api.AgentTokenResponse{}, transportErrorWithoutResponse(fmt.Sprintf("%s got no answer: %v", target, err), TransportErrorCodeUnavailable)
	}
	defer response.Body.Close()
	answered, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return api.AgentTokenResponse{}, transportErrorWithoutResponse(fmt.Sprintf("%s ended before its answer did: %v", target, err), TransportErrorCodeUnavailable)
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		wait, hasWait := RetryAfter(response.Header.Get("Retry-After"))
		return api.AgentTokenResponse{}, refusal(fmt.Sprintf("the gateway refused the agent token exchange (HTTP %d)", response.StatusCode), response.StatusCode, wait, hasWait, answered)
	}
	var signedIn api.AgentTokenResponse
	if err := json.Unmarshal(answered, &signedIn); err != nil || signedIn.Token == "" || signedIn.Did.IsZero() {
		return api.AgentTokenResponse{}, &TransportError{Code: TransportErrorCodeError, Message: target + " did not answer an agent token", status: response.StatusCode, hasStatus: true}
	}
	return signedIn, nil
}
