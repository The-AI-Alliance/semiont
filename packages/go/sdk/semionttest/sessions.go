package semionttest

// A registry.SessionFactory for tests of a registry and of what is built on
// one. Each session it builds is a real semiont.Session over a
// FaultyTransport of its own, and the factory keeps every transport it built,
// by knowledge base.
//
// A test scripts three things: what each knowledge base's gateway answers,
// who the gateway says a token is, and what a renewal gives. Each refuses by
// name until it is scripted: an unscripted request names its operation and
// its knowledge base, an unscripted renewal is a renewal that failed, and a
// gateway nobody scripted a user for cannot say who a token is.

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"sync"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/registry"
)

// Answer is what a knowledge base's gateway answers a request with: its
// response, nil for a reply that carries none, or a refusal with why. It is
// given the knowledge base's id, the operation and the payload.
type Answer func(kbID string, operation bus.Channel, payload json.RawMessage) (json.RawMessage, error)

// Refusal is the failure a knowledge base's gateway answers a request with,
// when it answers it with one: the payload of the operation's failure
// channel; nil when it answers with none.
type Refusal func(kbID string, operation bus.Channel, payload json.RawMessage) json.RawMessage

// Renewal is what one renewal gives: a token, nothing (both fields "") for a
// session that has nothing to renew with, or why it failed.
type Renewal struct {
	Token string
	Why   string
}

// ScriptedSessions is a SessionFactory of sessions over scripted transports:
// see the file's documentation.
type ScriptedSessions struct {
	answer Answer

	mu             sync.Mutex
	refuse         Refusal
	refusesToBuild string
	user           *api.UserResponse
	answersAfter   time.Duration
	renewals       []Renewal
	renewed        int
	built          []builtFor
	revoked        []registry.StoredSession
}

type builtFor struct {
	kbID      string
	transport *FaultyTransport
}

var _ registry.SessionFactory = (*ScriptedSessions)(nil)

// NewScriptedSessions is sessions of knowledge bases whose gateways answer as
// answer says. With none, every request is refused, naming its operation and
// its knowledge base.
func NewScriptedSessions(answer Answer) *ScriptedSessions {
	if answer == nil {
		answer = refuseUnscripted
	}
	return &ScriptedSessions{answer: answer}
}

// refuseUnscripted is what answers a request of a knowledge base nothing was
// scripted for: a refusal naming both, never a response made up.
func refuseUnscripted(kbID string, operation bus.Channel, _ json.RawMessage) (json.RawMessage, error) {
	return nil, &semiont.TransportError{
		Code:    semiont.TransportErrorCodeError,
		Message: fmt.Sprintf("No response scripted for %q of knowledge base %q. Build the factory with an Answer.", operation, kbID),
	}
}

// RefuseWhen has a gateway answer with a failure every request refuse gives
// one for, before it is asked for an answer. Sessions already built refuse so
// too.
func (s *ScriptedSessions) RefuseWhen(refuse Refusal) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refuse = refuse
}

// RefuseToBuild refuses to build any session, saying why; "" builds again.
func (s *ScriptedSessions) RefuseToBuild(why string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refusesToBuild = why
}

// SaysWho is who the gateway says a token is, of every session built from
// now.
func (s *ScriptedSessions) SaysWho(user api.UserResponse) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.user = &user
}

// AnswersAfter is how long the gateway takes to say who a token is, of every
// session built from now.
func (s *ScriptedSessions) AnswersAfter(wait time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.answersAfter = wait
}

// QueueRenewals is what the next renewals give, one each, in order.
func (s *ScriptedSessions) QueueRenewals(renewals ...Renewal) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.renewals = append(s.renewals, renewals...)
}

// Renewed is how many renewals were asked for.
func (s *ScriptedSessions) Renewed() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.renewed
}

// Transports is the transports of the sessions built for a knowledge base,
// in the order they were built.
func (s *ScriptedSessions) Transports(kbID string) []*FaultyTransport {
	s.mu.Lock()
	defer s.mu.Unlock()
	var transports []*FaultyTransport
	for _, built := range s.built {
		if built.kbID == kbID {
			transports = append(transports, built.transport)
		}
	}
	return transports
}

// Revoked is every stored session the factory was told to revoke, in order.
func (s *ScriptedSessions) Revoked() []registry.StoredSession {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.revoked)
}

func (s *ScriptedSessions) Session(ctx context.Context, options registry.SessionFactoryOptions) (*semiont.Session, func(), error) {
	kbID := options.Kb.Id
	s.mu.Lock()
	why := s.refusesToBuild
	s.mu.Unlock()
	if why != "" {
		return nil, nil, &semiont.SessionError{Code: semiont.SessionErrorCodeConstructFailed, Message: why, KbID: kbID}
	}

	transport := NewFaultyTransport(FaultyConfig{MakeResponse: func(operation bus.Channel, payload json.RawMessage) (json.RawMessage, error) {
		return s.answer(kbID, operation, payload)
	}})
	transport.RefuseWhen(func(operation bus.Channel, payload json.RawMessage) json.RawMessage {
		s.mu.Lock()
		refuse := s.refuse
		s.mu.Unlock()
		if refuse == nil {
			return nil
		}
		return refuse(kbID, operation, payload)
	})
	client := NewTestClient(TestClientConfig{Transport: transport, Timing: semiont.DefaultTiming()}).Client

	s.mu.Lock()
	s.built = append(s.built, builtFor{kbID: kbID, transport: transport})
	user, answersAfter := s.user, s.answersAfter
	s.mu.Unlock()

	session, err := semiont.StartSession(ctx, semiont.SessionConfig{
		Kb:     api.KbTarget{Endpoint: options.Kb.Endpoint, Id: kbID, Label: options.Kb.Label},
		Client: client,
		Token:  semiont.NewVariable(""),
		Kept:   registry.KeptIn(options.Storage, kbID),
		Refresh: func(context.Context) (string, error) {
			s.mu.Lock()
			defer s.mu.Unlock()
			s.renewed++
			if len(s.renewals) == 0 {
				return "", &semiont.SignInError{Code: semiont.SignInErrorCodeExchange, Message: fmt.Sprintf("ScriptedSessions: not scripted: a renewal of %q. Script one with QueueRenewals.", kbID)}
			}
			renewal := s.renewals[0]
			s.renewals = s.renewals[1:]
			if renewal.Why != "" {
				return "", &semiont.SignInError{Code: semiont.SignInErrorCodeExchange, Message: renewal.Why}
			}
			return renewal.Token, nil
		},
		Validate: func(ctx context.Context, _ string) (api.UserResponse, error) {
			select {
			case <-time.After(answersAfter):
			case <-ctx.Done():
				return api.UserResponse{}, ctx.Err()
			}
			if user == nil {
				return api.UserResponse{}, &semiont.TransportError{Code: semiont.TransportErrorCodeError, Message: fmt.Sprintf("ScriptedSessions: not scripted: who a token of %q is. Script it with SaysWho.", kbID)}
			}
			return *user, nil
		},
		OnAuthFailed: options.Signals.NotifySessionEnded,
		OnError:      options.OnError,
		Timing:       semiont.DefaultTiming(),
	})
	if err != nil {
		client.Close()
		transport.Close()
		return nil, nil, err
	}
	end := func() {
		session.Close()
		client.Close()
		transport.Close()
	}
	return session, end, nil
}

func (s *ScriptedSessions) Revoke(_ context.Context, stored registry.StoredSession) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.revoked = append(s.revoked, stored)
}
