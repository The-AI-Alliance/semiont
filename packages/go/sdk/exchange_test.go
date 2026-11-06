package semiont_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync"
	"testing"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
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

// uploadGateway answers the uploads it is sent with its answers, in turn, and
// keeps each one's Idempotency-Key and body. An upload past its answers is one
// too many.
type uploadGateway struct {
	*httptest.Server
	mu      sync.Mutex
	answers []func(http.ResponseWriter, *http.Request)
	keys    []string
	bodies  [][]byte
}

func newUploadGateway(t *testing.T, answers ...func(http.ResponseWriter, *http.Request)) *uploadGateway {
	g := &uploadGateway{answers: answers}
	g.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/resources" {
			t.Errorf("%s %s is not an upload", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("an upload's body did not arrive whole: %v", err)
			return
		}
		g.mu.Lock()
		g.keys = append(g.keys, r.Header.Get("Idempotency-Key"))
		g.bodies = append(g.bodies, body)
		made := len(g.keys)
		var answer func(http.ResponseWriter, *http.Request)
		if made <= len(g.answers) {
			answer = g.answers[made-1]
		}
		g.mu.Unlock()
		if answer == nil {
			t.Errorf("upload %d arrived; the gateway was to be sent %d", made, len(g.answers))
			refuse(http.StatusInternalServerError)(w, r)
			return
		}
		answer(w, r)
	}))
	t.Cleanup(g.Close)
	return g
}

// sent is each upload's Idempotency-Key and body, in the order they arrived.
func (g *uploadGateway) sent() (keys []string, bodies [][]byte) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return slices.Clone(g.keys), slices.Clone(g.bodies)
}

// refuse answers an upload with status.
func refuse(status int) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"error":"refused"}`))
	}
}

// create answers an upload with the resource it made.
func create(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_, _ = w.Write([]byte(`{"resourceId":"res-1"}`))
}

// hangUp closes an upload's connection, unanswered.
func hangUp(t *testing.T) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, _ *http.Request) {
		conn, _, err := http.NewResponseController(w).Hijack()
		if err != nil {
			t.Errorf("the connection cannot be closed unanswered: %v", err)
			return
		}
		_ = conn.Close()
	}
}

// hold takes an upload and answers nothing until its sender goes, saying on
// arrived that it came.
func hold(arrived chan<- struct{}) func(http.ResponseWriter, *http.Request) {
	return func(_ http.ResponseWriter, r *http.Request) {
		arrived <- struct{}{}
		<-r.Context().Done()
	}
}

// uploader is content over a transport to gateway, with a short wait before
// a resend.
func uploader(t *testing.T, gateway *uploadGateway) *semiont.HTTPContentTransport {
	timing := semiont.DefaultTiming()
	timing.RequestRetryPause = 10 * time.Millisecond
	transport := semiont.NewHTTPTransport(semiont.HTTPTransportConfig{BaseURL: gateway.URL, Token: semiont.NewVariable("a-token"), HTTP: &http.Client{Transport: &http.Transport{}}, Timing: timing})
	t.Cleanup(transport.Close)
	return semiont.NewHTTPContentTransport(transport)
}

func anUpload() semiont.PutBinaryRequest {
	return semiont.PutBinaryRequest{Name: "notes.txt", Bytes: []byte("hello"), Format: "text/plain", StorageURI: "file://notes.txt"}
}

// waitFor is what upload is answered, within ten seconds.
func waitFor(t *testing.T, upload *semiont.Upload) (api.CreateResourceResponse, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return upload.Wait(ctx)
}

// sentTwiceWithOneKey fails t unless the gateway was sent the upload twice,
// with one Idempotency-Key and one body.
func sentTwiceWithOneKey(t *testing.T, gateway *uploadGateway) {
	t.Helper()
	keys, bodies := gateway.sent()
	if len(keys) != 2 || keys[0] == "" || keys[1] != keys[0] {
		t.Fatalf("the attempts carried the Idempotency-Keys %q, want one key on two attempts", keys)
	}
	if !bytes.Equal(bodies[1], bodies[0]) {
		t.Errorf("the attempts' bodies differ:\n%s\n%s", bodies[0], bodies[1])
	}
}

// A keyed upload answered 503 is sent once more, with the same key, bytes and
// fields, and resolves with what that attempt is answered.
func TestAnUploadAnsweredUnavailableIsSentOnceMore(t *testing.T) {
	gateway := newUploadGateway(t, refuse(http.StatusServiceUnavailable), create)
	created, err := waitFor(t, uploader(t, gateway).PutBinary(context.Background(), anUpload()))
	if err != nil {
		t.Fatalf("the upload sent once more failed: %v", err)
	}
	if created.ResourceId.String() != "res-1" {
		t.Errorf("the upload created %q", created.ResourceId)
	}
	sentTwiceWithOneKey(t, gateway)
}

// A keyed upload whose connection closed before any answer is sent once
// more, and resolves.
func TestAnUploadThatGotNoAnswerIsSentOnceMore(t *testing.T) {
	gateway := newUploadGateway(t, hangUp(t), create)
	created, err := waitFor(t, uploader(t, gateway).PutBinary(context.Background(), anUpload()))
	if err != nil {
		t.Fatalf("the upload sent once more failed: %v", err)
	}
	if created.ResourceId.String() != "res-1" {
		t.Errorf("the upload created %q", created.ResourceId)
	}
	sentTwiceWithOneKey(t, gateway)
}

// An upload refused 400 or 422 would be refused again, so it is not sent
// again, and fails under the code its status has.
func TestARefusedUploadIsNotSentAgain(t *testing.T) {
	for _, refusal := range []struct {
		status int
		code   semiont.TransportErrorCode
	}{
		{http.StatusBadRequest, semiont.TransportErrorCodeBadRequest},
		{http.StatusUnprocessableEntity, semiont.TransportErrorCodeUnprocessable},
	} {
		t.Run(http.StatusText(refusal.status), func(t *testing.T) {
			gateway := newUploadGateway(t, refuse(refusal.status))
			_, err := waitFor(t, uploader(t, gateway).PutBinary(context.Background(), anUpload()))
			var refused *semiont.TransportError
			if !errors.As(err, &refused) || refused.Code != refusal.code {
				t.Errorf("the upload failed with %v, want the code %q", err, refusal.code)
			}
			if keys, _ := gateway.sent(); len(keys) != 1 {
				t.Errorf("the upload was sent %d times, want once", len(keys))
			}
		})
	}
}

// An upload its caller abandons while the gateway holds it is not sent
// again, though its connection closed unanswered.
func TestAnAbandonedUploadIsNotSentAgain(t *testing.T) {
	arrived := make(chan struct{}, 1)
	gateway := newUploadGateway(t, hold(arrived))
	ctx, abandon := context.WithCancel(context.Background())
	defer abandon()
	upload := uploader(t, gateway).PutBinary(ctx, anUpload())
	select {
	case <-arrived:
	case <-time.After(10 * time.Second):
		t.Fatal("the upload never arrived")
	}
	abandon()
	if _, err := waitFor(t, upload); !errors.Is(err, context.Canceled) {
		t.Errorf("the abandoned upload failed with %v, want its caller's cancellation", err)
	}
	if keys, _ := gateway.sent(); len(keys) != 1 {
		t.Errorf("the abandoned upload was sent %d times, want once", len(keys))
	}
}

// An upload is sent once more at most. Answered 503, then closed unanswered
// on the connection the first attempt left open, it fails as unanswered after
// two attempts. net/http sends a keyed request again by itself on a reused
// connection the server closed, when it can rewind the body; it makes no
// third attempt here.
func TestAnUploadIsSentOnceMoreAtMost(t *testing.T) {
	gateway := newUploadGateway(t, refuse(http.StatusServiceUnavailable), hangUp(t))
	_, err := waitFor(t, uploader(t, gateway).PutBinary(context.Background(), anUpload()))
	var unanswered *semiont.TransportError
	if !errors.As(err, &unanswered) || unanswered.Code != semiont.TransportErrorCodeUnavailable {
		t.Errorf("the upload failed with %v, want it unavailable", err)
	}
	sentTwiceWithOneKey(t, gateway)
}
