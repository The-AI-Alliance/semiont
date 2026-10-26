package readme

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/semionttest"
)

// TitleOf is the code under test: a resource's name, in capitals.
func TitleOf(ctx context.Context, client *semiont.Client, resource api.ResourceId) (string, error) {
	described, err := client.Browse.Resource(resource).Fresh(ctx)
	return strings.ToUpper(described.Name), err
}

// ATitleIsItsResourcesNameInCapitals is the test of it.
func ATitleIsItsResourcesNameInCapitals(t *testing.T) {
	made := semionttest.NewTestClient(semionttest.TestClientConfig{Timing: semiont.DefaultTiming()})
	defer made.Transport.Close()
	defer made.Client.Close()
	asked := bus.BrowseResourceRequested.Request().Channel()
	made.Transport.QueueReply(asked, json.RawMessage(`{"resource":{"@context":"https://schema.org","@id":"res-1","name":"a page of notes","representations":[]}}`))

	resource, err := api.ParseResourceId("res-1")
	if err != nil {
		t.Fatal(err)
	}
	if title, err := TitleOf(context.Background(), made.Client, resource); err != nil || title != "A PAGE OF NOTES" {
		t.Fatalf("the title is %q (%v)", title, err)
	}

	// What the code under test asked of the knowledge base, as it was sent.
	sent := made.Transport.RequestLog()
	if !slices.EqualFunc(sent, []string{`{"resourceId":"res-1"}`}, func(entry semionttest.RequestLogEntry, payload string) bool {
		return entry.Channel == asked && string(entry.Payload) == payload
	}) {
		t.Fatalf("asked %v", sent)
	}
}
