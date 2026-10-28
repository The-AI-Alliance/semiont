package semiont

// A transport is built before the session that renews its token, and the
// session sends that token before it is returned. A refusal that arrives in
// between waits for the session and is answered by it; one whose stream ends
// first, because no session was made, is given no token.

import (
	"context"
	"testing"
	"testing/synctest"
)

// renewsTo is a refresher that always renews to the same token.
type renewsTo string

func (r renewsTo) Refresh(context.Context) (string, bool) { return string(r), true }

func TestARefusalBeforeItsSessionIsMadeWaitsForTheSession(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		toCome := newRefresherToCome()
		answered := make(chan string, 1)
		go func() {
			token, _ := toCome.Refresh(context.Background())
			answered <- token
		}()
		synctest.Wait()
		select {
		case token := <-answered:
			t.Fatalf("answered %q before the session was made", token)
		default:
		}
		toCome.is(renewsTo("renewed"))
		if token := <-answered; token != "renewed" {
			t.Errorf("answered %q, not the session's renewal", token)
		}
	})
}

func TestARefusalWhoseStreamEndsBeforeASessionIsMadeIsGivenNoToken(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		stream, end := context.WithCancel(context.Background())
		toCome := newRefresherToCome()
		answered := make(chan bool, 1)
		go func() {
			_, ok := toCome.Refresh(stream)
			answered <- ok
		}()
		synctest.Wait()
		end()
		if ok := <-answered; ok {
			t.Error("a refusal with no session to come was given a token")
		}
	})
}
