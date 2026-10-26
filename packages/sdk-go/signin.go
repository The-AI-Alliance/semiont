package semiont

// A person's sign-in and session with a knowledge base over its gateway.
// ResumeSession starts a session over a sign-in kept somewhere: the one
// `semiont login` made, kept in a SignInStore, or one this program kept
// earlier. SignInWithDevice makes a sign-in to keep, from a process with no
// browser. SignOut ends one.
//
// A session resumed here renews its token at the issuer its kept sign-in
// names. Renewals asked for together are one request: a stream refused and a
// request refused at the same moment spend one refresh token, not two, of
// which an issuer that rotates them would refuse the second.

import (
	"context"
	"net/http"
	"sync"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
)

// renewing is a kept sign-in's renewals, one at a time: a renewal asked for
// while one is under way is that one.
type renewing struct {
	mu       sync.Mutex
	underWay chan struct{}
	token    string
	err      error
}

func (r *renewing) renew(ctx context.Context, once func(context.Context) (string, error)) (string, error) {
	r.mu.Lock()
	underWay := r.underWay
	if underWay == nil {
		underWay = make(chan struct{})
		r.underWay = underWay
		go func() {
			token, err := once(ctx)
			r.mu.Lock()
			r.token, r.err, r.underWay = token, err, nil
			r.mu.Unlock()
			close(underWay)
		}()
	}
	r.mu.Unlock()
	<-underWay
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.token, r.err
}

// asking is a way to ask the gateway at baseURL who a token is: one request,
// by a transport that opens no stream and renews nothing, so a refusal is the
// answer.
func asking(baseURL string, client *http.Client, timing Timing) func(context.Context, string) (api.UserResponse, error) {
	return func(ctx context.Context, token string) (api.UserResponse, error) {
		asker := NewHTTPTransport(HTTPTransportConfig{BaseURL: baseURL, Token: NewWatched(token), HTTP: client, Timing: timing})
		defer asker.Close()
		return asker.GetCurrentUser(ctx)
	}
}

// ResumeConfig is what a resumed session is made of.
type ResumeConfig struct {
	// KbID is the knowledge base the session is with: the key its sign-in is
	// kept under.
	KbID string
	// BaseURL is the gateway's origin (GatewayURL).
	BaseURL string
	// Kept is where the sign-in is kept.
	Kept SignInKept
	// Token is the token the session holds, which the transport that carries
	// it is given too, with the session as its refresher.
	Token *Watched[string]
	// HTTP is the client every request of the gateway and the issuer is made
	// over.
	HTTP   *http.Client
	Timing Timing
	// AskWhoTokenIs is whether the gateway is asked who the token is, at the
	// start and after each renewal a refusal asked for.
	AskWhoTokenIs bool
	// OnAuthFailed and OnError are the session's (SessionConfig).
	OnAuthFailed func(SessionEndReason)
	OnError      func(*SessionError)
}

// ResumeSession starts a session over the sign-in config.Kept holds, renewed
// at the issuer it names. With nothing kept, the session is signed out: its
// token is "", and a request made with it is refused.
func ResumeSession(ctx context.Context, config ResumeConfig) (*Session, error) {
	issuer := Issuer{HTTP: config.HTTP, Timing: config.Timing}
	renewals := &renewing{}
	session := SessionConfig{
		KbID:  config.KbID,
		Token: config.Token,
		Kept:  config.Kept,
		Refresh: func(ctx context.Context) (string, error) {
			return renewals.renew(ctx, func(ctx context.Context) (string, error) {
				return issuer.RenewKept(ctx, config.Kept, config.Token.Value())
			})
		},
		OnAuthFailed: config.OnAuthFailed,
		OnError:      config.OnError,
		Timing:       config.Timing,
	}
	if config.AskWhoTokenIs {
		session.Validate = asking(config.BaseURL, config.HTTP, config.Timing)
	}
	return StartSession(ctx, session)
}

// SignInWithDevice signs a person in from a process with no browser, and keeps
// the sign-in in kept. The issuer the knowledge base at baseURL trusts mints a
// code, onCode shows the person where to approve it, and the tokens come back
// here: no password passes through this process.
func SignInWithDevice(ctx context.Context, issuer Issuer, baseURL string, kept SignInKept, onCode func(DeviceCode)) (IssuerEndpoints, error) {
	endpoints, err := issuer.Discover(ctx, baseURL)
	if err != nil {
		return IssuerEndpoints{}, err
	}
	tokens, err := issuer.SignInWithDeviceGrant(ctx, endpoints, onCode)
	if err != nil {
		return IssuerEndpoints{}, err
	}
	return endpoints, kept.Keep(ctx, HeldSignIn{
		Access:             tokens.Access,
		Refresh:            tokens.Refresh,
		ClientID:           ScriptClientID,
		TokenEndpoint:      endpoints.Token,
		RevocationEndpoint: endpoints.Revocation,
	})
}

// SignOut ends the sign-in kept holds: it is revoked at its issuer, when the
// issuer says where, and kept no more. It is forgotten whatever the issuer
// answers: a person who signs out is signed out here, and an issuer that could
// not be told forgets the token when it expires. revoked is whether the
// issuer was told.
func SignOut(ctx context.Context, issuer Issuer, kept SignInKept) (revoked bool, err error) {
	held, ok, err := kept.Held(ctx)
	if err != nil {
		return false, err
	}
	if !ok {
		return false, kept.Forget(ctx)
	}
	if held.RevocationEndpoint != "" {
		revoked = issuer.Revoke(ctx, held.RevocationEndpoint, held.ClientID, held.Refresh) == nil
	}
	return revoked, kept.Forget(ctx)
}
