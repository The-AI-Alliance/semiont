package semiont

// A program as an OAuth public client of the issuer a knowledge base trusts:
// finding the issuer from the knowledge base's resource metadata (RFC 9728),
// the device authorization grant (RFC 8628) for a process with no browser,
// the refresh grant, and revocation (RFC 7009). Nothing here names a vendor,
// and no password passes through it: a client that knows a gateway's address
// knows everything it needs, since the knowledge base names its issuer and the
// issuer names its endpoints.
//
// A refusal and an outage are different events. A *SignInError that carries a
// status is the issuer's answer; one that carries none got no answer. A kept
// sign-in's renewal is tried again only on the second kind, and on an issuerAnswer
// that says "not now" (RetryRuleRefresh), inside Timing.RefreshRetry: a
// refused grant is final. Each request of an issuer is answered within
// Timing.HttpRequestTimeout, or fails as unanswered.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code"

// The device grant's defaults, for an issuer that does not say: how long a
// code is good for, and how often the token endpoint is asked, which is also
// how much longer it is left between asks each time the issuer says to slow
// down. RFC 8628 names five seconds.
const (
	deviceCodeLifetime = 600 * time.Second
	devicePoll         = 5 * time.Second
)

// Issuer is how a client reaches the issuer a knowledge base trusts. The
// SDK reads no environment: the HTTP client is the caller's.
type Issuer struct {
	HTTP   *http.Client
	Timing Timing
}

// IssuerEndpoints is an issuer, and the endpoints of it a client uses. Device
// and Revocation are "" when the issuer offers none.
type IssuerEndpoints struct {
	Issuer        string `json:"issuer"`
	Authorization string `json:"authorization"`
	Token         string `json:"token"`
	Device        string `json:"device,omitempty"`
	Revocation    string `json:"revocation,omitempty"`
}

// IssuedTokens is what a grant issued.
type IssuedTokens struct {
	Access  string
	Refresh string
}

// DeviceCode is what a person is shown to approve a sign-in from wherever
// they have a browser. VerificationURIComplete carries the code already, and
// is "" when the issuer gave none.
type DeviceCode struct {
	UserCode                string
	VerificationURI         string
	VerificationURIComplete string
	ExpiresIn               time.Duration
}

// issuerAnswer is what an issuer answered, when that was a JSON object.
type issuerAnswer map[string]json.RawMessage

func answerOf(body []byte) issuerAnswer {
	var object issuerAnswer
	if json.Unmarshal(body, &object) != nil {
		return nil
	}
	return object
}

// text is a member of the answer that is text, when it has one.
func (a issuerAnswer) text(name string) (string, bool) {
	var text string
	if raw, ok := a[name]; !ok || json.Unmarshal(raw, &text) != nil {
		return "", false
	}
	return text, true
}

// seconds is a span of time the answer states in seconds, when it states one
// that can be waited.
func (a issuerAnswer) seconds(name string) (time.Duration, bool) {
	var seconds float64
	if raw, ok := a[name]; !ok || json.Unmarshal(raw, &seconds) != nil || seconds < 0 || math.IsInf(seconds, 0) {
		return 0, false
	}
	return time.Duration(seconds * float64(time.Second)), true
}

// refusal is what the issuer said of a refusal: its error and description,
// or the status.
func (a issuerAnswer) refusal(status int) string {
	failure, ok := a.text("error")
	if !ok {
		return fmt.Sprintf("HTTP %d", status)
	}
	if description, ok := a.text("error_description"); ok {
		return failure + ": " + description
	}
	return failure
}

func noIssuer() *SignInError {
	return signInUnanswered(SignInErrorCodeNoIssuer, "The knowledge base trusts no external issuer")
}

// get is one JSON document read from an issuer, within the request deadline.
func (i Issuer) get(ctx context.Context, target string) (int, issuerAnswer, error) {
	asking, cancel := context.WithTimeout(ctx, i.Timing.HttpRequestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(asking, http.MethodGet, target, nil)
	if err != nil {
		return 0, nil, err
	}
	request.Header.Set("Accept", "application/json")
	return i.do(request)
}

// postForm is one form posted to an issuer: the status it answered, and its
// answer when that was a JSON object. No answer at all is an error, and so is
// one that has not come by the request's deadline.
func (i Issuer) postForm(ctx context.Context, endpoint string, form url.Values) (int, issuerAnswer, error) {
	asking, cancel := context.WithTimeout(ctx, i.Timing.HttpRequestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(asking, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return 0, nil, err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Accept", "application/json")
	return i.do(request)
}

func (i Issuer) do(request *http.Request) (int, issuerAnswer, error) {
	response, err := i.HTTP.Do(request)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()
	// Every document an issuer answers is small; a misdirected URL is not
	// read to exhaustion.
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return 0, nil, err
	}
	return response.StatusCode, answerOf(body), nil
}

// Discover asks the knowledge base at baseURL which issuer it trusts, and the
// issuer where its endpoints are.
func (i Issuer) Discover(ctx context.Context, baseURL string) (IssuerEndpoints, error) {
	// Its resource metadata is public: asked with no token, by a transport
	// that opens no stream without one.
	asking := NewHTTPTransport(HTTPTransportConfig{BaseURL: baseURL, Token: NewVariable(""), HTTP: i.HTTP, Timing: i.Timing})
	metadata, err := asking.GetProtectedResourceMetadata(ctx)
	asking.Close()
	if err != nil {
		var refused *TransportError
		if errors.As(err, &refused) {
			if status, ok := refused.Status(); ok && status == http.StatusNotFound {
				return IssuerEndpoints{}, noIssuer()
			} else if ok {
				return IssuerEndpoints{}, signInRefused(SignInErrorCodeDiscovery, "The knowledge base did not answer its resource metadata: "+refused.Message, status)
			}
		}
		return IssuerEndpoints{}, signInUnanswered(SignInErrorCodeDiscovery, "The knowledge base did not answer its resource metadata: "+err.Error())
	}
	if len(metadata.AuthorizationServers) == 0 {
		return IssuerEndpoints{}, noIssuer()
	}
	issuer := metadata.AuthorizationServers[0]
	status, document, err := i.get(ctx, strings.TrimRight(issuer, "/")+"/.well-known/openid-configuration")
	if err != nil {
		return IssuerEndpoints{}, signInUnanswered(SignInErrorCodeDiscovery, fmt.Sprintf("Issuer %s: discovery was not answered: %v", issuer, err))
	}
	if status < 200 || status > 299 {
		return IssuerEndpoints{}, signInRefused(SignInErrorCodeDiscovery, fmt.Sprintf("Issuer %s: discovery answered HTTP %d", issuer, status), status)
	}
	named, _ := document.text("issuer")
	authorization, hasAuthorization := document.text("authorization_endpoint")
	token, hasToken := document.text("token_endpoint")
	if named != issuer || !hasAuthorization || !hasToken {
		return IssuerEndpoints{}, signInRefused(SignInErrorCodeDiscovery, fmt.Sprintf("Issuer %s: its discovery document is not an OpenID configuration for it", issuer), status)
	}
	device, _ := document.text("device_authorization_endpoint")
	revocation, _ := document.text("revocation_endpoint")
	return IssuerEndpoints{Issuer: issuer, Authorization: authorization, Token: token, Device: device, Revocation: revocation}, nil
}

// Refresh is the refresh grant. An issuer that does not rotate refresh tokens
// returns none, and the one held stays current.
func (i Issuer) Refresh(ctx context.Context, tokenEndpoint, clientID, refreshToken string) (IssuedTokens, error) {
	status, answered, err := i.postForm(ctx, tokenEndpoint, url.Values{
		"grant_type": {"refresh_token"}, "refresh_token": {refreshToken}, "client_id": {clientID},
	})
	if err != nil {
		return IssuedTokens{}, signInUnanswered(SignInErrorCodeExchange, "The issuer did not answer: "+err.Error())
	}
	access, ok := answered.text("access_token")
	if status != http.StatusOK || !ok {
		return IssuedTokens{}, signInRefused(SignInErrorCodeExchange, fmt.Sprintf("The issuer refused the token request (%s)", answered.refusal(status)), status)
	}
	rotated, ok := answered.text("refresh_token")
	if !ok {
		rotated = refreshToken
	}
	return IssuedTokens{Access: access, Refresh: rotated}, nil
}

// Revoke is RFC 7009. The issuer answers 200 for a token it has already
// forgotten, so revoking twice is revoking once.
func (i Issuer) Revoke(ctx context.Context, revocationEndpoint, clientID, refreshToken string) error {
	status, _, err := i.postForm(ctx, revocationEndpoint, url.Values{
		"token": {refreshToken}, "token_type_hint": {"refresh_token"}, "client_id": {clientID},
	})
	if err != nil {
		return signInUnanswered(SignInErrorCodeExchange, "The issuer did not answer: "+err.Error())
	}
	if status != http.StatusOK {
		return signInRefused(SignInErrorCodeExchange, fmt.Sprintf("The issuer refused the revocation (HTTP %d)", status), status)
	}
	return nil
}

// RenewKept renews the sign-in kept at its issuer, and keeps what it rotated:
// the new access token; "" when no sign-in is kept, which is an absence and
// not a failure. holding is the token its holder has, which the gateway
// refused: a kept token that is not it, and has not expired, was renewed some
// other way meanwhile, and is given as it is, so no refresh token another
// program already replaced is spent. A renewal that fails says why in the
// issuer's own words, and, when the retry budget ran out, how many attempts it
// took to give up. A renewal another program made while the grant was in
// flight stands, and its access token is the one given. A sign-in signed out
// while it was being renewed stays signed out, and its new token is given to
// nobody (specs/src/sign-in-store/README.md, Renewing it).
func (i Issuer) RenewKept(ctx context.Context, kept SignInKept, holding string) (string, error) {
	held, ok, err := kept.Held(ctx)
	if err != nil || !ok {
		return "", err
	}
	if held.Access != holding && !IsTokenExpired(held.Access, time.Now()) {
		return held.Access, nil
	}
	attempts := 0
	tokens, err := RetryWithBackoff(ctx, i.Timing.RefreshRetry,
		func(ctx context.Context) (IssuedTokens, error) {
			attempts++
			return i.Refresh(ctx, held.TokenEndpoint, held.ClientID, held.Refresh)
		},
		func(err error) bool {
			var failed *SignInError
			if !errors.As(err, &failed) {
				return false
			}
			post := http.MethodPost
			facts := RetryFacts{Method: &post}
			if status, ok := failed.Status(); ok {
				facts.Status = &status
			}
			return RetryRuleRefresh.Retryable(facts)
		},
		func(error) (time.Duration, bool) { return 0, false })
	if err != nil {
		var failed *SignInError
		if attempts <= 1 || !errors.As(err, &failed) {
			return "", err
		}
		message := fmt.Sprintf("The session could not be renewed after %d attempts: %s", attempts, failed.Message)
		if status, ok := failed.Status(); ok {
			return "", signInRefused(SignInErrorCodeExchange, message, status)
		}
		return "", signInUnanswered(SignInErrorCodeExchange, message)
	}
	current, ok, err := kept.Renewed(ctx, held, tokens.Access, tokens.Refresh)
	if err != nil || !ok {
		return "", err
	}
	return current, nil
}

func codeExpired() *SignInError {
	return signInUnanswered(SignInErrorCodeExpired, "The code expired before it was approved")
}

// SignInWithDeviceGrant signs a person in from a process with no browser, at
// the issuer Discover found. The issuer mints a code, onCode shows the person
// where to approve it, and the token endpoint is asked at the issuer's
// interval until the tokens arrive. Cancelling ctx abandons the sign-in.
func (i Issuer) SignInWithDeviceGrant(ctx context.Context, issuer IssuerEndpoints, onCode func(DeviceCode)) (IssuedTokens, error) {
	if issuer.Device == "" {
		return IssuedTokens{}, signInUnanswered(SignInErrorCodeDiscovery, fmt.Sprintf(
			"Issuer %s offers no device authorization endpoint: the device grant needs one enabled for client %s", issuer.Issuer, ScriptClientID))
	}
	status, body, err := i.postForm(ctx, issuer.Device, url.Values{"client_id": {ScriptClientID}, "scope": {SignInScope}})
	if err != nil {
		return IssuedTokens{}, signInUnanswered(SignInErrorCodeExchange, "The issuer did not answer: "+err.Error())
	}
	deviceCode, hasDeviceCode := body.text("device_code")
	userCode, hasUserCode := body.text("user_code")
	verificationURI, hasVerificationURI := body.text("verification_uri")
	if status != http.StatusOK || !hasDeviceCode || !hasUserCode || !hasVerificationURI {
		return IssuedTokens{}, signInRefused(SignInErrorCodeExchange, fmt.Sprintf("The issuer refused the device authorization request (%s)", body.refusal(status)), status)
	}
	expiresIn, ok := body.seconds("expires_in")
	if !ok {
		expiresIn = deviceCodeLifetime
	}
	complete, _ := body.text("verification_uri_complete")
	onCode(DeviceCode{UserCode: userCode, VerificationURI: verificationURI, VerificationURIComplete: complete, ExpiresIn: expiresIn})

	interval, ok := body.seconds("interval")
	if !ok {
		interval = devicePoll
	}
	interval = max(interval, time.Second)
	deadline := time.Now().Add(expiresIn)
	for {
		if !pause(ctx, interval) {
			return IssuedTokens{}, ctx.Err()
		}
		if time.Now().After(deadline) {
			return IssuedTokens{}, codeExpired()
		}
		status, answered, err := i.postForm(ctx, issuer.Token, url.Values{
			"grant_type": {deviceGrant}, "device_code": {deviceCode}, "client_id": {ScriptClientID},
		})
		if err != nil {
			if ctx.Err() != nil {
				return IssuedTokens{}, ctx.Err()
			}
			return IssuedTokens{}, signInUnanswered(SignInErrorCodeExchange, "The issuer did not answer: "+err.Error())
		}
		if access, ok := answered.text("access_token"); status == http.StatusOK && ok {
			refresh, ok := answered.text("refresh_token")
			if !ok {
				return IssuedTokens{}, signInRefused(SignInErrorCodeExchange, "The issuer returned no refresh token: the session could not outlive its first access token", status)
			}
			return IssuedTokens{Access: access, Refresh: refresh}, nil
		}
		switch failure, _ := answered.text("error"); failure {
		case "authorization_pending":
		case "slow_down":
			interval += devicePoll
		case "access_denied":
			return IssuedTokens{}, signInRefused(SignInErrorCodeDenied, "The sign-in was denied at the issuer", status)
		case "expired_token":
			return IssuedTokens{}, codeExpired()
		default:
			return IssuedTokens{}, signInRefused(SignInErrorCodeExchange, fmt.Sprintf("The issuer refused the token request (%s)", answered.refusal(status)), status)
		}
	}
}
