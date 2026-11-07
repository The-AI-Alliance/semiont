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
	"log/slog"
	"math/rand/v2"
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
func asking(baseURL string, client *http.Client, timing Timing, random *rand.Rand) func(context.Context, string) (api.UserResponse, error) {
	return func(ctx context.Context, token string) (api.UserResponse, error) {
		asker := NewHTTPTransport(HTTPTransportConfig{BaseURL: baseURL, Token: NewVariable(token), HTTP: client, Timing: timing, Random: random})
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
	// Random is what the jitter of the session's renewals tried again is
	// drawn from, as EqualJitter draws it.
	Random *rand.Rand
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
	return StartSession(ctx, resumed(config, baseURL))
}

// resumed is what a session resumed over config is, with the gateway at
// baseURL.
func resumed(config ResumeConfig, baseURL string) SessionConfig {
	issuer := Issuer{HTTP: config.HTTP, Timing: config.Timing, Random: config.Random}
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
		Random:       config.Random,
	}
	if config.AskWhoTokenIs {
		session.Validate = asking(baseURL, config.HTTP, config.Timing, config.Random)
	}
	return session
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
	// Random is what the jitter of every backoff of the transport and the
	// session is drawn from, as EqualJitter draws it.
	Random *rand.Rand
	// AskWhoTokenIs is whether the gateway is asked who the token is.
	AskWhoTokenIs bool
	// Channels is the global channels the transport's stream names
	// (bus.BridgedChannels for every channel a client hears).
	Channels []bus.Channel
	// Storage keeps what the client's small queries hold, and the stream's
	// place in each scope with it, for the person the gateway names, under
	// Kb's Id and their key (PersonKey): the next session over the same
	// storage, for the same person, shows what was kept at once, and is sent
	// what was recorded since. The person is the one the kept sign-in names
	// as the session is made; when it names nobody, nothing is kept until the
	// gateway names them and the sign-in records it
	// (SignInKept.RecordPersonKey). Each is written only while the kept
	// sign-in names that person, checked and written as one step: once a write
	// finds it forgotten, or naming nobody or another person, the session
	// writes nothing more there, so nothing it writes puts back what
	// forgetting the sign-in deleted. The session's own forget of its sign-in
	// (its expiry, its refusal) waits for a write being made. Nil, or a
	// session that does not ask who its token is, keeps nothing.
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
	var held HeldSignIn
	var has bool
	keepsForAPerson := config.Storage != nil && config.AskWhoTokenIs
	if keepsForAPerson {
		if held, has, err = config.Kept.Held(ctx); err != nil {
			return nil, nil, err
		}
	}
	token := NewVariable("")
	renewer := newRefresherToCome()
	transport := NewHTTPTransport(HTTPTransportConfig{
		BaseURL: baseURL, Token: token, Refresher: renewer,
		Channels: config.Channels, HTTP: config.HTTP, Timing: config.Timing, Random: config.Random,
	})
	client := NewClient(ClientConfig{Transport: transport, Content: NewHTTPContentTransport(transport), Gateway: transport, Timing: config.Timing})
	sessionConfig := resumed(ResumeConfig{
		Kb: config.Kb, Client: client, Kept: config.Kept, Token: token, HTTP: config.HTTP, Timing: config.Timing, Random: config.Random,
		AskWhoTokenIs: config.AskWhoTokenIs, OnAuthFailed: config.OnAuthFailed, OnError: config.OnError,
	}, baseURL)
	var keeps *keptFor
	if keepsForAPerson {
		keeps = &keptFor{SignInKept: config.Kept, storage: config.Storage, kbID: config.Kb.Id, client: client, transport: transport, onError: config.OnError}
		if has && held.PersonKey != nil {
			keeps.attach(*held.PersonKey)
		}
		sessionConfig.Kept = keeps
		sessionConfig.Validate = keeps.recording(sessionConfig.Validate)
	}
	session, err = StartSession(ctx, sessionConfig)
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
		if keepsForAPerson {
			// A save whose wait was over as the client closed may still be
			// being written: it lands before end returns, so whoever ended
			// the session may delete what was kept of its person then.
			keeps.stop()
		}
	}
	if err := session.Ready(ctx); err != nil {
		end()
		return nil, nil, err
	}
	return session, end, nil
}

// keptFor is what a session's client keeps in a storage for the person the
// session's gateway names: nothing until it is attached for them. It is the
// session's sign-in too, kept where it is kept, so that the session's forget
// of it stops what the client keeps first (Forget).
type keptFor struct {
	SignInKept
	storage   SessionStorage
	kbID      string
	client    *Client
	transport *HTTPTransport
	// onError is the session's (SessionConfig): it is told when the client
	// stops keeping because the sign-in could not be read.
	onError func(*SessionError)

	mu sync.Mutex
	// keeping is where the client keeps the person's things: nil until it is
	// attached.
	keeping *whileNamed
	// stopped holds once the session has forgotten its sign-in, or ended:
	// nothing is attached after that.
	stopped bool
}

// attach has the client keep its caches, and the transport its stream's
// places, for the person whose key is personKey: each begins with what was
// kept for them, and keeps what it holds from now on. The places ride the
// caches' writes, and only when what the client keeps is at rest
// (CoupledBookmarks.CoupleTo): a place kept ahead of a cache still taking in
// the event it names would have the next session skip that event.
func (k *keptFor) attach(personKey string) {
	k.keeping = &whileNamed{SessionStorage: k.storage, kept: k.SignInKept, personKey: personKey, unreadable: k.unreadable}
	places := NewCoupledBookmarks(k.keeping, LastEventIDKey(k.kbID, personKey))
	places.CoupleTo(k.client)
	k.transport.keepPlaces(places)
	k.client.live.attach(&CachePersistence{Storage: places.Storage(), KbID: k.kbID, PersonKey: personKey})
}

// Forget is the session forgetting its sign-in (its expiry, its refusal).
// What the client keeps is stopped first: a write that passed its check lands
// before the sign-in, and what was kept of its person, is forgotten, and none
// is made after.
func (k *keptFor) Forget(ctx context.Context) error {
	k.stop()
	return k.SignInKept.Forget(ctx)
}

// unreadable tells the session's OnError, as session.keep-failed, that the
// sign-in could not be read before the client saved what it keeps, so the
// client keeps nothing more.
func (k *keptFor) unreadable(err error) {
	if k.onError != nil {
		k.onError(&SessionError{Code: SessionErrorCodeKeepFailed, Message: "The sign-in could not be read before the client saved what it keeps: " + err.Error(), KbID: k.kbID})
	}
}

// stop has the client keep nothing more, once a write being made is made:
// every write after it is dropped, under the lock each write is checked and
// made under, and nothing is attached after it.
func (k *keptFor) stop() {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.stopped = true
	if k.keeping != nil {
		k.keeping.drop()
	}
}

// whileNamed is the storage a session keeps one person's things in, written
// only while its kept sign-in names that person (HeldSignIn.PersonKey). Each
// write is checked and made as one step. Once a write finds the sign-in
// forgotten, or naming nobody or another person, or cannot read it, or the
// session has dropped it, that write and every one after it are dropped: what
// the session had not written of the person is discarded.
type whileNamed struct {
	SessionStorage
	kept      SignInKept
	personKey string
	// unreadable is told why the sign-in could not be read, the one time it
	// is found so: nothing is asked of it after.
	unreadable func(error)

	// mu is held across each write's check and the write, and by drop.
	mu      sync.Mutex
	dropped bool
}

// writes reports whether a write is made, with mu held, and why the sign-in
// could not be read when this is the check that found it so. A sign-in that
// cannot be read is not known to name the person.
func (w *whileNamed) writes() (bool, error) {
	if w.dropped {
		return false, nil
	}
	held, has, err := w.kept.Held(context.Background())
	w.dropped = err != nil || !has || held.PersonKey == nil || *held.PersonKey != w.personKey
	return !w.dropped, err
}

func (w *whileNamed) Set(key, value string) error {
	return w.made(func() error { return w.SessionStorage.Set(key, value) })
}

func (w *whileNamed) Update(key string, change func(stored string, has bool) (string, bool)) error {
	return w.made(func() error { return w.SessionStorage.Update(key, change) })
}

// made checks and makes write as one step, under mu. A sign-in found
// unreadable is said once mu is let go: mu is held over the check and the
// write, and no one's callback.
func (w *whileNamed) made(write func() error) error {
	w.mu.Lock()
	writes, unreadable := w.writes()
	var err error
	if writes {
		err = write()
	}
	w.mu.Unlock()
	if unreadable != nil {
		w.unreadable(unreadable)
	}
	return err
}

// drop has every write from now on dropped, once a write being made is made.
func (w *whileNamed) drop() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.dropped = true
}

// recording is validate, and, once the gateway has said who a token is, the
// person recorded on the sign-in it was asked about, and what was kept for
// them attached, before validate's caller hears the answer.
func (k *keptFor) recording(validate func(ctx context.Context, token string) (api.UserResponse, error)) func(ctx context.Context, token string) (api.UserResponse, error) {
	return func(ctx context.Context, token string) (api.UserResponse, error) {
		user, err := validate(ctx, token)
		if err == nil {
			k.named(ctx, token, user)
		}
		return user, err
	}
}

// named records user, who the gateway said token is, on the sign-in, while it
// still holds token and names nobody else, and attaches what is kept for them
// once it names them. A sign-in that has moved on, or names another person,
// or whose session has forgotten it or ended, attaches nothing.
func (k *keptFor) named(ctx context.Context, token string, user api.UserResponse) {
	personKey := PersonKey(user.Did.String())
	recorded, err := k.RecordPersonKey(ctx, token, personKey)
	if err != nil {
		slog.Warn("semiont: who the gateway named was not recorded on the sign-in", "error", err)
		return
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	if recorded && k.keeping == nil && !k.stopped {
		k.attach(personKey)
	}
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
