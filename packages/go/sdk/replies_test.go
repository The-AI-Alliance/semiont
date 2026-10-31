package semiont_test

// A reply that lacks a member its schema requires is refused as it is
// decoded, wherever the member is missing, as Rust, Python and Kotlin refuse
// it: over the bus, as a *TransportError coded error that says the payload is
// not its channel's and names the member; over HTTP, as one that says the
// answer is not its declared body.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

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
		t.Errorf("%s: read, or failed as %v, and it lacks a member its schema requires", why, err)
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

func TestAReplyThatLacksAMemberItsSchemaRequiresIsRefusedNamingIt(t *testing.T) {
	for _, c := range []struct{ why, response, lacks string }{
		{"no resource", `{"lastSequence":1}`, "response.resource"},
		{"a resource that is null", `{"resource":null,"lastSequence":1}`, "response.resource"},
		{"a resource with no name", `{"resource":{"@context":"https://schema.org/","@id":"res-1","representations":[]},"lastSequence":1}`, "response.resource.name"},
		{"a resource with no representations", `{"resource":{"@context":"https://schema.org/","@id":"res-1","name":"A resource"},"lastSequence":1}`, "response.resource.representations"},
		{
			"a representation listed with no media type",
			`{"resource":{"@context":"https://schema.org/","@id":"res-1","name":"A resource","representations":[{"mediaType":"text/plain"},{"storageUri":"file://a.txt"}]},"lastSequence":1}`,
			"response.resource.representations.mediaType",
		},
		{
			"one representation, with no media type",
			`{"resource":{"@context":"https://schema.org/","@id":"res-1","name":"A resource","representations":{"storageUri":"file://a.txt"}},"lastSequence":1}`,
			"response.resource.representations.mediaType",
		},
		{
			"an agent of the type the discriminator names, without what that type requires",
			`{"resource":{"@context":"https://schema.org/","@id":"res-1","name":"A resource","representations":[],"wasAttributedTo":{"@type":"Organization"}},"lastSequence":1}`,
			"response.resource.wasAttributedTo.name",
		},
	} {
		_, err := asked(t, c.response)
		refusedAs(t, c.why, err, "a payload on browse:resource-result is not that channel's: it has no `"+c.lacks+"`")
	}
}

func TestAReplyThatCarriesWhatItsSchemaRequiresIsRead(t *testing.T) {
	for _, response := range []string{
		`{"resource":` + aResource + `,"lastSequence":1}`,
		// A member it may leave out, and a member of a kind no variant of a
		// union is, are no member it lacks.
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

func TestAnAnswerThatLacksAMemberItsSchemaRequiresIsRefusedNamingIt(t *testing.T) {
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"did":"did:web:example.org:users:alice","email":null,"name":null,"image":null}`))
	}))
	defer gateway.Close()
	transport := semiont.NewHTTPTransport(semiont.HTTPTransportConfig{BaseURL: gateway.URL, Token: semiont.NewVariable(""), HTTP: &http.Client{}, Timing: semiont.DefaultTiming()})
	defer transport.Close()
	_, err := transport.GetCurrentUser(context.Background())
	refusedAs(t, "a user with no domain", err, "GET /api/users/me answered what is not its declared body: it has no `domain`")
	var refused *semiont.TransportError
	if errors.As(err, &refused) {
		if status, ok := refused.Status(); !ok || status != http.StatusOK {
			t.Errorf("the refusal states status %d (%v), not the answer's", status, ok)
		}
	}
}
