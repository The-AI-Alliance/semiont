package semiont

// A person's sign-in by a page redirect: the authorization-code grant with
// PKCE (RFC 7636), for an application a person uses. BeginAuthorization finds
// the issuer the knowledge base trusts, remembers the pending sign-in in a
// SessionStorage, and gives the address to send the person to. The issuer
// sends them back to the redirect address with a code, and
// CompleteAuthorization exchanges it. Sending the person, and hearing them come
// back, are the host's.

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// PendingAuthorizationKey is the key a pending sign-in is remembered under.
const PendingAuthorizationKey = "semiont.pendingAuthorization"

// PendingAuthorization is what a sign-in remembers across the trip to the
// issuer and back: the verifier and the state the response must match, where
// the person was connecting, what they believed they were connecting to, and
// the issuer's endpoints, so its completion asks nothing twice.
type PendingAuthorization struct {
	State       string           `json:"state"`
	Verifier    string           `json:"verifier"`
	RedirectURI string           `json:"redirectUri"`
	Target      api.HttpEndpoint `json:"target"`
	Issuer      IssuerEndpoints  `json:"issuer"`
	// KbID is the registered knowledge base being signed in to again; "" when
	// it is none.
	KbID string `json:"kbId,omitempty"`
	// ExpectedDid and ExpectedName are what the person believed they clicked,
	// checked afterwards and never assumed; "" when they named nothing.
	ExpectedDid  string `json:"expectedDid,omitempty"`
	ExpectedName string `json:"expectedName,omitempty"`
}

// BeginAuthorizationOptions is what a sign-in by redirect begins from.
type BeginAuthorizationOptions struct {
	Target api.HttpEndpoint
	// RedirectURI is where the issuer sends the person back to. The issuer
	// accepts only an address its registration of the client lists.
	RedirectURI string
	// KbID is the registered knowledge base being signed in to again; "" when
	// it is none.
	KbID string
	// ExpectedDid and ExpectedName are what the person believed they clicked;
	// "" when they named nothing.
	ExpectedDid  string
	ExpectedName string
}

// CodeChallenge is RFC 7636 §4.2: BASE64URL(SHA-256(verifier)).
func CodeChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// randomURLSafe is bytes random bytes, as base64url.
func randomURLSafe(bytes int) string {
	buffer := make([]byte, bytes)
	// crypto/rand's Read never returns an error: it fills the buffer or ends
	// the program.
	_, _ = rand.Read(buffer)
	return base64.RawURLEncoding.EncodeToString(buffer)
}

// query is pairs as a URL's query, each value as encodeURIComponent writes it.
func query(pairs ...[2]string) string {
	written := make([]string, len(pairs))
	for i, pair := range pairs {
		written[i] = pair[0] + "=" + EncodeUriComponent(pair[1])
	}
	return strings.Join(written, "&")
}

// BeginAuthorization begins the authorization-code grant: it finds the issuer
// the target trusts, remembers the pending sign-in in pending, and gives the
// URL to send the person to.
func BeginAuthorization(ctx context.Context, issuer Issuer, options BeginAuthorizationOptions, pending SessionStorage) (string, error) {
	baseURL, err := GatewayURL(options.Target)
	if err != nil {
		return "", signInUnanswered(SignInErrorCodeDiscovery, err.Error())
	}
	endpoints, err := issuer.Discover(ctx, baseURL)
	if err != nil {
		return "", err
	}
	record := PendingAuthorization{
		State:        randomURLSafe(24),
		Verifier:     randomURLSafe(48),
		RedirectURI:  options.RedirectURI,
		Target:       options.Target,
		Issuer:       endpoints,
		KbID:         options.KbID,
		ExpectedDid:  options.ExpectedDid,
		ExpectedName: options.ExpectedName,
	}
	written, err := json.Marshal(record)
	if err != nil {
		// A record of strings, numbers and an endpoint's kinds always encodes.
		panic(err)
	}
	if err := pending.Set(PendingAuthorizationKey, string(written)); err != nil {
		return "", err
	}
	asked := query(
		[2]string{"response_type", "code"},
		[2]string{"client_id", BrowserClientID},
		[2]string{"redirect_uri", record.RedirectURI},
		[2]string{"scope", SignInScope},
		[2]string{"state", record.State},
		[2]string{"code_challenge", CodeChallenge(record.Verifier)},
		[2]string{"code_challenge_method", "S256"},
	)
	joiner := "?"
	if strings.Contains(endpoints.Authorization, "?") {
		joiner = "&"
	}
	return endpoints.Authorization + joiner + asked, nil
}

// CompleteAuthorization finishes the authorization-code grant from the URL
// the issuer sent the person back to. The pending record is taken before
// anything else happens: a code is good once, and a callback that is replayed
// finds nothing to complete.
func CompleteAuthorization(ctx context.Context, issuer Issuer, callbackURL string, pending SessionStorage) (PendingAuthorization, IssuedTokens, error) {
	var taken string
	var had bool
	if err := pending.Update(PendingAuthorizationKey, func(stored string, has bool) (string, bool) {
		taken, had = stored, has
		return "", false
	}); err != nil {
		return PendingAuthorization{}, IssuedTokens{}, err
	}
	var record PendingAuthorization
	if !had || json.Unmarshal([]byte(taken), &record) != nil {
		return PendingAuthorization{}, IssuedTokens{}, signInUnanswered(SignInErrorCodeNoPending, "No sign-in is pending here")
	}

	callback, err := url.Parse(callbackURL)
	if err == nil && !callback.IsAbs() {
		err = errors.New("relative URL without a base")
	}
	if err != nil {
		return PendingAuthorization{}, IssuedTokens{}, signInUnanswered(SignInErrorCodeExchange, "The sign-in response is not a URL: "+err.Error())
	}
	said := callback.Query()
	if said.Has("error") {
		failure := said.Get("error")
		code := SignInErrorCodeExchange
		if failure == "access_denied" {
			code = SignInErrorCodeDenied
		}
		if said.Has("error_description") {
			failure = said.Get("error_description")
		}
		return PendingAuthorization{}, IssuedTokens{}, signInUnanswered(code, failure)
	}
	if !said.Has("state") || said.Get("state") != record.State {
		return PendingAuthorization{}, IssuedTokens{}, signInUnanswered(SignInErrorCodeState, "The sign-in response does not belong to the pending sign-in")
	}
	if !said.Has("code") {
		return PendingAuthorization{}, IssuedTokens{}, signInUnanswered(SignInErrorCodeExchange, "The sign-in response carries no authorization code")
	}

	status, answered, err := issuer.postForm(ctx, record.Issuer.Token, url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {said.Get("code")},
		"redirect_uri":  {record.RedirectURI},
		"client_id":     {BrowserClientID},
		"code_verifier": {record.Verifier},
	})
	if err != nil {
		return PendingAuthorization{}, IssuedTokens{}, signInUnanswered(SignInErrorCodeExchange, "The issuer did not answer: "+err.Error())
	}
	access, ok := answered.text("access_token")
	if status != http.StatusOK || !ok {
		return PendingAuthorization{}, IssuedTokens{}, signInRefused(SignInErrorCodeExchange, fmt.Sprintf("The issuer refused the token request (%s)", answered.refusal(status)), status)
	}
	refresh, ok := answered.text("refresh_token")
	if !ok {
		return PendingAuthorization{}, IssuedTokens{}, signInUnanswered(SignInErrorCodeExchange, "The issuer returned no refresh token: the session could not outlive its first access token")
	}
	return record, IssuedTokens{Access: access, Refresh: refresh}, nil
}
