package semiont_test

// A reply with a fault, a member it lacks or one that is malformed, is
// refused before it is decoded, wherever the fault is, as every SDK refuses
// it: over the bus, as a *TransportError coded error that says the payload is
// not its channel's and names the fault; over HTTP, as one that says the
// answer is not its declared body. A reply its transport refused fails its
// request at once, as one whose payload is not its channel's does.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/semionttest"
)

// aResource is a resource that states what its schema requires.
const aResource = `{"@context":"https://schema.org/","@id":"res-1","name":"A resource","representations":[{"mediaType":"text/plain"}]}`

// refusedAs holds that err is a *TransportError coded error whose message is
// said.
func refusedAs(t *testing.T, why string, err error, said string) {
	t.Helper()
	var refused *semiont.TransportError
	if !errors.As(err, &refused) {
		t.Errorf("%s: read, or failed as %v, and it has a fault", why, err)
		return
	}
	if refused.Code != semiont.TransportErrorCodeError || refused.Message != said {
		t.Errorf("%s: refused as %s %q, not as an error saying %q", why, refused.Code, refused.Message, said)
	}
}

// asked is the result of a browse:resource-requested whose reply's response
// is response.
func asked(t *testing.T, response string) (api.BrowseResourceResult, error) {
	t.Helper()
	transport := semionttest.NewFaultyTransport(semionttest.FaultyConfig{})
	transport.QueueReply(bus.BrowseResourceRequested.Request().Channel(), json.RawMessage(response))
	defer transport.Close()
	resource, err := api.ParseResourceId("res-1")
	if err != nil {
		t.Fatal(err)
	}
	return semiont.Request(context.Background(), semiont.NewWire(transport), bus.BrowseResourceRequested, api.BrowseResourceRequest{ResourceId: resource}, semiont.DefaultTiming().BusRequestTimeout)
}

func TestAReplyWithAFaultIsRefusedNamingIt(t *testing.T) {
	for _, c := range []struct{ why, response, said string }{
		{"no resource", `{"lastSequence":1}`, "it has no `response.resource`"},
		{"a resource that is null", `{"resource":null,"lastSequence":1}`, "it has no `response.resource`"},
		{"a resource with no name", `{"resource":{"@context":"https://schema.org/","@id":"res-1","representations":[]},"lastSequence":1}`, "it has no `response.resource.name`"},
		{"a resource with no representations", `{"resource":{"@context":"https://schema.org/","@id":"res-1","name":"A resource"},"lastSequence":1}`, "it has no `response.resource.representations`"},
		{
			"a representation listed with no media type",
			`{"resource":{"@context":"https://schema.org/","@id":"res-1","name":"A resource","representations":[{"mediaType":"text/plain"},{"storageUri":"file://a.txt"}]},"lastSequence":1}`,
			"it has no `response.resource.representations.mediaType`",
		},
		{
			"one representation, with no media type",
			`{"resource":{"@context":"https://schema.org/","@id":"res-1","name":"A resource","representations":{"storageUri":"file://a.txt"}},"lastSequence":1}`,
			"it has no `response.resource.representations.mediaType`",
		},
		{
			"an agent of the type the discriminator names, without what that type requires",
			`{"resource":{"@context":"https://schema.org/","@id":"res-1","name":"A resource","representations":[],"wasAttributedTo":{"@type":"Organization"}},"lastSequence":1}`,
			"it has no `response.resource.wasAttributedTo.name`",
		},
		{
			"representations that are neither one representation nor a list of them",
			`{"resource":{"@context":"https://schema.org/","@id":"res-1","name":"A resource","representations":"text/plain"},"lastSequence":1}`,
			"its `response.resource.representations` is malformed",
		},
		{"a name that is a number", `{"resource":{"@context":"https://schema.org/","@id":"res-1","name":1998,"representations":[]},"lastSequence":1}`, "its `response.resource.name` is malformed"},
		{"a sequence that is not a whole number", `{"resource":` + aResource + `,"lastSequence":1.5}`, "its `response.lastSequence` is malformed"},
	} {
		_, err := asked(t, c.response)
		refusedAs(t, c.why, err, "a payload on browse:resource-result is not that channel's: "+c.said)
	}
}

func TestAReplyThatCarriesWhatItsSchemaRequiresIsRead(t *testing.T) {
	for _, response := range []string{
		`{"resource":` + aResource + `,"lastSequence":1}`,
		// A member it may leave out, and a list where one agent or a list of
		// them may be, are no fault.
		`{"resource":{"@context":"https://schema.org/","@id":"res-1","name":"A resource","representations":[],"wasAttributedTo":[{"@type":"Person"}]},"lastSequence":1}`,
	} {
		read, err := asked(t, response)
		if err != nil || read.Response.Resource.Name != "A resource" {
			t.Errorf("%s: read %+v, %v", response, read, err)
		}
	}
}

// A reply whose response its registry entry wraps is held to what the
// response's schema requires, from the response.
func TestAWrappedResponseIsHeldToItsSchemaFromTheResponse(t *testing.T) {
	transport := semionttest.NewFaultyTransport(semionttest.FaultyConfig{})
	defer transport.Close()
	transport.QueueReply(bus.JobCancelRequested.Request().Channel(), json.RawMessage(`{}`))
	job, err := api.ParseJobId("job-1")
	if err != nil {
		t.Fatal(err)
	}
	_, err = semiont.Request(context.Background(), semiont.NewWire(transport), bus.JobCancelRequested, api.JobCancelRequest{JobId: job}, semiont.DefaultTiming().BusRequestTimeout)
	refusedAs(t, "an empty response", err, "a payload on job:cancel-ok is not that channel's: it has no `response.cancelled`")
	transport.QueueReply(bus.JobCancelRequested.Request().Channel(), nil)
	_, err = semiont.Request(context.Background(), semiont.NewWire(transport), bus.JobCancelRequested, api.JobCancelRequest{JobId: job}, semiont.DefaultTiming().BusRequestTimeout)
	refusedAs(t, "no response", err, "a payload on job:cancel-ok is not that channel's: it has no `response`")
}

func TestAnAnswerWithAFaultIsRefusedNamingIt(t *testing.T) {
	for _, c := range []struct{ why, answer, said string }{
		{"a user with no domain", `{"did":"did:web:example.org:users:alice","email":null,"name":null,"image":null}`, "it has no `domain`"},
		{"a user whose image is a number", `{"did":"did:web:example.org:users:alice","domain":"example.org","email":null,"name":null,"image":7}`, "its `image` is malformed"},
		{"a user that is no object", `"alice"`, "it is malformed"},
	} {
		gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(c.answer))
		}))
		transport := semiont.NewHTTPTransport(semiont.HTTPTransportConfig{BaseURL: gateway.URL, Token: semiont.NewVariable(""), HTTP: &http.Client{}, Timing: semiont.DefaultTiming()})
		_, err := transport.GetCurrentUser(context.Background())
		refusedAs(t, c.why, err, "GET /api/users/me answered what is not its declared body: "+c.said)
		var refused *semiont.TransportError
		if errors.As(err, &refused) {
			if status, ok := refused.Status(); !ok || status != http.StatusOK {
				t.Errorf("%s: the refusal states status %d (%v), not the answer's", c.why, status, ok)
			}
		}
		transport.Close()
		gateway.Close()
	}
}

// A reply its transport refused is told at once to the request awaiting the
// correlation id the refusal carries, which fails with it as it fails for a
// reply whose payload is not its channel's, in the words a frame's refusal
// is said in. A refusal that carries no correlation id reaches no request.
func TestARequestIsToldAtOnceOfAReplyItsTransportRefused(t *testing.T) {
	// The reply the gateway answers with is lost on its way, and the refusals are delivered by hand.
	transport := semionttest.NewFaultyTransport(semionttest.FaultyConfig{Schedule: []semionttest.FaultAction{semionttest.DropReply{}}})
	defer transport.Close()
	transport.QueueReply(bus.BrowseResourceRequested.Request().Channel(), json.RawMessage(`{"resource":`+aResource+`,"lastSequence":1}`))
	resource, err := api.ParseResourceId("res-1")
	if err != nil {
		t.Fatal(err)
	}
	asked := make(chan error, 1)
	go func() {
		_, err := semiont.Request(context.Background(), semiont.NewWire(transport), bus.BrowseResourceRequested, api.BrowseResourceRequest{ResourceId: resource}, time.Minute)
		asked <- err
	}()
	deadline := time.Now().Add(time.Second)
	for len(transport.PendingReplies()) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("the request awaits no reply")
		}
		time.Sleep(5 * time.Millisecond)
	}
	awaited := transport.PendingReplies()[0]
	result := bus.BrowseResourceRequested.Result().Channel()

	transport.DeliverRefusal(&semiont.FrameRefusal{Channel: result, Member: "correlationId", Reason: bus.FrameRefusalReasonMalformed})
	select {
	case err := <-asked:
		t.Fatalf("a refusal that carries no correlation id ended the request: %v", err)
	case <-time.After(50 * time.Millisecond):
	}

	transport.DeliverRefusal(&semiont.FrameRefusal{Channel: result, Member: "addedByALaterGateway", Reason: bus.FrameRefusalReasonMalformed, Envelope: semiont.Envelope{CorrelationID: awaited}})
	select {
	case err := <-asked:
		refusedAs(t, "a reply its transport refused", err, "a frame on browse:resource-result is not that channel's: its `addedByALaterGateway` is malformed")
	case <-time.After(5 * time.Second):
		t.Fatal("the request was not told of the reply its transport refused")
	}
}
