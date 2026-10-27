package semiont

// A session with a knowledge base: the token its transport sends, renewed on
// the schedule every Semiont client keeps and whenever the gateway refuses it,
// and who that token is. How it starts and how it answers a refusal are the
// session table's (specs/src/session/cases.json, startup and refusal): it asks
// the gateway at most twice and renews at most once at its start, and one
// refusal costs at most one renewal and one ask. A token the issuer has just
// issued and the gateway refuses ends it, as session.credential-refused;
// renewing again cannot change the answer.

import (
	"context"
	"errors"
	"iter"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
)

// SessionEndReason is why a session ended, as its host is told: not a
// sentence. What a person reads is the host's to say, in their language.
type SessionEndReason string

const (
	// SessionEndExpired: its token could not be renewed.
	SessionEndExpired SessionEndReason = "expired"
	// SessionEndRefused: the gateway refused a token its issuer had just
	// issued.
	SessionEndRefused SessionEndReason = "refused"
)

// HeldSignIn is what is kept of a sign-in: the tokens an issuer issued, the
// client they were issued to, and the issuer's endpoints a renewal and a
// sign-out need, learned once at sign-in so no session asks again.
type HeldSignIn struct {
	Access        string
	Refresh       string
	ClientID      string
	TokenEndpoint string
	// RevocationEndpoint is "" when the issuer has none.
	RevocationEndpoint string
}

// SignInKept is where one knowledge base's sign-in is kept.
type SignInKept interface {
	// Held is the sign-in as it is kept now; false when there is none.
	Held(ctx context.Context) (HeldSignIn, bool, error)
	// Keep keeps signIn, in place of whatever was kept.
	Keep(ctx context.Context, signIn HeldSignIn) error
	// Renewed keeps the tokens a renewal of read issued, against what is kept
	// now, and is the access token kept then. When what is kept no longer
	// holds read's tokens, it was renewed some other way meanwhile: that
	// stands, and its access token is the one given. False when nothing is
	// kept: a sign-in that was signed out, or ended, while it was being renewed
	// is gone, and is not written back.
	Renewed(ctx context.Context, read HeldSignIn, access, refresh string) (string, bool, error)
	// Forget keeps the sign-in no more.
	Forget(ctx context.Context) error
}

// MemorySignIn is a sign-in kept for as long as the process lives, and no
// longer. Its zero value keeps nothing.
type MemorySignIn struct {
	mu     sync.Mutex
	signIn HeldSignIn
	has    bool
}

var _ SignInKept = (*MemorySignIn)(nil)

func (m *MemorySignIn) Held(context.Context) (HeldSignIn, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.signIn, m.has, nil
}

func (m *MemorySignIn) Keep(_ context.Context, signIn HeldSignIn) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.signIn, m.has = signIn, true
	return nil
}

func (m *MemorySignIn) Renewed(_ context.Context, read HeldSignIn, access, refresh string) (string, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.has {
		return "", false, nil
	}
	if m.signIn.Access != read.Access || m.signIn.Refresh != read.Refresh {
		return m.signIn.Access, true, nil
	}
	m.signIn.Access, m.signIn.Refresh = access, refresh
	return access, true, nil
}

func (m *MemorySignIn) Forget(context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.signIn, m.has = HeldSignIn{}, false
	return nil
}

// SessionConfig is what a session is made of.
type SessionConfig struct {
	// Kb is the knowledge base the session is with: where it is reached, and
	// Id, the key its sign-in is kept under.
	Kb api.KbTarget
	// Client is the client whose transport sends the session's token. The
	// session only uses it: whoever made the client and the session ends both.
	Client *Client
	// Token is the token the transport sends: "" for none.
	Token *Variable[string]
	// Kept is where the session's sign-in is kept.
	Kept SignInKept
	// Refresh renews the token at the issuer: the new token, "" when nothing
	// is kept to renew, or the failure, a *SignInError. Nil: the session
	// renews nothing.
	Refresh func(ctx context.Context) (string, error)
	// Validate asks the gateway who token is; a refusal of the token is a
	// *TransportError of code unauthorized. Nil: nobody is asked, as a
	// service's session asks nobody.
	Validate func(ctx context.Context, token string) (api.UserResponse, error)
	// OnAuthFailed is told why the session ended, when it ends. May be nil.
	OnAuthFailed func(SessionEndReason)
	// OnError is told each failure that makes the session unusable. May be nil.
	OnError func(*SessionError)
	Timing  Timing
}

// Session is a session with a knowledge base. It is a TokenRefresher: a
// transport that carries its token asks it when the gateway refuses that
// token.
type Session struct {
	config SessionConfig

	// alive ends when the session is closed.
	alive  context.Context
	cancel context.CancelFunc
	ready  chan struct{}
	once   sync.Once
	work   sync.WaitGroup
	// answering is held while a refusal is answered, so the refusals that
	// arrive during it are answered by it.
	answering sync.Mutex

	// id is which live session this is: a new one for the same knowledge
	// base has another.
	id   string
	user *Variable[*api.UserResponse]
}

var (
	_ TokenRefresher = (*Session)(nil)
	_ StateUnit      = (*Session)(nil)
)

const justIssuedAndRefused = "The gateway refused a token its issuer had just issued"

func notRenewed(failure string) string {
	if failure == "" {
		return "Token refresh failed"
	}
	return "Token refresh failed: " + failure
}

// StartSession starts a session over the sign-in config.Kept holds. A kept
// token that is still good is the one the transport sends first, unless the
// token was given one already. What the session does at its start, it does
// on its own: Ready says when it is done.
func StartSession(ctx context.Context, config SessionConfig) (*Session, error) {
	kept, has, err := config.Kept.Held(ctx)
	if err != nil {
		return nil, err
	}
	if has && !isTokenExpired(kept.Access, time.Now()) && config.Token.Value() == "" {
		config.Token.Set(kept.Access)
	}
	alive, cancel := context.WithCancel(context.Background())
	s := &Session{config: config, alive: alive, cancel: cancel, ready: make(chan struct{}), id: "session-" + uuid.NewString(), user: NewVariable[*api.UserResponse](nil)}
	s.work.Add(2)
	go func() {
		defer s.work.Done()
		renewWhenDue(s.alive, config.Token, config.Timing, func() { s.renew() })
	}()
	go func() {
		defer s.work.Done()
		defer s.markReady()
		s.start(kept, has)
	}()
	return s, nil
}

func (s *Session) markReady() { s.once.Do(func() { close(s.ready) }) }

func (s *Session) isReady() bool {
	select {
	case <-s.ready:
		return true
	default:
		return false
	}
}

func (s *Session) closing() bool { return s.alive.Err() != nil }

// Ready waits until the session has done what it does at its start, or ctx is
// done first.
func (s *Session) Ready(ctx context.Context) error {
	select {
	case <-s.ready:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Id is which live session this is: a new one for the same knowledge base
// has another.
func (s *Session) Id() string { return s.id }

// Kb is the knowledge base the session is with.
func (s *Session) Kb() api.KbTarget { return s.config.Kb }

// Client is the client whose transport sends the session's token.
func (s *Session) Client() *Client { return s.config.Client }

// Token is the token the transport sends: the present one, and each after it;
// "" for none.
func (s *Session) Token() Watched[string] { return s.config.Token.Reading() }

// User is who the gateway said the session's token is: nil until it has
// said, and once the session is signed out.
func (s *Session) User() Watched[*api.UserResponse] { return s.user.Reading() }

// StreamState is the state of the client's connection.
func (s *Session) StreamState() Watched[ConnectionState] { return s.config.Client.Transport.State() }

// Errors is the failures the client's transport meets, from now on. A host
// routes them: a refusal for want of a valid token is a reason to Refresh.
func (s *Session) Errors() iter.Seq[*TransportError] { return s.config.Client.Transport.Failures() }

// ExpiresAt is when the token the session holds expires; false when it holds
// none, or the token names no time.
func (s *Session) ExpiresAt() (time.Time, bool) {
	token := s.config.Token.Value()
	if token == "" {
		return time.Time{}, false
	}
	return tokenExpiry(token)
}

// Close ends the session: it renews nothing more and asks nobody anything,
// its token and who is signed in change no more, and it returns once what it
// was running has stopped. Closing twice is closing once. Its client is left
// to whoever made it.
func (s *Session) Close() {
	s.cancel()
	s.markReady()
	s.work.Wait()
	s.config.Token.End()
	s.user.End()
}

// Refresh answers the gateway's refusal of the session's token: it renews the
// token and asks the gateway who the new one is. It gives the token the
// session then holds; false when it holds none, and if it had a sign-in kept
// it is over. Refusals that arrive together are answered together, so however
// many requests were refused at once, they cost one renewal and one ask. A
// gateway that cannot be asked refuses nothing: the renewed token is given.
//
// The renewal runs under the session's own lifetime, not ctx: a refresh token
// spent at the issuer is not left without the token it bought.
func (s *Session) Refresh(context.Context) (string, bool) {
	refusedWith := s.config.Token.Value()
	s.answering.Lock()
	defer s.answering.Unlock()
	if current := s.config.Token.Value(); current != refusedWith {
		return current, current != ""
	}
	renewed, ok := s.renew()
	if !ok || s.config.Validate == nil {
		return renewed, ok
	}
	// While the session is starting, its start is what asks: it finds the
	// token renewed here and takes it up as the just-issued one.
	if !s.isReady() {
		return renewed, true
	}
	if _, err := s.config.Validate(s.alive, renewed); err != nil {
		// A gateway that could not be asked refused nothing. And only a token
		// the session still holds ends it: one replaced while the gateway was
		// being asked is no longer the session's to be refused.
		var refused *TransportError
		if errors.As(err, &refused) && refused.Code == TransportErrorCodeUnauthorized && !s.closing() && s.config.Token.Value() == renewed {
			s.signedOut(SessionEndRefused, &SessionError{Code: SessionErrorCodeCredentialRefused, Message: justIssuedAndRefused, KbID: s.config.Kb.Id})
		}
	}
	if s.closing() {
		return "", false
	}
	current := s.config.Token.Value()
	return current, current != ""
}

// tryRefresh asks Refresh: the token, or "" and why there is none. A renewal
// that could not be made and one that was refused both leave the session
// without a token.
func (s *Session) tryRefresh() (token, failure string) {
	if s.config.Refresh == nil {
		return "", ""
	}
	renewed, err := s.config.Refresh(s.alive)
	if err != nil {
		return "", err.Error()
	}
	return renewed, ""
}

// renew renews the token at the issuer, with nobody asked afterwards: what
// the session does on its own schedule.
func (s *Session) renew() (string, bool) {
	if s.closing() || s.config.Refresh == nil {
		return "", false
	}
	renewed, failure := s.tryRefresh()
	if s.closing() {
		return "", false
	}
	if renewed != "" {
		s.config.Token.Set(renewed)
		return renewed, true
	}
	s.config.Token.Set("")
	// A session that never had a credential cannot expire: it is signed out,
	// which is no failure. One whose store cannot say is ended, which forgets
	// what may be there.
	if _, held, err := s.config.Kept.Held(s.alive); err != nil || held {
		s.signedOut(SessionEndExpired, &SessionError{Code: SessionErrorCodeRefreshExhausted, Message: notRenewed(failure), KbID: s.config.Kb.Id})
	}
	return "", false
}

// signedOut is the session's end, whichever way it ended: its credential is
// forgotten, and its host is told why.
func (s *Session) signedOut(told SessionEndReason, err *SessionError) {
	s.config.Token.Set("")
	s.user.Set(nil)
	if forgotten := s.config.Kept.Forget(s.alive); forgotten != nil {
		err = &SessionError{Code: err.Code, Message: err.Message + "; and the sign-in could not be forgotten: " + forgotten.Error(), KbID: s.config.Kb.Id}
	}
	if s.config.OnAuthFailed != nil {
		s.config.OnAuthFailed(told)
	}
	s.failed(err)
}

func (s *Session) failed(err *SessionError) {
	if s.config.OnError != nil {
		s.config.OnError(err)
	}
}

// start is what a session does at its start, with the sign-in it found kept.
// It renews one that has expired, then asks the gateway who it is. A token
// the gateway refuses is renewed once and asked about once more; a token the
// issuer has just issued and the gateway refuses is final.
func (s *Session) start(kept HeldSignIn, has bool) {
	if !has {
		return
	}
	justIssued := isTokenExpired(kept.Access, time.Now())
	token := kept.Access
	if justIssued {
		renewed, _ := s.tryRefresh()
		if renewed == "" {
			// There was no session to end: the sign-in is forgotten, and
			// nothing is said.
			if !s.closing() {
				_ = s.config.Kept.Forget(s.alive)
			}
			return
		}
		token = renewed
		s.config.Token.Set(token)
	}
	if s.config.Validate == nil {
		return
	}
	for !s.closing() {
		user, err := s.config.Validate(s.alive, token)
		if err == nil {
			s.user.Set(&user)
			return
		}
		if s.closing() {
			return
		}
		var refused *TransportError
		if !errors.As(err, &refused) || refused.Code != TransportErrorCodeUnauthorized {
			s.failed(&SessionError{Code: SessionErrorCodeAuthFailed, Message: err.Error(), KbID: s.config.Kb.Id})
			return
		}
		if justIssued {
			s.signedOut(SessionEndRefused, &SessionError{Code: SessionErrorCodeCredentialRefused, Message: justIssuedAndRefused, KbID: s.config.Kb.Id})
			return
		}
		// The session's token is no longer the one asked about: the stream
		// was refused with it too, and Refresh renewed it meanwhile. That token
		// is the just-issued one, and is not renewed again.
		if current := s.config.Token.Value(); current != token {
			if current == "" {
				return
			}
			token, justIssued = current, true
			continue
		}
		renewed, failure := s.tryRefresh()
		if s.closing() {
			return
		}
		if renewed == "" {
			s.signedOut(SessionEndExpired, &SessionError{Code: SessionErrorCodeRefreshExhausted, Message: notRenewed(failure), KbID: s.config.Kb.Id})
			return
		}
		s.config.Token.Set(renewed)
		token, justIssued = renewed, true
	}
}

// renewWhenDue renews the token whenever it is due, until alive ends. The
// wait is counted from each token as it arrives, so one renewed some other way
// starts a wait of its own, and a renewal that changed nothing is due again a
// floor later. A token that names no expiry schedules nothing: it is renewed
// when whoever it is shown to refuses it.
func renewWhenDue(alive context.Context, token *Variable[string], timing Timing, renew func()) {
	for {
		current, changed := token.watch()
		var due <-chan time.Time
		var timer *time.Timer
		if current != "" {
			if delay, ok := refreshDelay(current, time.Now(), timing); ok {
				timer = time.NewTimer(delay)
				due = timer.C
			}
		}
		select {
		case <-alive.Done():
		case <-changed:
		case <-due:
			renew()
		}
		if timer != nil {
			timer.Stop()
		}
		if alive.Err() != nil {
			return
		}
	}
}
