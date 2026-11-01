package semiont_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
)

// A refusal whose body is begun and never finished is reported once
// HttpRequestTimeout has passed, with none of the gateway's words.
func TestARefusalWhoseBodyNeverEndsIsReportedAtTheRequestDeadline(t *testing.T) {
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Length", "100")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"ne`))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer gateway.Close()
	ctx, abandon := context.WithCancel(context.Background())
	defer abandon()
	timing := semiont.DefaultTiming()
	timing.HttpRequestTimeout = 200 * time.Millisecond
	transport := semiont.NewHTTPTransport(semiont.HTTPTransportConfig{BaseURL: gateway.URL, Token: semiont.NewVariable(""), HTTP: &http.Client{}, Timing: timing})
	defer transport.Close()

	answered := make(chan error, 1)
	go func() {
		_, err := transport.GetCurrentUser(ctx)
		answered <- err
	}()
	select {
	case err := <-answered:
		var refused *semiont.TransportError
		if !errors.As(err, &refused) {
			t.Fatalf("the refusal is %v", err)
		}
		if status, ok := refused.Status(); refused.Message != "HTTP 404: Not Found" || !ok || status != http.StatusNotFound {
			t.Errorf("the refusal is heard as %q, %d (%v)", refused.Message, status, ok)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a refusal whose body never ends is waited on past the request deadline")
	}
}
