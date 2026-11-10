package semiont

// A session with a knowledge base: the token its transport sends, renewed on
// the schedule every Semiont client keeps and whenever the gateway refuses it,
// and who that token is. How it starts and how it answers a refusal are the
// session table's (protocol/specs/src/session/cases.json, startup and refusal): it asks
// the gateway at most twice and renews at most once at its start, and one
// refusal costs at most one renewal and one ask. A token the issuer has just
// issued and the gateway refuses ends it, as session.credential-refused;
// renewing again cannot change the answer. Whenever a token is renewed, what
// is kept is forgotten only when the issuer refuses: a renewal that got no
// answer leaves the session no usable token and keeps what is kept, and the
// next refusal renews again, and so does the session on its own, on the
// reconnect backoff. What goes wrong, the session says once on its one errors
// stream (Errors), beside its transport's failures: it takes no callback for
// it.

import (
	"context"
	"errors"
	"iter"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// SessionEndReason is why a session ended, as its host is told: not a
// sentence. What a person reads is the host's to say, in their language.
type SessionEndReason string

const (
	// SessionEndExpired: its issuer refused to renew its token.
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
	// PersonKey is who the gateway said the sign-in's person is, as the key
	// what is kept of them is kept under (PersonKey): nil until it has said.
	// A renewal keeps it; a new sign-in has none.
	PersonKey *string
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
	// RecordPersonKey records personKey, the key of the person the gateway
	// said access is, on the sign-in kept now, as one step: only while it
	// holds access and names no person. It reports whether the sign-in kept
	// names personKey afterwards: false when it holds another token, or none,
	// or names another person, and for a store that keeps no person. It is
	// how a session keys what its client keeps by the person, on whatever
	// keeps its sign-in.
	RecordPersonKey(ctx context.Context, access, personKey string) (bool, error)
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

// RecordPersonKey records personKey on the sign-in held, as SignInKept says:
// only while it holds access and names no person.
func (m *MemorySignIn) RecordPersonKey(_ context.Context, access, personKey string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.has || m.signIn.Access != access {
		return false, nil
	}
	if m.signIn.PersonKey == nil {
		m.signIn.PersonKey = &personKey
	}
	return *m.signIn.PersonKey == personKey, nil
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
	// Client is the client whose transport sends the session's token, and
	// whose transport's failures the session's errors carry. The session only
	// uses it: whoever made the client and the session ends both, the client
	// first, waiting for its closing flush, then the session, then the
	// client's transport.
	Client *Client
	// Token is the token the transport sends: "" for none.
	Token *Variable[string]
	// Kept is where the session's sign-in is kept.
	Kept SignInKept
	// Refresh renews renewing, the token the session holds, at the issuer:
	// the new token, "" when nothing is kept to renew, or the failure, a
	// *SignInError. renewing is the token found kept at the start, though it
	// has expired, and, once a renewal that got no answer has left the
	// session holding none, the token that renewal was for: "" only for a
	// session that has held none. Nil: the session renews nothing.
	Refresh func(ctx context.Context, renewing string) (string, error)
	// Validate asks the gateway who token is; a refusal of the token is a
	// *TransportError of code unauthorized. Nil: nobody is asked, as a
	// service's session asks nobody.
	Validate func(ctx context.Context, token string) (api.UserResponse, error)
	// OnAuthFailed is told why the session ended, when it ends. May be nil.
	OnAuthFailed func(SessionEndReason)
	Timing       Timing
	// Random is what the jitter of a renewal tried again after it got no
	// answer is drawn from, as EqualJitter draws it.
	Random *rand.Rand
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
	// answering is held while Refresh answers a refusal, so the refusals
	// that arrive during it are answered by it. An answer that ends the
	// session has ended it in full before it lets go: the token gone, the
	// sign-in forgotten, and why told.
	answering sync.Mutex

	// id is which live session this is: a new one for the same knowledge
	// base has another.
	id   string
	user *Variable[*api.UserResponse]
	// unanswered holds while a renewal that got no answer is owed another
	// attempt.
	unanswered *Variable[bool]
	// renewedMu guards renewed: the token the session last handed a renewal,
	// which a renewal made while it holds none is handed.
	renewedMu sync.Mutex
	renewed   string
	// failures is the session's errors (Errors).
	failures *failureStream[Error]
}

var (
	_ TokenRefresher = (*Session)(nil)
	_ StateUnit      = (*Session)(nil)
)

const justIssuedAndRefused = "The gateway refused a token its issuer had just issued"

func notRenewed(failure error) string {
	if failure == nil {
		return "Token refresh failed"
	}
	return "Token refresh failed: " + failure.Error()
}

// StartSession starts a session over the sign-in config.Kept holds. A kept
// token that is still good is the session's, unless the token was given one
// already. A session that asks the gateway who its token is gives the kept
// token to the transport once the gateway has answered its start and not
// refused it, so the transport never sends a kept token the gateway refuses;
// one that asks nobody gives it at once. What the session does at its start,
// it does on its own: Ready says when it is done.
func StartSession(ctx context.Context, config SessionConfig) (*Session, error) {
	return startSession(ctx, config, newFailureStream[Error]())
}

// startSession is StartSession, saying what goes wrong on failures: made
// before the session, so that what keeps its sign-in can say there what it
// meets while the session starts.
func startSession(ctx context.Context, config SessionConfig, failures *failureStream[Error]) (*Session, error) {
	kept, has, err := config.Kept.Held(ctx)
	if err != nil {
		return nil, err
	}
	keepsKept := has && !IsTokenExpired(kept.Access, time.Now()) && config.Token.Value() == ""
	if keepsKept && config.Validate == nil {
		config.Token.Set(kept.Access)
	}
	alive, cancel := context.WithCancel(context.Background())
	s := &Session{config: config, alive: alive, cancel: cancel, ready: make(chan struct{}), id: "session-" + uuid.NewString(), user: NewVariable[*api.UserResponse](nil), unanswered: NewVariable(false), failures: failures}
	// Taken now: a failure the transport meets once the session is made is
	// among the session's errors.
	go s.carry(config.Client.Transport.Failures())
	s.work.Add(3)
	go func() {
		defer s.work.Done()
		renewWhenDue(s.alive, config.Token, config.Timing, func() { s.renew(config.Token.Value()) })
	}()
	go func() {
		defer s.work.Done()
		s.renewWhenUnanswered()
	}()
	go func() {
		defer s.work.Done()
		defer s.markReady()
		s.start(kept, has, keepsKept && config.Validate != nil)
	}()
	return s, nil
}

func (s *Session) markReady() { s.once.Do(func() { close(s.ready) }) }

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

// Errors is the session's one stream of what went wrong: its own failures
// (a *SessionError) and its client's transport's (a *TransportError), each
// said once. Its first reader is given everything said since the session was
// made, and every later one what is said from then on; saying never waits for
// a reader. It ends when the session ends (Close). Whoever ends both closes
// the client first, so what the client's closing flush meets is said before
// it ends; what the client meets once the session has ended is said nowhere.
// A host routes them: a refusal for want of a valid token is a reason to
// Refresh.
func (s *Session) Errors() iter.Seq[Error] { return s.failures.failures() }

// carry says among the session's errors each failure the transport meets,
// until the transport closes. One met once the session has ended is said
// nowhere: the errors have ended. It is not the session's work, which Close
// waits for: the transport closes after the session.
func (s *Session) carry(transportFailures iter.Seq[*TransportError]) {
	for failure := range transportFailures {
		s.failures.report(failure)
	}
}

// ExpiresAt is when the token the session holds expires; false when it holds
// none, or the token names no time.
func (s *Session) ExpiresAt() (time.Time, bool) {
	token := s.config.Token.Value()
	if token == "" {
		return time.Time{}, false
	}
	return TokenExpiry(token)
}

// Close ends the session: it renews nothing more and asks nobody anything,
// its token and who is signed in change no more, its errors end once what it
// was running has said what it met, and it returns then. Closing twice is
// closing once. Its client is left to whoever made it, who closes it first.
func (s *Session) Close() {
	s.cancel()
	s.markReady()
	s.work.Wait()
	s.config.Token.End()
	s.user.End()
	s.failures.close()
}

// Refresh answers the gateway's refusal of refused, the session's token: it
// renews the token and asks the gateway who the new one is. It gives the
// token the session then holds; false when it holds none, and if the issuer
// refused to renew a kept sign-in it is over. A token the session no longer
// holds was answered
// already, renewed or ended: what the session holds is given, and nothing is
// renewed or asked. So however many requests were refused one token, at once
// or one after another, they cost one renewal and one ask, and who the gateway
// says the renewed token is, is who is signed in. A refusal met while the
// session is starting waits for the start, which answers it. A gateway
// that cannot be asked refuses nothing: the renewed token is given.
//
// The wait and the renewal run under the session's own lifetime, not ctx: a
// refresh token spent at the issuer is not left without the token it bought.
func (s *Session) Refresh(_ context.Context, refused string) (string, bool) {
	<-s.ready
	s.answering.Lock()
	defer s.answering.Unlock()
	if current := s.config.Token.Value(); current != refused {
		return current, current != ""
	}
	renewed, ok := s.renew(refused)
	if !ok || s.config.Validate == nil {
		return renewed, ok
	}
	user, err := s.config.Validate(s.alive, renewed)
	// Only a token the session still holds is its to be refused, or to say
	// who it is: one replaced while the gateway was being asked is not.
	held := !s.closing() && s.config.Token.Value() == renewed
	if err != nil {
		// A gateway that could not be asked refused nothing.
		var refused *TransportError
		if errors.As(err, &refused) && refused.Code == TransportErrorCodeUnauthorized && held {
			s.signedOut(SessionEndRefused, &SessionError{Code: SessionErrorCodeCredentialRefused, Message: justIssuedAndRefused, KbID: s.config.Kb.Id})
		}
	} else if held {
		s.user.Set(&user)
	}
	if s.closing() {
		return "", false
	}
	current := s.config.Token.Value()
	return current, current != ""
}

// tryRefresh asks Refresh to renew holding, the token the session holds: the
// token, or "" and why there is none. A renewal that could not be made and one
// that was refused both leave the session without a token.
func (s *Session) tryRefresh(holding string) (string, error) {
	if s.config.Refresh == nil {
		return "", nil
	}
	renewed, err := s.config.Refresh(s.alive, s.renewing(holding))
	if err != nil {
		return "", err
	}
	return renewed, nil
}

// renewing is the token a renewal of holding is handed, and remembers it:
// holding, or, while the session holds none, the token it last handed a
// renewal. A renewal that got no answer leaves the session holding none, and
// the next is handed the token that one was for: handed none, what keeps the
// sign-in gives back a kept token that has not expired without asking the
// issuer, which after a refusal is the token the gateway refused.
func (s *Session) renewing(holding string) string {
	s.renewedMu.Lock()
	defer s.renewedMu.Unlock()
	if holding != "" {
		s.renewed = holding
	}
	return s.renewed
}

// renew renews renewing, the session's token, at the issuer, with nobody asked
// afterwards: what the session does on its own schedule.
func (s *Session) renew(renewing string) (string, bool) {
	if s.closing() || s.config.Refresh == nil {
		return "", false
	}
	renewed, failure := s.tryRefresh(renewing)
	if s.closing() {
		return "", false
	}
	if renewed != "" {
		s.unanswered.Set(false)
		s.config.Token.Set(renewed)
		return renewed, true
	}
	s.config.Token.Set("")
	// A session that never had a credential cannot expire: it is signed out,
	// which is no failure. One whose store cannot say whether it has one got
	// no answer, and keeps what may be there.
	switch _, held, err := s.config.Kept.Held(s.alive); {
	case err != nil && failure == nil:
		s.unrenewed(err)
	case err != nil || held:
		s.unrenewed(failure)
	default:
		s.unanswered.Set(false)
	}
	return "", false
}

// renewWhenUnanswered renews again, after a renewal that got no answer, on
// the reconnect backoff: each wait is the equal jitter of its step, the step
// Reconnect doubling to MaxReconnect. It stops when a renewal is made or
// refused, when a token arrives some other way, and when the session is
// closed. A renewal made while nobody has said who the session's token is
// asks the gateway once, as the start would have.
func (s *Session) renewWhenUnanswered() {
	for {
		owed, changed := s.unanswered.watch()
		if !owed {
			select {
			case <-s.alive.Done():
				return
			case <-changed:
				continue
			}
		}
		step := s.config.Timing.Reconnect
		for s.unanswered.Value() {
			timer := time.NewTimer(EqualJitter(step, s.config.Random))
			select {
			case <-s.alive.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			switch {
			case s.config.Token.Value() != "":
				s.unanswered.Set(false)
			case !s.unanswered.Value():
			case s.user.Value() == nil:
				s.Refresh(s.alive, "")
			default:
				s.renew("")
			}
			step = min(2*step, s.config.Timing.MaxReconnect)
		}
	}
}

// unrenewed is a renewal of what is kept that gave no token: the session holds
// none. The issuer's refusal, or nothing left to renew with, ends the session;
// any other failure keeps what is kept, and says why: the next refusal renews
// again, and so does the reconnect backoff.
func (s *Session) unrenewed(failure error) {
	s.config.Token.Set("")
	err := &SessionError{Code: SessionErrorCodeRefreshExhausted, Message: notRenewed(failure), KbID: s.config.Kb.Id}
	if failure != nil && !refusedRenewal(failure) {
		s.unanswered.Set(true)
		s.failed(err)
		return
	}
	s.signedOut(SessionEndExpired, err)
}

// signedOut is the session's end, whichever way it ended: its credential is
// forgotten, and its host is told why.
func (s *Session) signedOut(told SessionEndReason, err *SessionError) {
	s.unanswered.Set(false)
	s.config.Token.Set("")
	s.user.Set(nil)
	if forgotten := s.config.Kept.Forget(s.alive); forgotten != nil {
		err = notForgotten(err, forgotten)
	}
	if s.config.OnAuthFailed != nil {
		s.config.OnAuthFailed(told)
	}
	s.failed(err)
}

// notForgotten is err, saying too why the sign-in could not be forgotten.
func notForgotten(err *SessionError, forgotten error) *SessionError {
	return &SessionError{Code: err.Code, Message: err.Message + "; and the sign-in could not be forgotten: " + forgotten.Error(), KbID: err.KbID}
}

// failed says err among the session's errors.
func (s *Session) failed(err *SessionError) { s.failures.report(err) }

// start is what a session does at its start, with the sign-in it found kept.
// It renews one that has expired, then asks the gateway who it is. A token
// the gateway refuses is renewed once and asked about once more; a token the
// issuer has just issued and the gateway refuses is final. Refresh waits for
// it, so no refusal is answered while it asks and renews: no token it asks
// about is renewed in answer to one, and a refusal met meanwhile is answered
// by what it did. withheld is whether the kept token is the session's and not
// yet the transport's: it is the transport's once the gateway has not refused
// it.
func (s *Session) start(kept HeldSignIn, has, withheld bool) {
	if !has {
		return
	}
	justIssued := IsTokenExpired(kept.Access, time.Now())
	token := kept.Access
	if justIssued {
		renewed, failure := s.tryRefresh(token)
		if renewed == "" {
			switch {
			case s.closing():
			case failure == nil || refusedRenewal(failure):
				// There was no session to end: the sign-in is forgotten, and
				// nothing is said unless it could not be.
				if forgotten := s.config.Kept.Forget(s.alive); forgotten != nil {
					s.failed(notForgotten(&SessionError{Code: SessionErrorCodeRefreshExhausted, Message: notRenewed(failure), KbID: s.config.Kb.Id}, forgotten))
				}
			default:
				// The issuer did not refuse it: the sign-in is kept, and
				// renewed on the reconnect backoff or when a request is
				// refused.
				s.unanswered.Set(true)
				s.failed(&SessionError{Code: SessionErrorCodeAuthFailed, Message: notRenewed(failure), KbID: s.config.Kb.Id})
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
		held := s.config.Token.Value()
		user, err := s.config.Validate(s.alive, token)
		if s.closing() {
			return
		}
		var refused *TransportError
		if errors.As(err, &refused) && refused.Code == TransportErrorCodeUnauthorized {
			next, goOn := s.answerAtStart(token, held, justIssued)
			if !goOn {
				return
			}
			token, justIssued, withheld = next, true, false
			continue
		}
		if withheld {
			s.config.Token.Set(token)
		}
		if err != nil {
			s.failed(&SessionError{Code: SessionErrorCodeAuthFailed, Message: err.Error(), KbID: s.config.Kb.Id})
			return
		}
		s.user.Set(&user)
		return
	}
}

// answerAtStart answers the gateway's refusal of token at the session's
// start, asked while the session held held: the just-issued token to ask
// about next, given to the transport, or false when there is none.
func (s *Session) answerAtStart(token, held string, justIssued bool) (string, bool) {
	if justIssued {
		s.signedOut(SessionEndRefused, &SessionError{Code: SessionErrorCodeCredentialRefused, Message: justIssuedAndRefused, KbID: s.config.Kb.Id})
		return "", false
	}
	// The session's token changed while the gateway was asked: it fell due
	// and was renewed on the session's schedule. A token it was renewed to is
	// the just-issued one, and is not renewed again; none is a session that
	// renewal ended.
	if current := s.config.Token.Value(); current != held {
		return current, current != ""
	}
	renewed, failure := s.tryRefresh(token)
	if s.closing() {
		return "", false
	}
	if renewed == "" {
		s.unrenewed(failure)
		return "", false
	}
	s.config.Token.Set(renewed)
	return renewed, true
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
			if delay, ok := RefreshDelay(current, time.Now(), timing); ok {
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
