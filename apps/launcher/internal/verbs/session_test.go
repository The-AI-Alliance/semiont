package verbs

// The invisible session refresh, as EVERY verb gets it.
//
// `semiont login` stores a short-lived access token and the refresh token that
// renews it. A verb whose request the gateway answers with 401 must renew the
// session at the issuer, retry ONCE under the renewed token, and save the
// rotation — and must send the user back to `semiont login` only when that
// renewal itself fails. Observed before this existed: a five-minute access
// token, and a `browse` at minute six printed "the session was rejected" with
// no refresh attempted; only `yield --upload` carried the retry.
//
// In process, through the transport seam: the fakes are keyed by TOKEN, so
// which token reached the wire, and in what order, is the assertion. The
// issuer is the one real HTTP server here — the refresh grant is plain HTTP
// the launcher speaks itself, so it is exercised for real.
//
// Failure messages name counts and positions, never a token's value: even a
// stub's token stays out of test output on principle.

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/harness"
	launcher "github.com/The-AI-Alliance/semiont/apps/launcher/internal/launcher"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bustest"
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

// renewed is the issuer's answer to a refresh grant it honours: a new access
// token and a ROTATED refresh token, which the launcher must keep.
const renewed = `{"access_token":"token-2","refresh_token":"refresh-2","token_type":"Bearer","expires_in":300}`

// storeSession replaces the fixture's bare token with a renewable session:
// access token token-1, refresh token refresh-1, the stub as its issuer.
func storeSession(t *testing.T, issuer *issuerStub, expiresAt time.Time) {
	t.Helper()
	if err := launcher.SaveToken("local", launcher.TokenEntry{
		Token: "token-1", RefreshToken: "refresh-1", Email: "t@example.com",
		Issuer: issuer.URL, TokenEndpoint: issuer.URL + "/token", ExpiresAt: expiresAt,
	}); err != nil {
		t.Fatal(err)
	}
}

// transportsByToken hands each token its own fake and records the order in
// which the verb asked for transports. A token no fake was scripted for is a
// test failure, not a silent fallback — the fakes ARE the expectation.
func transportsByToken(t *testing.T, fakes map[string]*bustest.Fake) (built *[]string, restore func()) {
	t.Helper()
	var order []string
	restore = launcher.UseTransport(func(base, token string) bus.Transport {
		order = append(order, token)
		f, ok := fakes[token]
		if !ok {
			t.Errorf("transport #%d was built for a token no fake was scripted for", len(order))
			f = rejecting()
		}
		f.Base, f.Token = base, token
		return f
	})
	return &order, restore
}

// rejecting is a gateway that answers every call with 401.
func rejecting() *bustest.Fake {
	f := bustest.NewFake()
	unauthorized := &bus.StatusError{Op: "subscribe", Status: http.StatusUnauthorized}
	f.RequestErr, f.EmitErr = unauthorized, unauthorized
	return f
}

// answering is a gateway that accepts the token: it answers `browse` and
// counts one subscriber for a signal.
func answering() *bustest.Fake {
	f := bustest.NewFake()
	f.Subscribers = 1
	f.Replies["browse:resources-requested"] = reply(`{"resources":[],"total":0}`)
	return f
}

// wantOrder checks which token each transport was built for, by position.
func wantOrder(t *testing.T, built *[]string, want ...string) {
	t.Helper()
	got := *built
	if len(got) != len(want) {
		t.Errorf("want %d transport(s) built, got %d", len(want), len(got))
		return
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("transport #%d was built for the wrong token", i+1)
		}
	}
}

func TestBusVerbRenewsARejectedSessionAndRetriesOnce(t *testing.T) {
	verbFixture(t)
	issuer := newIssuerStub(t, http.StatusOK, renewed)
	storeSession(t, issuer, time.Time{})
	stale, fresh := rejecting(), answering()
	built, restore := transportsByToken(t, map[string]*bustest.Fake{"token-1": stale, "token-2": fresh})
	defer restore()

	stdout, stderr := harness.CaptureOutput(t, func() {
		if code := Browse([]string{"--json"}); code != 0 {
			t.Errorf("browse: exit %d — a session the issuer can renew must not fail", code)
		}
	})

	// One request under the rejected token, one under the renewed one — and
	// the renewed one SECOND.
	if len(stale.Requests) != 1 || len(fresh.Requests) != 1 {
		t.Errorf("want one request per token (rejected, then retried), got %d then %d", len(stale.Requests), len(fresh.Requests))
	}
	wantOrder(t, built, "token-1", "token-2")

	// Exactly one refresh grant: the public client's, with the stored refresh token.
	grants := issuer.refreshGrants()
	if len(grants) != 1 {
		t.Fatalf("want exactly one refresh grant at the issuer, got %d", len(grants))
	}
	if g := grants[0]; g.Get("grant_type") != "refresh_token" || g.Get("client_id") != launcher.CliClientID || g.Get("refresh_token") != "refresh-1" {
		t.Errorf("the grant was not the public client's refresh_token grant carrying the stored refresh token")
	}

	// The rotation is SAVED: the next command starts from the renewed pair,
	// and knows when the renewed access token expires.
	e := launcher.LoadTokens()["local"]
	if e.Token != "token-2" || e.RefreshToken != "refresh-2" {
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

// The same policy for a fire-and-forget verb: an Emit is refused the way a
// Request is, and renewed the same way.
func TestEmitVerbRenewsARejectedSessionToo(t *testing.T) {
	verbFixture(t)
	issuer := newIssuerStub(t, http.StatusOK, renewed)
	storeSession(t, issuer, time.Time{})
	stale, fresh := rejecting(), answering()
	built, restore := transportsByToken(t, map[string]*bustest.Fake{"token-1": stale, "token-2": fresh})
	defer restore()

	harness.CaptureOutput(t, func() {
		if code := Beckon([]string{"--resource", "res-1", "--annotation", "ann-2"}); code != 0 {
			t.Errorf("beckon: exit %d — a session the issuer can renew must not fail", code)
		}
	})
	if len(stale.Emits) != 1 || len(fresh.Emits) != 1 {
		t.Errorf("want one emit per token (rejected, then retried), got %d then %d", len(stale.Emits), len(fresh.Emits))
	}
	wantOrder(t, built, "token-1", "token-2")
	if n := len(issuer.refreshGrants()); n != 1 {
		t.Errorf("want exactly one refresh grant, got %d", n)
	}
}

func TestBusVerbReportsRejectionWhenTheRefreshFails(t *testing.T) {
	verbFixture(t)
	issuer := newIssuerStub(t, http.StatusBadRequest, `{"error":"invalid_grant","error_description":"Token is not active"}`)
	storeSession(t, issuer, time.Time{})
	stale := rejecting()
	built, restore := transportsByToken(t, map[string]*bustest.Fake{"token-1": stale})
	defer restore()

	_, stderr := harness.CaptureOutput(t, func() {
		if code := Browse(nil); code == 0 {
			t.Errorf("browse must fail when the session is rejected and the issuer will not renew it")
		}
	})
	// The refusal names the verb, the rejection, WHY the renewal failed, and
	// the one fix that applies.
	harness.MustContainAll(t, "stderr", stderr, "browse", "session was rejected", "could not renew", "invalid_grant", "semiont login")
	// A renewal that failed earns no retry, and no second grant.
	if len(stale.Requests) != 1 {
		t.Errorf("want exactly one request (no retry without a renewed token), got %d", len(stale.Requests))
	}
	wantOrder(t, built, "token-1")
	if n := len(issuer.refreshGrants()); n != 1 {
		t.Errorf("want exactly one refresh grant, got %d", n)
	}
	// The stored session is untouched: nothing was renewed, so nothing rotates.
	if e := launcher.LoadTokens()["local"]; e.Token != "token-1" || e.RefreshToken != "refresh-1" {
		t.Errorf("a failed renewal must leave tokens.json as it was")
	}
}

func TestBusVerbRefusedAfterASuccessfulRefreshSaysSo(t *testing.T) {
	verbFixture(t)
	issuer := newIssuerStub(t, http.StatusOK, renewed)
	storeSession(t, issuer, time.Time{})
	stale, fresh := rejecting(), rejecting()
	built, restore := transportsByToken(t, map[string]*bustest.Fake{"token-1": stale, "token-2": fresh})
	defer restore()

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
	// One renewal, one retry. A second rejection is not an invitation to loop.
	wantOrder(t, built, "token-1", "token-2")
	if len(fresh.Requests) != 1 {
		t.Errorf("want exactly one retry, got %d", len(fresh.Requests))
	}
	if n := len(issuer.refreshGrants()); n != 1 {
		t.Errorf("want exactly one refresh grant, got %d", n)
	}
}

// A session with nothing to renew from — the fixture's bare access token — is
// refused plainly, without a grant nobody could send.
func TestBusVerbWithNoRefreshTokenReportsRejection(t *testing.T) {
	verbFixture(t)
	stale := rejecting()
	built, restore := transportsByToken(t, map[string]*bustest.Fake{"test-token": stale})
	defer restore()

	_, stderr := harness.CaptureOutput(t, func() {
		if code := Browse(nil); code == 0 {
			t.Errorf("browse must fail when the session is rejected and there is no refresh token")
		}
	})
	harness.MustContainAll(t, "stderr", stderr, "session was rejected", "semiont login")
	wantOrder(t, built, "test-token")
	if len(stale.Requests) != 1 {
		t.Errorf("want exactly one request, got %d", len(stale.Requests))
	}
}

// PROACTIVE: a token the store already knows is expired is renewed before the
// first request, so the verb never spends a round-trip to be told 401.
func TestExpiredSessionIsRenewedBeforeTheFirstRequest(t *testing.T) {
	verbFixture(t)
	issuer := newIssuerStub(t, http.StatusOK, renewed)
	storeSession(t, issuer, time.Now().Add(-time.Minute))
	stale, fresh := rejecting(), answering()
	built, restore := transportsByToken(t, map[string]*bustest.Fake{"token-1": stale, "token-2": fresh})
	defer restore()

	harness.CaptureOutput(t, func() {
		if code := Browse(nil); code != 0 {
			t.Errorf("browse: exit %d", code)
		}
	})
	if len(stale.Requests) != 0 {
		t.Errorf("an access token known to be expired still reached the wire (%d request(s))", len(stale.Requests))
	}
	wantOrder(t, built, "token-2")
	if len(fresh.Requests) != 1 {
		t.Errorf("want exactly one request under the renewed token, got %d", len(fresh.Requests))
	}
	if n := len(issuer.refreshGrants()); n != 1 {
		t.Errorf("want exactly one refresh grant, got %d", n)
	}
}

// …and one that is NOT yet expired is sent as it is. Renewing on every call
// would make the refresh token the access token.
func TestALiveSessionIsSentWithoutRenewal(t *testing.T) {
	verbFixture(t)
	issuer := newIssuerStub(t, http.StatusOK, renewed)
	storeSession(t, issuer, time.Now().Add(time.Hour))
	live := answering()
	built, restore := transportsByToken(t, map[string]*bustest.Fake{"token-1": live})
	defer restore()

	harness.CaptureOutput(t, func() {
		if code := Browse(nil); code != 0 {
			t.Errorf("browse: exit %d", code)
		}
	})
	wantOrder(t, built, "token-1")
	if n := len(issuer.refreshGrants()); n != 0 {
		t.Errorf("a live session was renewed unasked (%d grant(s))", n)
	}
}

// When the proactive renewal fails (issuer down, refresh token expired), the
// stored token is still TRIED — clocks skew, and the gateway is the judge — and
// a 401 then is reported without a second grant.
func TestExpiredSessionWhoseRenewalFailsIsStillTriedOnce(t *testing.T) {
	verbFixture(t)
	issuer := newIssuerStub(t, http.StatusBadRequest, `{"error":"invalid_grant"}`)
	storeSession(t, issuer, time.Now().Add(-time.Minute))
	stale := rejecting()
	built, restore := transportsByToken(t, map[string]*bustest.Fake{"token-1": stale})
	defer restore()

	_, stderr := harness.CaptureOutput(t, func() {
		if code := Browse(nil); code == 0 {
			t.Errorf("browse must fail when neither the stored nor a renewed token works")
		}
	})
	harness.MustContainAll(t, "stderr", stderr, "session was rejected", "could not renew", "semiont login")
	wantOrder(t, built, "token-1")
	if len(stale.Requests) != 1 {
		t.Errorf("want the stored token tried exactly once, got %d request(s)", len(stale.Requests))
	}
	if n := len(issuer.refreshGrants()); n != 1 {
		t.Errorf("want exactly one refresh grant (not one per attempt), got %d", n)
	}
}
