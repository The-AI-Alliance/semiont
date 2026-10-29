package semiont

// A person's sign-in and session with a knowledge base over its gateway.
// ResumeSession starts a session over a sign-in kept somewhere: the one
// `semiont login` made, kept in a SignInStore, or one this program kept
// earlier, over a client its caller made. SessionFromKept makes the client
// too, over HTTP. SignInWithDevice makes a sign-in to keep, from a process
// with no browser. SignOut ends one.
//
// A session resumed here renews its token at the issuer its kept sign-in
// names. Renewals asked for together are one request: a stream refused and a
// request refused at the same moment spend one refresh token, not two, of
// which an issuer that rotates them would refuse the second.

import (
	"context"
	"fmt"
	"net/http"
	"sync"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
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
		asker := NewHTTPTransport(HTTPTransportConfig{BaseURL: baseURL, Token: NewVariable(token), HTTP: client, Timing: timing})
		defer asker.Close()
		return asker.GetCurrentUser(ctx)
	}
}

// ResumeConfig is what a resumed session is made of.
type ResumeConfig struct {
	// Kb is the knowledge base the session is with: its HTTP endpoint names
	// the gateway, and its Id is the key its sign-in is kept under.
	Kb api.KbTarget
	// Client is the client whose transport carries Token, with the session as
	// its refresher. Whoever made it ends it.
	Client *Client
	// Kept is where the sign-in is kept.
	Kept SignInKept
	// Token is the token the session holds, which the transport that carries
	// it is given too, with the session as its refresher.
	Token *Variable[string]
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
// token is "", and a request made with it is refused. A knowledge base that
// is not reached over HTTP, or whose host is no host's name, is refused
// before anything is asked (session.construct-failed).
func ResumeSession(ctx context.Context, config ResumeConfig) (*Session, error) {
	baseURL, err := gatewayOf(config.Kb)
	if err != nil {
		return nil, err
	}
	issuer := Issuer{HTTP: config.HTTP, Timing: config.Timing}
	renewals := &renewing{}
	session := SessionConfig{
		Kb:     config.Kb,
		Client: config.Client,
		Token:  config.Token,
		Kept:   config.Kept,
		Refresh: func(ctx context.Context, renewing string) (string, error) {
			return renewals.renew(ctx, func(ctx context.Context) (string, error) {
				return issuer.RenewKept(ctx, config.Kept, renewing)
			})
		},
		OnAuthFailed: config.OnAuthFailed,
		OnError:      config.OnError,
		Timing:       config.Timing,
	}
	if config.AskWhoTokenIs {
		session.Validate = asking(baseURL, config.HTTP, config.Timing)
	}
	return StartSession(ctx, session)
}

// gatewayOf is the origin of the gateway kb's HTTP endpoint names; a
// session.construct-failed for a knowledge base reached any other way, and
// for a host that is no host's name.
func gatewayOf(kb api.KbTarget) (string, error) {
	kind, err := kb.Endpoint.Discriminator()
	if err != nil {
		return "", &SessionError{Code: SessionErrorCodeConstructFailed, Message: fmt.Sprintf("The knowledge base's endpoint cannot be read: %v", err), KbID: kb.Id}
	}
	if kind != string(api.HttpEndpointKindHttp) {
		return "", &SessionError{Code: SessionErrorCodeConstructFailed, Message: fmt.Sprintf("A session over HTTP cannot be built for endpoint kind %q", kind), KbID: kb.Id}
	}
	endpoint, err := kb.Endpoint.AsHttpEndpoint()
	if err != nil {
		return "", &SessionError{Code: SessionErrorCodeConstructFailed, Message: fmt.Sprintf("The knowledge base's endpoint cannot be read: %v", err), KbID: kb.Id}
	}
	baseURL, err := GatewayURL(endpoint)
	if err != nil {
		return "", &SessionError{Code: SessionErrorCodeConstructFailed, Message: err.Error(), KbID: kb.Id}
	}
	return baseURL, nil
}

// SessionFromKeptConfig is what SessionFromKept makes a session of.
type SessionFromKeptConfig struct {
	// Kb is the knowledge base: its HTTP endpoint names the gateway, and its
	// Id is the key its sign-in, and anything Storage keeps, are kept under.
	Kb api.KbTarget
	// Kept is where the sign-in is kept.
	Kept SignInKept
	// HTTP is the client every request of the gateway and the issuer is made
	// over.
	HTTP   *http.Client
	Timing Timing
	// AskWhoTokenIs is whether the gateway is asked who the token is.
	AskWhoTokenIs bool
	// Channels is the global channels the transport's stream names
	// (bus.BridgedChannels for every channel a client hears).
	Channels []bus.Channel
	// Storage keeps what the client's small queries hold, under Kb's Id, and
	// the stream's place in each scope with it: the next session over the
	// same storage shows what was kept at once, and is sent what was recorded
	// since. Nil keeps nothing.
	Storage SessionStorage
	// OnAuthFailed and OnError are the session's (SessionConfig).
	OnAuthFailed func(SessionEndReason)
	OnError      func(*SessionError)
}

// SessionFromKept is a session with config.Kb over the sign-in config.Kept
// holds, with the transport and client it is over: open, and ready. A token
// the gateway refuses is renewed through the session, so the transport and
// the session never hold different ones. end ends the session, then the
// client and the transport, as whoever made them must. A knowledge base that
// is not reached over HTTP, or whose host is no host's name, is refused
// before anything is asked (session.construct-failed).
func SessionFromKept(ctx context.Context, config SessionFromKeptConfig) (session *Session, end func(), err error) {
	baseURL, err := gatewayOf(config.Kb)
	if err != nil {
		return nil, nil, err
	}
	token := NewVariable("")
	renewer := newRefresherToCome()
	var places *CoupledBookmarks
	var persistence *CachePersistence
	transportConfig := HTTPTransportConfig{
		BaseURL: baseURL, Token: token, Refresher: renewer,
		Channels: config.Channels, HTTP: config.HTTP, Timing: config.Timing,
	}
	if config.Storage != nil {
		// The stream's place rides the caches' writes, and only when every
		// cache is at rest: a place kept ahead of a cache still taking in the
		// event it names would have the next session skip that event.
		places = NewCoupledBookmarks(config.Storage, "semiont.lastEventId."+config.Kb.Id)
		persistence = &CachePersistence{Storage: places.Storage(), KeyPrefix: config.Kb.Id}
		transportConfig.Bookmarks = places
	}
	transport := NewHTTPTransport(transportConfig)
	client := NewClient(ClientConfig{Transport: transport, Content: NewHTTPContentTransport(transport), Gateway: transport, Timing: config.Timing, Persistence: persistence})
	if places != nil {
		places.SetFlushGate(client.PersistenceSettled)
	}
	session, err = ResumeSession(ctx, ResumeConfig{
		Kb: config.Kb, Client: client, Kept: config.Kept, Token: token, HTTP: config.HTTP, Timing: config.Timing,
		AskWhoTokenIs: config.AskWhoTokenIs, OnAuthFailed: config.OnAuthFailed, OnError: config.OnError,
	})
	if err != nil {
		// No session is to come: closing the transport ends the wait of a
		// refusal that arrived first.
		client.Close()
		transport.Close()
		return nil, nil, err
	}
	renewer.is(session)
	end = func() {
		session.Close()
		client.Close()
		transport.Close()
	}
	if err := session.Ready(ctx); err != nil {
		end()
		return nil, nil, err
	}
	return session, end, nil
}

// refresherToCome is a TokenRefresher that asks one made after it. A
// transport is built before the session that renews its token, and the
// session starts sending that token before it is returned, so a refusal can
// arrive before there is a session to ask: it waits for one.
type refresherToCome struct {
	made      chan struct{}
	refresher TokenRefresher
}

func newRefresherToCome() *refresherToCome {
	return &refresherToCome{made: make(chan struct{})}
}

// is says which refresher answers. It is said once.
func (r *refresherToCome) is(refresher TokenRefresher) {
	r.refresher = refresher
	close(r.made)
}

// Refresh waits for the refresher to come, then asks it. It gives no token
// when ctx is done first, as it is when the transport closes because no
// session was made.
func (r *refresherToCome) Refresh(ctx context.Context, refused string) (string, bool) {
	select {
	case <-r.made:
		return r.refresher.Refresh(ctx, refused)
	case <-ctx.Done():
		return "", false
	}
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
