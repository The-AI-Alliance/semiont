package launcher

// session.go — the session lifecycle around login's stored tokens: the
// invisible refresh (access tokens are short-lived; the stored refresh token
// renews them at the issuer so login is a rare event, not an hourly chore),
// the ONE renew-and-retry policy every verb's wire call runs under, and
// `semiont logout`.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

// session is one stack's live credential: the stored tokens and the policy
// that keeps them working. Every verb's wire call — bus or REST — runs under
// authorized, so the renewal happens in one place. Before it did, only
// `yield --upload` carried the retry, and every bus verb told the user to log
// in again the moment a five-minute access token expired.
type Session struct {
	u     *UI
	key   string // token/stack key: "local" or "codespace:<repo>"
	entry TokenEntry
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

// refresh trades the stored refresh token for a fresh access token at the
// issuer and SAVES the rotation — the next command must start from the new
// tokens, the refresh token included if the issuer rotated it.
func (s *Session) refresh() error {
	e := s.entry
	if e.RefreshToken == "" || e.TokenEndpoint == "" {
		return errNoRefreshToken
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	tr, err := refreshTokens(ctx, e.TokenEndpoint, e.RefreshToken)
	if err != nil {
		return err
	}
	e.Token = tr.AccessToken
	if tr.RefreshToken != "" {
		e.RefreshToken = tr.RefreshToken
	}
	e.ObtainedAt = time.Now().UTC()
	e.ExpiresAt = expiresAt(e.ObtainedAt, tr.ExpiresIn)
	s.entry = e
	// Narrated on stderr, never stdout: a verb's `--json` reply piped to jq
	// must stay one JSON document.
	if err := SaveToken(s.key, e); err != nil {
		s.u.Note("Refreshed token could not be stored (%v) — it will work for this command only.", err)
	} else {
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

// authorized runs one wire call under the session's access token and keeps
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
// base URL, the KB root, and a session that keeps itself authorized. One
// place, because nine verbs asking the same questions nine different ways is
// how they drift. Refusals are printed here with their fix-it lines; ok=false
// means stop.
type VerbTarget struct {
	base string // gateway base URL (local record, or a codespace's forward)
	root string // KB root, "" for a codespace target with no local clone
	sess *Session
}

// transport is the bus transport a verb talks through: the seam's client
// under the session's renew-and-retry policy.
func (t VerbTarget) Transport() bus.Transport {
	return &sessionTransport{base: t.base, sess: t.sess}
}

func VerbSession(u *UI, verb, repo string, wantLocal bool) (VerbTarget, bool) {
	ss := LoadStackSet()
	target, ok := SelectVerbStack(u, verb, ss, repo, wantLocal)
	if !ok {
		return VerbTarget{}, false
	}
	var t VerbTarget
	key := ""
	if target != nil {
		t.base = fmt.Sprintf("http://localhost:%d", target.Codespace.ForwardPort)
		key = "codespace:" + target.Codespace.Repo
		t.root = CwdKBRoot()
	} else {
		local := ss.Stacks["local"]
		if local == nil {
			u.Fail("%s needs a running stack, and none is recorded.", verb)
			fmt.Fprintln(os.Stderr, "  Start one first:  semiont start")
			return VerbTarget{}, false
		}
		t.base = GatewayBase(local)
		key = "local"
		t.root = local.KBRoot
		if t.root == "" {
			t.root = CwdKBRoot()
		}
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
