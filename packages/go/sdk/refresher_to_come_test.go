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

// renewsRefused is a refresher that renews the token refused to that token
// with "-renewed" after it.
type renewsRefused struct{}

func (renewsRefused) Refresh(_ context.Context, refused string) (string, bool) {
	return refused + "-renewed", true
}

func TestARefusalBeforeItsSessionIsMadeWaitsForTheSession(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		toCome := newRefresherToCome()
		answered := make(chan string, 1)
		go func() {
			token, _ := toCome.Refresh(context.Background(), "refused")
			answered <- token
		}()
		synctest.Wait()
		select {
		case token := <-answered:
			t.Fatalf("answered %q before the session was made", token)
		default:
		}
		toCome.is(renewsRefused{})
		if token := <-answered; token != "refused-renewed" {
			t.Errorf("answered %q, not the session's renewal of the token refused", token)
		}
	})
}

func TestARefusalWhoseStreamEndsBeforeASessionIsMadeIsGivenNoToken(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		stream, end := context.WithCancel(context.Background())
		toCome := newRefresherToCome()
		answered := make(chan bool, 1)
		go func() {
			_, ok := toCome.Refresh(stream, "refused")
			answered <- ok
		}()
		synctest.Wait()
		end()
		if ok := <-answered; ok {
			t.Error("a refusal with no session to come was given a token")
		}
	})
}
