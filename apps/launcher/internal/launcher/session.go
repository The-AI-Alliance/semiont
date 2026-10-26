package launcher

// session.go — the session lifecycle around login's stored tokens: the
// invisible refresh (access tokens are short-lived; the stored refresh token
// renews them at the issuer so login is a rare event, not an hourly chore),
// the renewal a verb's bus transport asks for when the gateway refuses its
// token, the renew-and-retry policy a call of the gateway's HTTP API runs
// under, and `semiont logout`.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sync"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

// Session is one stack's live credential: the stored tokens and the policy
// that keeps them working. A verb's bus transport asks it for a renewed token
// when the gateway refuses one (Refresh), and a call of the HTTP API runs
// under Authorized, so the renewal happens in one place and no verb tells the
// user to log in again the moment a five-minute access token expires.
type Session struct {
	u    *UI
	key  string // token/stack key: "local" or "codespace:<repo>"
	base string // the stack's gateway base URL, which the tokens are for

	// renewal guards everything below it: refusals that arrive together, from
	// the stream and from a request at once, are answered by one renewal.
	renewal sync.Mutex
	entry   SignIn
	// token is the access token the session's transport carries, as the
	// session renews it.
	token *semiont.Watched[string]
	// issued is the token this command's last renewal was issued, which the
	// gateway did not refuse when it was asked who it is.
	issued string
	// failed is why this command's renewal failed. A refresh token the issuer
	// refused is not sent again: the failure answers every later refusal.
	failed error

	// ended is done once the gateway has refused the session's token for good,
	// with a *SessionRejected as its cause. A session that has ended asks
	// nobody anything more.
	ended context.Context
	stop  context.CancelCauseFunc
}

// LoadSession is the stored session for a stack key, its tokens for the
// gateway at base, or the refusal that says how to get one.
func LoadSession(u *UI, key, base string) (*Session, bool) {
	e, have := LoadTokens()[key]
	if !have || e.Token == "" {
		u.Fail("No session for %s.", key)
		fmt.Fprintln(os.Stderr, "  Log in first:  semiont login")
		return nil, false
	}
	return newSession(u, key, base, e), true
}

func newSession(u *UI, key, base string, entry SignIn) *Session {
	ended, stop := context.WithCancelCause(context.Background())
	return &Session{
		u: u, key: key, base: base, entry: entry,
		token: semiont.NewWatched(entry.Token),
		ended: ended, stop: stop,
	}
}

// end ends the session, for the reason rejected gives, unless it has already
// ended: the first reason stands. Its transport is left no token to offer, so
// it sends nothing more. The caller holds s.renewal.
func (s *Session) end(rejected *SessionRejected) {
	if s.ended.Err() != nil {
		return
	}
	s.stop(rejected)
	s.token.Set("")
}

// errNoRefreshToken: the stored session cannot be renewed — it carries no
// refresh token, or no token endpoint to send one to.
var errNoRefreshToken = errors.New("no refresh token is stored to renew it")

// errSignedOut: the stack was signed out while its session was being renewed.
// A session that is over is not handed a credential again.
var errSignedOut = errors.New("the stack was signed out while its session was being renewed")

// sameTokens: two sign-ins hold the same pair of tokens.
func sameTokens(a, b SignIn) bool {
	return a.Token == b.Token && a.RefreshToken == b.RefreshToken
}

// refresh trades the stored refresh token for a fresh access token at the
// issuer and SAVES the rotation — the next command must start from the new
// tokens, the refresh token included if the issuer rotated it.
//
// Another program renews the same sign-in (an application on the Rust SDK),
// so the store is read again on both sides of the grant. Before it: tokens
// another program has since replaced are taken as they are, and the refresh
// token this command read is not spent, since an issuer that rotates would
// refuse it. After it, under the store's lock: tokens another program wrote
// while the grant was in flight stand, and a stack signed out meanwhile stays
// signed out.
//
// Whatever token it leaves the session holding is the token the session's
// transport carries from then on. The caller holds s.renewal.
func (s *Session) refresh() error {
	defer func() { s.token.Set(s.entry.Token) }()
	had := s.entry
	if stored, have := LoadTokens()[s.key]; have && !sameTokens(stored, had) {
		s.entry, had = stored, stored
		if !s.expired() {
			s.u.Note("Session renewed by another program %s", s.u.Dim("(its tokens are used as they are)"))
			return nil
		}
	}
	if had.RefreshToken == "" || had.TokenEndpoint == "" {
		return errNoRefreshToken
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	tr, err := refreshTokens(ctx, had.TokenEndpoint, had.RefreshToken)
	if err != nil {
		return err
	}
	renewed := had
	renewed.Token = tr.AccessToken
	if tr.RefreshToken != "" {
		renewed.RefreshToken = tr.RefreshToken
	}
	renewed.ObtainedAt = time.Now().UTC()
	renewed.ExpiresAt = expiresAt(renewed.ObtainedAt, tr.ExpiresIn)

	var theirs *SignIn
	signedOut := false
	err = changeSignIns(func(doc map[string]json.RawMessage) (bool, error) {
		stored, have := signInOf(doc[s.key])
		switch {
		case !have:
			signedOut = true
			return false, nil
		case !sameTokens(stored, had):
			theirs = &stored
			return false, nil
		}
		return true, putSignIn(doc, s.key, renewed)
	})
	// Narrated on stderr, never stdout: a verb's `--json` reply piped to jq
	// must stay one JSON document.
	switch {
	case err != nil:
		s.entry = renewed
		s.u.Note("Refreshed token could not be stored (%v) — it will work for this command only.", err)
	case signedOut:
		return errSignedOut
	case theirs != nil:
		s.entry = *theirs
		s.u.Note("Session renewed by another program %s", s.u.Dim("(its tokens stand; the ones this command was issued are dropped)"))
	default:
		s.entry = renewed
		s.u.Note("Session refreshed %s", s.u.Dim("(access token renewed at the issuer from the stored refresh token)"))
	}
	return nil
}

// expiresAt turns the issuer's expires_in into a wall-clock deadline; zero
// when the issuer named none.
func expiresAt(from time.Time, expiresIn int) time.Time {
	if expiresIn <= 0 {
		return time.Time{}
	}
	return from.Add(time.Duration(expiresIn) * time.Second)
}

// expired: the store already knows the access token is past its lifetime. An
// unknown lifetime is not expired — the gateway's 401 remains the signal. The
// caller holds s.renewal.
func (s *Session) expired() bool {
	return !s.entry.ExpiresAt.IsZero() && time.Now().After(s.entry.ExpiresAt)
}

// Refresh is a renewed token for a transport the gateway refused the
// session's token to (semiont.TokenRefresher): the transport asks once for a
// refused request, and once per outage of its stream, and sends again with
// what it is given. The rule is the other SDKs' sessions': a refusal costs at
// most one renewal and one question to the gateway.
//
// Refusals that arrive together wait for one renewal. When the session holds
// the token this command was issued, the gateway is asked about it first:
// still accepted, the refusal was of an older token, and this one is the
// answer, with nothing sent to the issuer. ok=false: the session has ended,
// and its end's cause says why.
func (s *Session) Refresh(ctx context.Context) (token string, ok bool) {
	s.renewal.Lock()
	defer s.renewal.Unlock()
	if s.ended.Err() != nil {
		return "", false
	}
	if s.issued != "" && s.entry.Token == s.issued && !s.refuses(ctx, s.issued) {
		return s.issued, true
	}
	if rejected := s.renew(ctx); rejected != nil {
		s.end(rejected)
		return "", false
	}
	return s.entry.Token, true
}

// renew trades the stored refresh token for a new access token and asks the
// gateway who the new one is. A rejection says why the session cannot go on:
// the refresh failed, now or earlier in this command, or the gateway refused a
// token its issuer had just issued (refresh nil). The caller holds s.renewal.
func (s *Session) renew(ctx context.Context) *SessionRejected {
	if s.failed == nil {
		s.failed = s.refresh()
	}
	if s.failed != nil {
		return &SessionRejected{refresh: s.failed}
	}
	if s.refuses(ctx, s.entry.Token) {
		return &SessionRejected{}
	}
	s.issued = s.entry.Token
	return nil
}

// refuses reports whether the gateway refuses token, asked who the token is.
// A gateway that cannot be asked refuses nothing: the token stands, and the
// next request is the judge.
func (s *Session) refuses(ctx context.Context, token string) bool {
	cli, err := api.NewClientWithResponses(s.base)
	if err != nil {
		return false
	}
	asking, cancel := context.WithTimeout(ctx, semiont.DefaultTiming().HttpRequestTimeout)
	defer cancel()
	me, err := cli.GetCurrentUserWithResponse(asking, Bearer(token))
	return err == nil && semiont.TransportErrorCodeOfStatus(me.StatusCode()) == semiont.TransportErrorCodeUnauthorized
}

// Authorized runs one call of the gateway's HTTP API under the session's
// access token and keeps it authorized: a token the store knows is expired is
// renewed BEFORE the call, and a call the gateway answers with 401 earns one
// renewal and one retry under the renewed token. Never more than one renewal
// per call — a second rejection is the gateway refusing the account, not a
// race — and never a retry the renewal could not have helped.
//
// op receives the token to send and reports a 401 as a *semiont.TransportError
// coded unauthorized; any other error comes back as it is. A rejection comes
// back as a *SessionRejected, which says whether a renewal was even possible.
func (s *Session) Authorized(op func(token string) error) error {
	attempted := false
	var refreshErr error
	s.renewal.Lock()
	if s.expired() {
		attempted, refreshErr = true, s.refresh()
	}
	token := s.entry.Token
	s.renewal.Unlock()
	err := op(token)
	if !unauthorized(err) {
		return err
	}
	if !attempted {
		s.renewal.Lock()
		refreshErr = s.refresh()
		token = s.entry.Token
		s.renewal.Unlock()
		if refreshErr == nil {
			if err = op(token); !unauthorized(err) {
				return err
			}
		}
	}
	return &SessionRejected{refresh: refreshErr, cause: err}
}

// unauthorized: the gateway refused the token a call bore.
func unauthorized(err error) bool {
	var refused *semiont.TransportError
	return errors.As(err, &refused) && refused.Code == semiont.TransportErrorCodeUnauthorized
}

// SessionRejected: the gateway refused the token and the renewal could not
// put that right. "Log in again" is the fix either way, but the words differ:
// a renewal that SUCCEEDED and was still refused points at the gateway (the
// account, not the session), and saying "could not renew" there would
// contradict the refresh line just printed.
type SessionRejected struct {
	refresh error // why the renewal failed; nil when it succeeded and the renewed token was refused too
	cause   error // the gateway's rejection
}

func (r *SessionRejected) Error() string {
	switch {
	case r.refresh == nil:
		return "the session was rejected even after a successful refresh — the gateway no longer accepts this account's tokens"
	case errors.Is(r.refresh, errNoRefreshToken):
		return "the session was rejected, and " + r.refresh.Error()
	default:
		return "the session was rejected and the refresh token could not renew it (" + r.refresh.Error() + ")"
	}
}

func (r *SessionRejected) Unwrap() error { return r.cause }

// RejectedFail prints a rejected session in the launcher's voice with the one
// fix that applies — the same line for every verb, whatever wire it spoke.
func RejectedFail(u *UI, verb string, rej *SessionRejected) int {
	u.Fail("%s: %v.", verb, rej)
	fmt.Fprintln(os.Stderr, "  Log in again:  semiont login")
	return 1
}

// VerbTarget is what every knowledge verb needs: which stack, its gateway
// base URL, and a session that keeps itself authorized.
type VerbTarget struct {
	base string // gateway base URL (local record, or a codespace's forward)
	sess *Session
}

// Bus opens the stack's bus for one command: a transport carrying the
// session's token, renewed by the session when the gateway refuses it. Its
// stream carries every operation's reply channels and, besides, channels: the
// broadcasts a verb follows. Close it when the command is done.
func (t VerbTarget) Bus(channels ...bus.Channel) *VerbBus {
	return t.sess.bus(channels)
}

// API is the gateway's HTTP API, for a verb that reads what the bus does not
// carry. Each call of it runs under Authorized.
func (t VerbTarget) API() (*api.ClientWithResponses, error) {
	return api.NewClientWithResponses(t.base)
}

// Authorized runs op, one call of the gateway's HTTP API, under the session's
// renew-and-retry policy.
func (t VerbTarget) Authorized(op func(token string) error) error {
	return t.sess.Authorized(op)
}

// VerbSession resolves a verb's target in one place, because nine verbs asking
// the same questions nine different ways is how they drift. Refusals are
// printed here with their fix-it lines; ok=false means stop.
func VerbSession(u *UI, verb, repo string, wantLocal bool) (VerbTarget, bool) {
	ss := LoadStackSet()
	target, ok := SelectVerbStack(u, verb, ss, repo, wantLocal)
	if !ok {
		return VerbTarget{}, false
	}
	var t VerbTarget
	key := ""
	if target != nil {
		if t.base, ok = ForwardedBase(u, target, verb); !ok {
			return VerbTarget{}, false
		}
		key = "codespace:" + target.Codespace.Repo
	} else {
		local := ss.Stacks["local"]
		if local == nil {
			u.Fail("%s needs a running stack, and none is recorded.", verb)
			fmt.Fprintln(os.Stderr, "  Start one first:  semiont start")
			return VerbTarget{}, false
		}
		t.base = GatewayBase(local)
		key = "local"
	}
	if t.sess, ok = LoadSession(u, key, t.base); !ok {
		return VerbTarget{}, false
	}
	return t, true
}

const logoutUsage = `Usage: semiont logout [--repo <owner/name> | --runtime <rt>]

End the stack's stored session: the refresh token is revoked at the issuer
(best-effort), then the local token is forgotten either way.

Options:
  --repo <owner/name>  Target a codespace stack (default: the local stack)
  --runtime <rt>       Target the local stack explicitly
  --help               Show this help
`

func Logout(args []string) int {
	u := NewUI(false)
	repo, wantLocal := "", false
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--repo":
			if i+1 >= len(args) {
				u.Fail("Missing value for --repo")
				return 1
			}
			repo = args[i+1]
			i++
		case "--runtime":
			if i+1 >= len(args) {
				u.Fail("Missing value for --runtime")
				return 1
			}
			wantLocal = true
			i++
		case "--help", "-h":
			fmt.Print(logoutUsage)
			return 0
		default:
			u.Fail("Unknown argument: %s", args[i])
			return 1
		}
	}

	ss := LoadStackSet()
	target, ok := SelectVerbStack(u, "logout", ss, repo, wantLocal)
	if !ok {
		return 1
	}
	key := "local"
	if target != nil {
		key = "codespace:" + target.Codespace.Repo
	}

	e, have := LoadTokens()[key]
	if !have {
		u.Log("No session for %s — nothing to log out.", key)
		return 0
	}
	// Issuer-side first, best-effort: an unreachable issuer must not trap the
	// user in a session they asked to end — but say what it means.
	revoked := false
	if e.RevocationEndpoint != "" && e.RefreshToken != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		revoked = revokeToken(ctx, e.RevocationEndpoint, e.RefreshToken) == nil
	}
	if err := deleteToken(key); err != nil {
		u.Fail("Could not remove the stored session: %v", err)
		return 1
	}
	if revoked {
		u.Ok("Logged out of %s (%s) — session revoked at the issuer, local token forgotten.", key, e.Email)
	} else {
		u.Ok("Logged out of %s (%s) — local token forgotten.", key, e.Email)
		u.Warn("Revocation at the issuer did not complete; the refresh token remains valid there until it expires.")
	}
	return 0
}

// Bearer is the RequestEditorFn stamping the session's Authorization header.
func Bearer(token string) api.RequestEditorFn {
	return func(_ context.Context, req *http.Request) error {
		req.Header.Set("Authorization", "Bearer "+token)
		return nil
	}
}
