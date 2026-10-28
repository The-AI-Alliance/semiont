package launcher

// session.go — one command's session with a stack's knowledge base: the Go
// SDK's session (semiont.ResumeSession) over the sign-in `semiont login`
// stored, which asks the gateway who its token is at its start, renews it at
// the issuer when it has expired or the gateway refuses it, and forgets a
// sign-in that cannot be renewed, as every SDK's session does
// (specs/src/session/cases.json). What is the launcher's here is the
// command's: a session that is over ends whatever the command is waiting on,
// and is said in the launcher's words with the one fix that applies. Also
// `semiont logout`.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"sync"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
)

// Session is one command's session with a stack: the SDK's session over the
// stack's stored sign-in, the command's client, whose transport carries the
// session's token, and the end of the command when the session is over.
type Session struct {
	u      *UI
	key    string // token/stack key: "local" or "codespace:<repo>"
	base   string // the stack's gateway base URL, which the tokens are for
	signIn semiont.SignIn
	token  *semiont.Variable[string]
	client *VerbClient
	sdk    *semiont.Session
	// resumed is closed once sdk is set. The client is made before the SDK's
	// session, and its stream can be refused, and ask Refresh for a token,
	// while that session is still being resumed.
	resumed chan struct{}

	// ended is done once the session is over for this command, with a
	// *SessionRejected as its cause.
	ended context.Context
	mu    sync.Mutex
	stop  context.CancelCauseFunc
}

// errNoRefreshToken: the stored session cannot be renewed — it carries no
// refresh token to renew it with.
var errNoRefreshToken = errors.New("no refresh token is stored to renew it")

// errExpired: the stored session's access token had expired, and the issuer
// would not renew it, so the gateway was never asked.
var errExpired = errors.New("its access token had expired")

// errNoSession: no sign-in is stored for the stack.
var errNoSession = errors.New("no session is stored")

// LoadSession is the stored session for a stack key, its tokens for the
// gateway at base, ready: asked about, and renewed if it needed to be, with
// the command's client, whose stream carries channels besides every
// operation's replies. ok is false when there is none, or it is over, which
// is said for verb with its fix.
func LoadSession(u *UI, verb, key, base string, channels ...bus.Channel) (*Session, bool) {
	s, err := resume(u, key, base, channels)
	var rejected *SessionRejected
	switch {
	case err == nil:
		return s, true
	case errors.Is(err, errNoSession):
		u.Fail("No session for %s.", key)
		fmt.Fprintln(os.Stderr, "  Log in first:  semiont login")
	case errors.As(err, &rejected):
		RejectedFail(u, verb, rejected)
	default:
		u.Fail("%v", err)
	}
	return nil, false
}

// resume resumes the stored session for key at base, over a client whose
// stream carries channels, saying nothing of why it cannot: errNoSession when
// none is stored, its *SessionRejected when it was over at its start.
func resume(u *UI, key, base string, channels []bus.Channel) (*Session, error) {
	store, ok := signInStore()
	if !ok {
		return nil, errNoSession
	}
	signIn, has, err := store.SignIn(key)
	if err != nil {
		return nil, fmt.Errorf("the sign-in store cannot be read: %w", err)
	}
	if !has || signIn.Token == "" {
		return nil, errNoSession
	}
	target, err := kbTarget(key, base)
	if err != nil {
		return nil, fmt.Errorf("the session for %s cannot be resumed: %w", key, err)
	}
	ended, stop := context.WithCancelCause(context.Background())
	s := &Session{u: u, key: key, base: base, signIn: signIn, token: semiont.NewVariable(""), resumed: make(chan struct{}), ended: ended, stop: stop}
	// A sign-in that cannot be renewed is no session the SDK holds: its token
	// is sent as it is, and the gateway is the judge.
	if signIn.RefreshToken == "" {
		s.token.Set(signIn.Token)
	}
	// The client is made first, as the SDK's session is over it: its
	// transport asks this session for a renewed token, and this session asks
	// the SDK's.
	s.client = s.openClient(channels)
	s.sdk, err = semiont.ResumeSession(context.Background(), semiont.ResumeConfig{
		Kb:            target,
		Client:        s.client.Client,
		Kept:          store.Entry(key),
		Token:         s.token,
		HTTP:          &http.Client{Transport: launcherTransport},
		Timing:        semiont.DefaultTiming(),
		AskWhoTokenIs: true,
		OnError:       s.failed,
	})
	if err != nil {
		s.client.close()
		return nil, fmt.Errorf("the session for %s cannot be resumed: %w", key, err)
	}
	close(s.resumed)
	if err := s.sdk.Ready(context.Background()); err != nil {
		s.Close()
		return nil, fmt.Errorf("the session for %s was not ready: %w", key, err)
	}
	// A session whose token expired and could not be renewed ended at its
	// start with nothing said: there was no session to end. Its sign-in is
	// forgotten; the command says why it cannot go on.
	if s.ended.Err() == nil && s.token.Value() == "" {
		s.end(&SessionRejected{refresh: errExpired})
	}
	if rejected, over := context.Cause(s.ended).(*SessionRejected); over {
		s.Close()
		return nil, rejected
	}
	s.noteRenewal(signIn.Token)
	return s, nil
}

// noteRenewal says the session was renewed, when the token it holds is not
// the one it held. On stderr, never stdout: a verb's `--json` reply piped to
// jq must stay one JSON document.
func (s *Session) noteRenewal(before string) {
	if now := s.token.Value(); now != "" && now != before {
		s.u.Note("Session refreshed %s", s.u.Dim("(access token renewed at the issuer from the stored refresh token)"))
	}
}

// failed is a failure the SDK's session reported. One that ends it ends the
// command: a renewal the issuer would not make, or a token the issuer had just
// issued that the gateway refused. A gateway that could not be asked at the
// start refuses nothing: the command goes on, and its requests are the judge.
func (s *Session) failed(err *semiont.SessionError) {
	switch err.Code {
	case semiont.SessionErrorCodeRefreshExhausted:
		s.end(&SessionRejected{refresh: errors.New(err.Message)})
	case semiont.SessionErrorCodeCredentialRefused:
		s.end(&SessionRejected{})
	}
}

// end ends the session for the reason rejected gives, unless it has already
// ended: the first reason stands. Its transport is left no token to offer.
func (s *Session) end(rejected *SessionRejected) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ended.Err() != nil {
		return
	}
	s.stop(rejected)
	s.token.Set("")
}

// Signee is whom the session's token is: what the gateway said at the
// session's start, or, when it was not asked then (the SDK asks only of a
// sign-in it renews), what it says now.
func (s *Session) Signee(ctx context.Context) (api.UserResponse, error) {
	if user := s.sdk.User().Value(); user != nil {
		return *user, nil
	}
	return s.client.Auth.Me(ctx)
}

// Close ends the SDK's session, so it renews nothing more, and then the
// command's client.
func (s *Session) Close() {
	s.sdk.Close()
	s.client.close()
}

// kbTarget is the knowledge base key names, at the gateway whose origin is
// base.
func kbTarget(key, base string) (api.KbTarget, error) {
	at, err := url.Parse(base)
	if err != nil {
		return api.KbTarget{}, err
	}
	number, err := strconv.Atoi(at.Port())
	if err != nil {
		return api.KbTarget{}, fmt.Errorf("%s names no port: %w", base, err)
	}
	var endpoint api.KbEndpoint
	err = endpoint.FromHttpEndpoint(api.HttpEndpoint{Kind: api.HttpEndpointKindHttp, Protocol: api.HttpEndpointProtocol(at.Scheme), Host: at.Hostname(), Port: number})
	return api.KbTarget{Id: key, Label: key, Endpoint: endpoint}, err
}

// Refresh is a renewed token for a transport the gateway refused the
// session's token to (semiont.TokenRefresher): the SDK's session renews it and
// asks the gateway who the new one is. ok=false: the session is over, and its
// end's cause says why.
func (s *Session) Refresh(ctx context.Context) (token string, ok bool) {
	// A refusal that comes before the SDK's session exists is answered by it
	// once it does. ctx is the stream's, done when the client closes, as it
	// does when that session cannot be resumed.
	select {
	case <-s.resumed:
	case <-s.ended.Done():
		return "", false
	case <-ctx.Done():
		return "", false
	}
	if s.ended.Err() != nil {
		return "", false
	}
	before := s.token.Value()
	renewed, ok := s.sdk.Refresh(ctx)
	if !ok {
		why := errNoRefreshToken
		if s.signIn.RefreshToken != "" {
			why = errors.New("the stack was signed out while its session was being renewed")
		}
		s.end(&SessionRejected{refresh: why})
		return "", false
	}
	s.noteRenewal(before)
	return renewed, true
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

// VerbSession resolves a verb's stack and its session in one place, because
// nine verbs asking the same questions nine different ways is how they drift.
// Refusals are printed here with their fix-it lines; ok=false means stop.
func VerbSession(u *UI, verb, repo string, wantLocal bool, channels ...bus.Channel) (*Session, bool) {
	ss := LoadStackSet()
	target, ok := SelectVerbStack(u, verb, ss, repo, wantLocal)
	if !ok {
		return nil, false
	}
	var base, key string
	if target != nil {
		if base, ok = ForwardedBase(u, target, verb); !ok {
			return nil, false
		}
		key = "codespace:" + target.Codespace.Repo
	} else {
		local := ss.Stacks["local"]
		if local == nil {
			u.Fail("%s needs a running stack, and none is recorded.", verb)
			fmt.Fprintln(os.Stderr, "  Start one first:  semiont start")
			return nil, false
		}
		if base, ok = LocalBase(u, local, verb); !ok {
			return nil, false
		}
		key = "local"
	}
	return LoadSession(u, verb, key, base, channels...)
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

	store, ok := signInStore()
	if !ok {
		u.Log("No session for %s — nothing to log out.", key)
		return 0
	}
	e, have, err := store.SignIn(key)
	if err != nil {
		u.Fail("The sign-in store cannot be read: %v", err)
		return 1
	}
	if !have {
		u.Log("No session for %s — nothing to log out.", key)
		return 0
	}
	// Issuer-side first, best-effort: an unreachable issuer must not trap the
	// user in a session they asked to end — but say what it means.
	issuer := semiont.Issuer{HTTP: &http.Client{Transport: launcherTransport}, Timing: semiont.DefaultTiming()}
	revoked, err := semiont.SignOut(context.Background(), issuer, store.Entry(key))
	if err != nil {
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
