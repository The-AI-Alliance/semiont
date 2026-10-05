package launcher

// session.go — the session lifecycle around login's stored tokens: the
// invisible refresh (access tokens are short-lived; the stored refresh token
// renews them at the issuer so login is a rare event, not an hourly chore),
// the ONE renew-and-retry policy every verb's wire call runs under, and
// `semiont logout`.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

// Session is one stack's live credential: the stored tokens and the policy
// that keeps them working. Every verb's wire call — bus or REST — runs under
// Authorized, so the renewal happens in one place and no verb tells the user
// to log in again the moment a five-minute access token expires.
type Session struct {
	u     *UI
	key   string // token/stack key: "local" or "codespace:<repo>"
	entry SignIn
}

// LoadSession is the stored session for a stack key, or the refusal that says
// how to get one.
func LoadSession(u *UI, key string) (*Session, bool) {
	e, have := LoadTokens()[key]
	if !have || e.Token == "" {
		u.Fail("No session for %s.", key)
		fmt.Fprintln(os.Stderr, "  Log in first:  semiont login")
		return nil, false
	}
	return &Session{u: u, key: key, entry: e}, true
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
func (s *Session) refresh() error {
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
// unknown lifetime is not expired — the gateway's 401 remains the signal.
func (s *Session) expired() bool {
	return !s.entry.ExpiresAt.IsZero() && time.Now().After(s.entry.ExpiresAt)
}

// Authorized runs one wire call under the session's access token and keeps
// it authorized: a token the store knows is expired is renewed BEFORE the
// call, and a call the gateway answers with 401 earns one renewal and one
// retry under the renewed token. Never more than one renewal per call — a
// second rejection is the gateway refusing the account, not a race — and
// never a retry the renewal could not have helped.
//
// op receives the token to send and reports a 401 as a bus.StatusError; any
// other error comes back as it is. A rejection comes back as a
// *SessionRejected, which says whether a renewal was even possible.
func (s *Session) Authorized(op func(token string) error) error {
	attempted := false
	var refreshErr error
	if s.expired() {
		attempted, refreshErr = true, s.refresh()
	}
	err := op(s.entry.Token)
	if !unauthorized(err) {
		return err
	}
	if !attempted {
		if refreshErr = s.refresh(); refreshErr == nil {
			if err = op(s.entry.Token); !unauthorized(err) {
				return err
			}
		}
	}
	return &SessionRejected{refresh: refreshErr, cause: err}
}

// unauthorized: the gateway answered 401 to a call bearing the token.
func unauthorized(err error) bool {
	var se *bus.StatusError
	return errors.As(err, &se) && se.Status == http.StatusUnauthorized
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

// Transport is the bus transport a verb talks through: the seam's client
// under the session's renew-and-retry policy.
func (t VerbTarget) Transport() bus.Transport {
	return &sessionTransport{base: t.base, sess: t.sess}
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
	if t.sess, ok = LoadSession(u, key); !ok {
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
func Bearer(token string) semiont.RequestEditorFn {
	return func(_ context.Context, req *http.Request) error {
		req.Header.Set("Authorization", "Bearer "+token)
		return nil
	}
}
