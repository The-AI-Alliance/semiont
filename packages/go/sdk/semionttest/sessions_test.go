package semionttest_test

// The doubles a consumer's registry and sessions are tested with: a test
// session, and a factory of scripted sessions.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/registry"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/semionttest"
)

// goodToken is a token that is good for an hour.
func goodToken() string {
	claims, _ := json.Marshal(map[string]int64{"exp": time.Now().Add(time.Hour).Unix()})
	return base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`)) + "." + base64.RawURLEncoding.EncodeToString(claims) + ".sig"
}

// ── A session ───────────────────────────────────────────────────────────

func TestATestSessionIsReadyAtOnceAndSignedInAsNobody(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		test, err := semionttest.NewTestSession(semionttest.TestSessionConfig{})
		if err != nil {
			t.Fatal(err)
		}
		defer test.Transport.Close()
		defer test.Client.Close()
		defer test.Session.Close()

		ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
		defer cancel()
		if err := test.Session.Ready(ctx); err != nil {
			t.Fatal("it is not ready at once")
		}
		if test.Session.Token().Value() != "" || test.Session.User().Value() != nil {
			t.Error("a test session holds a token, or knows who it is")
		}
		if kb := test.Session.Kb(); kb.Id != "test-kb" || kb.Label != "Test KB" {
			t.Errorf("the session is with %+v", kb)
		}
		// Its client is the one that came back, over the transport that did.
		if test.Session.Client() != test.Client {
			t.Error("the session's client is not the one given back")
		}
		if _, err := test.Client.Browse.Kb(context.Background()); err == nil {
			t.Error("a request nothing was scripted for was answered")
		}
		if logged := len(test.Transport.RequestLog()); logged != 1 {
			t.Errorf("the transport was sent %d requests", logged)
		}
	})
}

func TestATestSessionHoldsTheTokenItsSignInHeldAndThenTheOneTheTestSets(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var at api.KbEndpoint
		if err := at.FromHttpEndpoint(api.HttpEndpoint{Kind: api.HttpEndpointKindHttp, Host: "example.org", Port: 443, Protocol: api.HttpEndpointProtocolHttps}); err != nil {
			t.Fatal(err)
		}
		kb := api.KbTarget{Id: "mine", Label: "Mine", Endpoint: at}
		stored := goodToken()
		kept := &semiont.MemorySignIn{}
		if err := kept.Keep(context.Background(), semiont.HeldSignIn{Access: stored, Refresh: "r", ClientID: "semiont-cli", TokenEndpoint: "https://issuer.test/token"}); err != nil {
			t.Fatal(err)
		}

		test, err := semionttest.NewTestSession(semionttest.TestSessionConfig{Kb: &kb, Kept: kept})
		if err != nil {
			t.Fatal(err)
		}
		if err := test.Session.Ready(context.Background()); err != nil {
			t.Fatal(err)
		}

		if test.Session.Kb().Id != "mine" || test.Kept != kept || test.Session.Token().Value() != stored {
			t.Error("the session is not over what it was given")
		}
		// Nobody is asked who it is: no gateway was scripted to say.
		if test.Session.User().Value() != nil {
			t.Error("the session knows who it is")
		}
		test.Token.Set("another")
		if test.Session.Token().Value() != "another" {
			t.Error("the token the test set is not the session's")
		}

		// The session only uses the client: the test, which built both, closes it.
		test.Session.Close()
		test.Client.Close()
		test.Transport.Close()
		if test.Transport.State().Value() != semiont.ConnectionStateClosed {
			t.Error("the transport is not closed")
		}
	})
}

// ── Scripted sessions ───────────────────────────────────────────────────

func alice() api.UserResponse {
	var user api.UserResponse
	if err := json.Unmarshal([]byte(`{"did":"did:web:example.org:users:alice","email":"alice@example.org","name":"Alice","image":null,"domain":"example.org"}`), &user); err != nil {
		panic(err)
	}
	return user
}

func knowledgeBase(kbID string) api.KnowledgeBase {
	var at api.KbEndpoint
	if err := at.FromHttpEndpoint(api.HttpEndpoint{Kind: api.HttpEndpointKindHttp, Host: "localhost", Port: 4000, Protocol: api.HttpEndpointProtocolHttp}); err != nil {
		panic(err)
	}
	return api.KnowledgeBase{Id: kbID, Label: kbID, Did: "did:web:example.org:" + kbID, Endpoint: at}
}

// asked is what a registry asks a factory with, and what the sessions it
// built said.
type asked struct {
	storage *semiont.MemoryStorage
	signals *semiont.SessionSignals
	mu      sync.Mutex
	said    []*semiont.SessionError
}

func newAsked() *asked {
	return &asked{storage: semiont.NewMemoryStorage(), signals: semiont.NewSessionSignals()}
}

func (a *asked) of(kbID string) registry.SessionFactoryOptions {
	return registry.SessionFactoryOptions{Kb: knowledgeBase(kbID), Storage: a.storage, Signals: a.signals, OnError: func(err *semiont.SessionError) {
		a.mu.Lock()
		defer a.mu.Unlock()
		a.said = append(a.said, err)
	}}
}

func (a *asked) signedIn(t *testing.T, kbID string) {
	t.Helper()
	if err := registry.StoreSession(a.storage, kbID, registry.StoredSession{Access: goodToken(), Refresh: "r", ClientID: "semiont-browser", TokenEndpoint: "https://issuer.test/token"}); err != nil {
		t.Fatal(err)
	}
}

func (a *asked) errors() []*semiont.SessionError {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]*semiont.SessionError(nil), a.said...)
}

// built is a session the factory built, ended when the test ends.
func built(t *testing.T, sessions *semionttest.ScriptedSessions, options registry.SessionFactoryOptions) *semiont.Session {
	t.Helper()
	session, end, err := sessions.Session(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(end)
	if err := session.Ready(context.Background()); err != nil {
		t.Fatal(err)
	}
	return session
}

func message(err error) string {
	var refused semiont.Error
	if errors.As(err, &refused) {
		return refused.Error()
	}
	return fmt.Sprint(err)
}

func TestScriptedSessionsAnswerWhatEachKnowledgeBaseWasToldToAndRefuseTheRestByName(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		sessions := semionttest.NewScriptedSessions(func(kbID string, operation bus.Channel, _ json.RawMessage) (json.RawMessage, error) {
			if kbID == "kb-a" && operation == "browse:kb-requested" {
				return json.RawMessage(`{"name":"A","domain":"a.example"}`), nil
			}
			return nil, fmt.Errorf("%s does not answer %s", kbID, operation)
		})
		a := newAsked()
		ofA, ofB := built(t, sessions, a.of("kb-a")), built(t, sessions, a.of("kb-b"))

		if said, err := ofA.Client().Browse.Kb(context.Background()); err != nil || said.Name != "A" {
			t.Errorf("A says %+v, %v", said, err)
		}
		if _, err := ofB.Client().Browse.Kb(context.Background()); err == nil || !strings.Contains(message(err), "kb-b does not answer browse:kb-requested") {
			t.Errorf("B: %v", err)
		}
		// Each session has a transport of its own, kept by knowledge base.
		if len(sessions.Transports("kb-a")) != 1 || len(sessions.Transports("kb-b")) != 1 || len(sessions.Transports("kb-a")[0].RequestLog()) != 1 || len(sessions.Transports("kb-c")) != 0 {
			t.Error("the transports kept are not one a session, by knowledge base")
		}

		// One built with nothing to answer refuses everything, naming both.
		silent := semionttest.NewScriptedSessions(nil)
		ofC := built(t, silent, a.of("kb-c"))
		if _, err := ofC.Client().Browse.Kb(context.Background()); err == nil || !strings.Contains(message(err), `No response scripted for "browse:kb-requested" of knowledge base "kb-c"`) {
			t.Errorf("C: %v", err)
		}

		// And a refusal a knowledge base was told to give is the one given.
		sessions.RefuseWhen(func(kbID string, operation bus.Channel, _ json.RawMessage) json.RawMessage {
			if kbID == "kb-a" && operation == "browse:kb-requested" {
				return json.RawMessage(`{"message":"it will not say"}`)
			}
			return nil
		})
		if _, err := ofA.Client().Browse.Kb(context.Background()); err == nil || !strings.Contains(message(err), "it will not say") {
			t.Errorf("A refusing: %v", err)
		}
	})
}

func TestScriptedSessionsSayWhoATokenIsOnlyWhenToldAndAfterAsLongAsTold(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		sessions := semionttest.NewScriptedSessions(nil)
		a := newAsked()
		a.signedIn(t, "kb-a")

		// Nobody said who: the session is ready, knows nobody, and says why.
		unnamed := built(t, sessions, a.of("kb-a"))
		if unnamed.User().Value() != nil {
			t.Error("a session nobody said who of knows who it is")
		}
		if said := a.errors(); len(said) != 1 || !strings.Contains(said[0].Message, `ScriptedSessions: not scripted: who a token of "kb-a" is`) {
			t.Errorf("said: %+v", said)
		}

		sessions.SaysWho(alice())
		sessions.AnswersAfter(2 * time.Second)
		started := time.Now()
		named := built(t, sessions, a.of("kb-a"))
		if elapsed := time.Since(started); elapsed != 2*time.Second {
			t.Errorf("it was ready after %v", elapsed)
		}
		if user := named.User().Value(); user == nil || user.Did != alice().Did {
			t.Errorf("the session says it is %+v", user)
		}
	})
}

func TestScriptedSessionsRenewAsToldInOrderAndRefuseARenewalNobodyScripted(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		sessions := semionttest.NewScriptedSessions(nil)
		sessions.SaysWho(alice())
		a := newAsked()
		a.signedIn(t, "kb-a")
		session := built(t, sessions, a.of("kb-a"))
		sessions.QueueRenewals(semionttest.Renewal{Token: "renewed"})

		if token, ok := session.Refresh(context.Background(), session.Token().Value()); !ok || token != "renewed" {
			t.Errorf("a renewal gives %q, %v", token, ok)
		}
		if sessions.Renewed() != 1 || a.signals.SessionEnded().Value() != nil {
			t.Error("the renewal was not one, or ended the session")
		}

		// A renewal nobody scripted is a renewal that failed, and says so: the
		// session ends as it does when its issuer cannot be reached.
		if token, ok := session.Refresh(context.Background(), session.Token().Value()); ok || token != "" {
			t.Errorf("an unscripted renewal gives %q, %v", token, ok)
		}
		if sessions.Renewed() != 2 {
			t.Errorf("%d renewals were asked for", sessions.Renewed())
		}
		mentioned := false
		for _, err := range a.errors() {
			mentioned = mentioned || strings.Contains(err.Message, `ScriptedSessions: not scripted: a renewal of "kb-a"`)
		}
		if !mentioned {
			t.Errorf("said: %+v", a.errors())
		}
		// The session says it is over through the signals the registry gave.
		if a.signals.SessionEnded().Value() == nil {
			t.Error("the session did not say it is over")
		}
	})
}

func TestScriptedSessionsCanRefuseToBuildAndKeepWhatWasRevoked(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		sessions := semionttest.NewScriptedSessions(nil)
		a := newAsked()

		sessions.RefuseToBuild("this knowledge base cannot be reached")
		_, _, err := sessions.Session(context.Background(), a.of("kb-a"))
		var refused *semiont.SessionError
		if !errors.As(err, &refused) || refused.Code != semiont.SessionErrorCodeConstructFailed || refused.Message != "this knowledge base cannot be reached" || refused.KbID != "kb-a" {
			t.Errorf("refused: %v", err)
		}
		if len(sessions.Transports("kb-a")) != 0 {
			t.Error("a session refused built a transport")
		}

		sessions.RefuseToBuild("")
		built(t, sessions, a.of("kb-a"))
		if len(sessions.Transports("kb-a")) != 1 {
			t.Error("no session was built once building was allowed again")
		}

		stored := registry.StoredSession{Access: "a", Refresh: "r", ClientID: "semiont-browser", TokenEndpoint: "https://issuer.test/token", RevocationEndpoint: "https://issuer.test/revoke"}
		sessions.Revoke(context.Background(), stored)
		if revoked := sessions.Revoked(); len(revoked) != 1 || revoked[0] != stored {
			t.Errorf("revoked: %+v", revoked)
		}
	})
}

// ── A storage several contexts share ────────────────────────────────────

func TestAContextHearsWhatAnotherWritesAndNotWhatItWritesItself(t *testing.T) {
	here := semionttest.NewSharedStorage()
	there := here.Context()
	var mu sync.Mutex
	var heard []string
	stop, ok := here.Subscribe(func(key, value string, has bool) {
		mu.Lock()
		defer mu.Unlock()
		heard = append(heard, fmt.Sprintf("%s=%s:%v", key, value, has))
	})
	if !ok {
		t.Fatal("a shared storage says no other context writes it")
	}

	if err := here.Set("a", "mine"); err != nil {
		t.Fatal(err)
	}
	if err := there.Set("a", "theirs"); err != nil {
		t.Fatal(err)
	}
	if err := there.Update("b", func(string, bool) (string, bool) { return "updated", true }); err != nil {
		t.Fatal(err)
	}
	if err := there.Delete("a"); err != nil {
		t.Fatal(err)
	}
	stop()
	if err := there.Set("c", "unheard"); err != nil {
		t.Fatal(err)
	}

	mu.Lock()
	defer mu.Unlock()
	want := []string{"a=theirs:true", "b=updated:true", "a=:false"}
	if fmt.Sprint(heard) != fmt.Sprint(want) {
		t.Errorf("heard %v", heard)
	}
	if value, _ := here.Get("b"); value != "updated" {
		t.Errorf("b is %q here", value)
	}
}
