package semiont

// The gateway's own operations: its liveness, where a success status is alive
// and the body is detail; and a transport held only for them opens no stream.

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func healthOf(t *testing.T, serve http.HandlerFunc) (report string, ok bool, err error) {
	t.Helper()
	gateway := httptest.NewServer(serve)
	defer gateway.Close()
	asker := NewHTTPTransport(HTTPTransportConfig{BaseURL: gateway.URL, Token: NewVariable(""), HTTP: &http.Client{}, Timing: quickTiming()})
	defer asker.Close()
	health, ok, err := asker.HealthCheck(context.Background())
	return health.Status, ok, err
}

func TestAServingGatewayIsAliveAndReportsItself(t *testing.T) {
	status, ok, err := healthOf(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/health" {
			t.Errorf("asked %s", r.URL.Path)
		}
		writeJSON(w, http.StatusOK, map[string]any{"status": "operational", "version": "0.7.0", "timestamp": "2026-10-26T00:00:00.000Z"})
	})
	if err != nil || !ok || status != "operational" {
		t.Errorf("got %q, %v, %v", status, ok, err)
	}
}

// A gateway that answers with a failure status is down, and says which.
func TestAGatewayThatAnswersAFailureIsDown(t *testing.T) {
	_, _, err := healthOf(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNotImplemented) })
	var refused *TransportError
	if !errors.As(err, &refused) {
		t.Fatalf("a failure status read as alive (%v)", err)
	}
	if status, ok := refused.Status(); !ok || status != http.StatusNotImplemented {
		t.Errorf("the failure says %d (%v)", status, ok)
	}
}

// A success whose body does not read is a live gateway behind a schema this
// client does not know: alive, with no report.
func TestASuccessWithABodyThatDoesNotReadIsAlive(t *testing.T) {
	_, ok, err := healthOf(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("<html>ok</html>"))
	})
	if err != nil || ok {
		t.Errorf("got ok %v, err %v; want alive with no report", ok, err)
	}
}

// A transport that carries nothing opens no stream, token or not: asking who
// a token is, or how the gateway is, makes no request of the bus.
func TestATransportThatCarriesNothingOpensNoStream(t *testing.T) {
	var subscribed atomic.Int32
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/bus/subscribe":
			subscribed.Add(1)
			w.WriteHeader(http.StatusOK)
		case "/api/users/me":
			writeJSON(w, http.StatusOK, map[string]any{"did": "did:web:example.org:users:alice", "email": "a@example.com", "domain": "example.org", "name": nil, "image": nil})
		default:
			http.NotFound(w, r)
		}
	}))
	defer gateway.Close()
	asker := NewHTTPTransport(HTTPTransportConfig{BaseURL: gateway.URL, Token: NewVariable(signedToken(1)), HTTP: &http.Client{}, Timing: quickTiming()})
	user, err := asker.GetCurrentUser(context.Background())
	time.Sleep(100 * time.Millisecond)
	asker.Close()
	if err != nil || user.Email != "a@example.com" {
		t.Fatalf("asked who the token is: %v", err)
	}
	if n := subscribed.Load(); n != 0 {
		t.Errorf("a transport with no channel opened %d stream(s)", n)
	}
}
