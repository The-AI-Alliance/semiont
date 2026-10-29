package semiont

// A person's sign-in by a page redirect, against the stand-in gateway and
// issuer: the challenge, beginning a sign-in, and completing it once.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

const redirectURI = "http://127.0.0.1:9/callback"

func TestTheChallengeIsTheOneRFC7636GivesForItsVerifier(t *testing.T) {
	if got := CodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"); got != "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" {
		t.Errorf("the challenge is %s", got)
	}
}

// gatewayEndpoint is the HTTP endpoint the stand-in gateway is at.
func gatewayEndpoint(t *testing.T, s *stack) api.HttpEndpoint {
	t.Helper()
	endpoint, err := gatewayTarget(t, "kb-a", s.gateway.URL).Endpoint.AsHttpEndpoint()
	if err != nil {
		t.Fatal(err)
	}
	return endpoint
}

func pendingIn(t *testing.T, storage SessionStorage) (PendingAuthorization, bool) {
	t.Helper()
	stored, ok := storage.Get(PendingAuthorizationKey)
	if !ok {
		return PendingAuthorization{}, false
	}
	var record PendingAuthorization
	if err := json.Unmarshal([]byte(stored), &record); err != nil {
		t.Fatalf("the pending sign-in does not read: %v", err)
	}
	return record, true
}

func queryOf(t *testing.T, address string) map[string]string {
	t.Helper()
	parsed, err := url.Parse(address)
	if err != nil {
		t.Fatal(err)
	}
	asked := map[string]string{}
	for name, values := range parsed.Query() {
		asked[name] = values[0]
	}
	return asked
}

func TestBeginningASignInRemembersItAndBuildsTheURLAroundWhatItRemembered(t *testing.T) {
	s := newStack(t)
	storage := NewMemoryStorage()

	address, err := BeginAuthorization(context.Background(), issuerOf(), BeginAuthorizationOptions{
		Target:       gatewayEndpoint(t, s),
		RedirectURI:  redirectURI,
		KbID:         "kb-a",
		ExpectedDid:  "did:web:example.org:kb-a",
		ExpectedName: "KB A",
	}, storage)
	if err != nil {
		t.Fatal(err)
	}

	record, ok := pendingIn(t, storage)
	if !ok {
		t.Fatal("no sign-in is pending")
	}
	if !strings.HasPrefix(address, s.issuer.URL+"/authorize?") {
		t.Errorf("the person is sent to %s", address)
	}
	want := map[string]string{
		"response_type":         "code",
		"client_id":             "semiont-browser",
		"redirect_uri":          redirectURI,
		"scope":                 "openid email profile offline_access",
		"state":                 record.State,
		"code_challenge":        CodeChallenge(record.Verifier),
		"code_challenge_method": "S256",
	}
	if got := queryOf(t, address); !reflect.DeepEqual(got, want) {
		t.Errorf("the address asks %v", got)
	}
	if record.Target != gatewayEndpoint(t, s) || record.Issuer.Token != s.issuer.URL+"/token" || record.KbID != "kb-a" || record.ExpectedName != "KB A" {
		t.Errorf("the pending sign-in is %+v", record)
	}
	// Neither is guessable, and neither is the other.
	if len(record.Verifier) < 43 || len(record.State) < 32 || record.Verifier == record.State {
		t.Errorf("the verifier %q and the state %q", record.Verifier, record.State)
	}
}

// begun is a sign-in begun at the stand-in, as its storage remembers it.
func begun(t *testing.T, s *stack, storage SessionStorage) PendingAuthorization {
	t.Helper()
	if _, err := BeginAuthorization(context.Background(), issuerOf(), BeginAuthorizationOptions{Target: gatewayEndpoint(t, s), RedirectURI: redirectURI}, storage); err != nil {
		t.Fatal(err)
	}
	record, ok := pendingIn(t, storage)
	if !ok {
		t.Fatal("no sign-in is pending")
	}
	return record
}

// granting has the issuer's token endpoint grant tokens, and keeps every form
// it was sent.
func granting(s *stack, access, refresh string) func() []url.Values {
	var mu sync.Mutex
	var forms []url.Values
	s.set(func() {
		s.token = func(w http.ResponseWriter, r *http.Request) {
			if err := r.ParseForm(); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			mu.Lock()
			forms = append(forms, r.PostForm)
			mu.Unlock()
			writeJSON(w, http.StatusOK, map[string]any{"access_token": access, "refresh_token": refresh, "token_type": "Bearer", "expires_in": 3600})
		}
	})
	return func() []url.Values {
		mu.Lock()
		defer mu.Unlock()
		return append([]url.Values(nil), forms...)
	}
}

func TestCompletingASignInExchangesTheCodeWithItsVerifierOnce(t *testing.T) {
	s := newStack(t)
	storage := NewMemoryStorage()
	record := begun(t, s, storage)
	forms := granting(s, "an-access-token", "a-refresh-token")
	callback := redirectURI + "?state=" + record.State + "&code=the-code"

	completed, tokens, err := CompleteAuthorization(context.Background(), issuerOf(), callback, storage)
	if err != nil {
		t.Fatal(err)
	}

	if completed != record || tokens != (IssuedTokens{Access: "an-access-token", Refresh: "a-refresh-token"}) {
		t.Errorf("completed %+v with %+v", completed, tokens)
	}
	want := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {"the-code"},
		"redirect_uri":  {redirectURI},
		"client_id":     {"semiont-browser"},
		"code_verifier": {record.Verifier},
	}
	if got := forms(); len(got) != 1 || !reflect.DeepEqual(got[0], want) {
		t.Errorf("the token endpoint was sent %v", got)
	}
	// The pending record is gone: the same callback again completes nothing.
	if _, ok := storage.Get(PendingAuthorizationKey); ok {
		t.Error("the sign-in is still pending")
	}
	_, _, err = CompleteAuthorization(context.Background(), issuerOf(), callback, storage)
	var refused *SignInError
	if !errors.As(err, &refused) || refused.Code != SignInErrorCodeNoPending {
		t.Errorf("a callback replayed: %v", err)
	}
	if got := forms(); len(got) != 1 {
		t.Errorf("the token endpoint was asked %d times", len(got))
	}
}

func TestAResponseThatIsNotThePendingSignInsIsRefusedAndNothingIsExchanged(t *testing.T) {
	s := newStack(t)
	storage := NewMemoryStorage()
	forms := granting(s, "an-access-token", "a-refresh-token")
	for response, want := range map[string]SignInErrorCode{
		"state=another&code=the-code":                              SignInErrorCodeState,
		"error=access_denied&error_description=The+person+said+no": SignInErrorCodeDenied,
		"error=server_error":                                       SignInErrorCodeExchange,
	} {
		begun(t, s, storage)
		_, _, err := CompleteAuthorization(context.Background(), issuerOf(), redirectURI+"?"+response, storage)
		var refused *SignInError
		if !errors.As(err, &refused) || refused.Code != want {
			t.Errorf("%s: %v", response, err)
		}
		if _, answered := refused.Status(); answered {
			t.Errorf("%s: refused with a status, as though the issuer answered", response)
		}
	}
	if got := forms(); len(got) != 0 {
		t.Errorf("the token endpoint was asked %d times", len(got))
	}
}

func TestADeniedSignInSaysWhatTheIssuerSaid(t *testing.T) {
	s := newStack(t)
	storage := NewMemoryStorage()
	begun(t, s, storage)
	_, _, err := CompleteAuthorization(context.Background(), issuerOf(), redirectURI+"?error=access_denied&error_description=The+person+said+no", storage)
	if err == nil || err.Error() != "The person said no" {
		t.Errorf("a denial says %v", err)
	}
}

func TestATokenEndpointThatIssuesNoRefreshTokenIsRefused(t *testing.T) {
	s := newStack(t)
	storage := NewMemoryStorage()
	record := begun(t, s, storage)
	s.set(func() {
		s.token = func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, http.StatusOK, map[string]any{"access_token": "an-access-token", "token_type": "Bearer", "expires_in": 3600})
		}
	})
	_, _, err := CompleteAuthorization(context.Background(), issuerOf(), redirectURI+"?state="+record.State+"&code=the-code", storage)
	var refused *SignInError
	if !errors.As(err, &refused) || refused.Code != SignInErrorCodeExchange {
		t.Errorf("a grant with no refresh token: %v", err)
	}
}
