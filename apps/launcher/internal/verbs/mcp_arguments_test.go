package verbs

// The TypeScript server's bug, as cases `semiont mcp` must not repeat (the
// user: "tool arguments are unvalidated, and it invents a 'Generated'
// title"). A call is held to its tool's input schema, which is the spec's,
// before anything is sent; a refusal names every fault; a value the caller
// did not state is not sent, and where the SDK's surface states what a call
// that states nothing sends (specs/src/client/surface.json), that is what is
// sent, for every SDK alike.

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

func TestMCPAGenerationWithoutItsTitleOrStorageUriIsRefused(t *testing.T) {
	cs, fake, _ := mcpFixture(t)
	for _, missing := range []string{"title", "storageUri"} {
		args := map[string]any{"resourceId": "res-1", "annotationId": "ann-1", "title": "Derived", "storageUri": "file://generated/out.md"}
		delete(args, missing)
		refusedNaming(t, "yield_generate without "+missing, callTool(t, cs, "yield_generate", args), "`"+missing+"`")
	}
	if sent := fake.RequestLog(); len(sent) != 0 {
		t.Errorf("a refused generation sent %d requests, the first on %s", len(sent), sent[0].Channel)
	}
	for _, frame := range fake.Emitted() {
		if strings.Contains(string(frame.Payload), "Generated") {
			t.Errorf("a title the caller never gave was sent on %s: %s", frame.Channel, frame.Payload)
		}
	}
}

func TestMCPAGatherSendsTheWindowStatedAndRefusesOneOutOfBounds(t *testing.T) {
	cs, fake, _ := mcpFixture(t)
	gathering := bus.GatherRequested.Request().Channel()

	// No window stated: the tool states none of its own, and the SDK sends
	// the one its surface states for a call that states none. Neither context
	// is asked for or refused.
	callTool(t, cs, "gather_annotation", map[string]any{"resourceId": "res-1", "annotationId": "ann-1"})
	gathers := requestsOf(fake, gathering)
	if len(gathers) != 1 {
		t.Fatalf("gathered %d times, want once", len(gathers))
	}
	payload := string(gathers[0].Payload)
	if !strings.Contains(payload, `"contextWindow":2000`) {
		t.Errorf("a gather that stated no window did not send the surface's: %s", payload)
	}
	for _, unstated := range []string{"includeSourceContext", "includeTargetContext"} {
		if strings.Contains(payload, unstated) {
			t.Errorf("a gather that stated no %s sent one: %s", unstated, payload)
		}
	}

	// What is stated is sent, a false among it.
	callTool(t, cs, "gather_annotation", map[string]any{"resourceId": "res-1", "annotationId": "ann-1",
		"options": map[string]any{"contextWindow": 500, "includeSourceContext": false, "includeTargetContext": true}})
	if gathers = requestsOf(fake, gathering); len(gathers) != 2 {
		t.Fatalf("gathered %d times, want twice", len(gathers))
	}
	for _, stated := range []string{`"contextWindow":500`, `"includeSourceContext":false`, `"includeTargetContext":true`} {
		if !strings.Contains(string(gathers[1].Payload), stated) {
			t.Errorf("a gather that stated %s did not send it: %s", stated, gathers[1].Payload)
		}
	}

	for _, outside := range []int{50, 9000} {
		refusedNaming(t, "a window outside 100 to 5000", callTool(t, cs, "gather_annotation", map[string]any{"resourceId": "res-1", "annotationId": "ann-1",
			"options": map[string]any{"contextWindow": outside}}), "`options.contextWindow`")
	}
	// A gather inside a composite is held to the same schema, under `gather`.
	refusedNaming(t, "match_link_targets with a window of 50", callTool(t, cs, "match_link_targets", map[string]any{"resourceId": "res-1", "referenceId": "ann-1",
		"gather": map[string]any{"contextWindow": 50}}), "`gather.contextWindow`")
	if gathers = requestsOf(fake, gathering); len(gathers) != 2 {
		t.Errorf("a refused window was sent: %d gathers", len(gathers))
	}
}

func TestMCPAListSendsTheOffsetStated(t *testing.T) {
	cs, fake, _ := mcpFixture(t)
	callTool(t, cs, "browse_resources", map[string]any{"offset": 20})
	callTool(t, cs, "match_resources", map[string]any{"search": "cat", "offset": 20})
	for _, channel := range []bus.Channel{bus.BrowseResourcesRequested.Request().Channel(), bus.MatchResourcesRequested.Request().Channel()} {
		sent := requestsOf(fake, channel)
		if len(sent) != 1 || !strings.Contains(string(sent[0].Payload), `"offset":20`) {
			t.Errorf("%s did not send the offset stated: %v", channel, sent)
		}
	}
	for _, tool := range []map[string]any{{"offset": -1}, {"offset": 1.5}} {
		refusedNaming(t, "browse_resources with an offset of "+jsonText(tool["offset"]), callTool(t, cs, "browse_resources", tool), "`offset`")
	}
}

func TestMCPAListSendsNoFilterItWasNotGiven(t *testing.T) {
	cs, fake, _ := mcpFixture(t)
	callTool(t, cs, "browse_resources", map[string]any{})
	callTool(t, cs, "match_resources", map[string]any{"search": "cat"})
	for _, channel := range []bus.Channel{bus.BrowseResourcesRequested.Request().Channel(), bus.MatchResourcesRequested.Request().Channel()} {
		sent := requestsOf(fake, channel)
		if len(sent) != 1 {
			t.Fatalf("%d requests on %s, want one", len(sent), channel)
		}
		var payload map[string]json.RawMessage
		if err := json.Unmarshal(sent[0].Payload, &payload); err != nil {
			t.Fatal(err)
		}
		for _, unstated := range []string{"archived", "entityType"} {
			if _, has := payload[unstated]; has {
				t.Errorf("%s carries %s, which the call did not state: %s", channel, unstated, sent[0].Payload)
			}
		}
	}

	// match_resources' limit is the spec's: a whole number from 1 to 200.
	for _, limit := range []any{"ten", 0, 2.5} {
		refusedNaming(t, "match_resources with a limit of "+jsonText(limit), callTool(t, cs, "match_resources", map[string]any{"search": "cat", "limit": limit}), "`limit`")
	}
	// browse_resources' is a whole number from 1, with no greatest.
	for _, limit := range []any{"ten", 0, 2.5} {
		refusedNaming(t, "browse_resources with a limit of "+jsonText(limit), callTool(t, cs, "browse_resources", map[string]any{"limit": limit}), "`limit`")
	}
	if len(fake.RequestLog()) != 2 {
		t.Errorf("a refused limit was sent: %d requests", len(fake.RequestLog()))
	}
}

func jsonText(value any) string {
	written, _ := json.Marshal(value)
	return string(written)
}

// Every id is held to its kind's rule, mark's and bind's included, and a
// required one left out is named.
func TestMCPAnIdThatBreaksItsRuleOrIsMissingIsRefused(t *testing.T) {
	cs, fake, _ := mcpFixture(t)
	operations := []any{map[string]any{"op": "remove"}}
	for _, c := range []struct {
		tool string
		args map[string]any
		ids  []string
	}{
		{"browse_resource", map[string]any{"resourceId": "res-1"}, []string{"resourceId"}},
		{"browse_annotations", map[string]any{"resourceId": "res-1"}, []string{"resourceId"}},
		{"gather_annotation", map[string]any{"resourceId": "res-1", "annotationId": "ann-1"}, []string{"resourceId", "annotationId"}},
		{"mark_delete", map[string]any{"resourceId": "res-1", "annotationId": "ann-1"}, []string{"resourceId", "annotationId"}},
		{"mark_archive", map[string]any{"resourceId": "res-1"}, []string{"resourceId"}},
		{"bind_link", map[string]any{"resourceId": "res-1", "annotationId": "ann-1", "operations": operations}, []string{"resourceId", "annotationId"}},
		{"job_status", map[string]any{"jobId": "job-1"}, []string{"jobId"}},
		{"job_cancel", map[string]any{"jobId": "job-1"}, []string{"jobId"}},
		{"beckon_attention", map[string]any{"resourceId": "res-1", "annotationId": "ann-1"}, []string{"resourceId", "annotationId"}},
	} {
		for _, id := range c.ids {
			broken := clone(c.args)
			broken[id] = "not an id!"
			refusedNaming(t, c.tool+" with a broken "+id, callTool(t, cs, c.tool, broken), "`"+id+"`")
			missing := clone(c.args)
			delete(missing, id)
			refusedNaming(t, c.tool+" without "+id, callTool(t, cs, c.tool, missing), "`"+id+"`", "is required")
		}
	}
	// mark's resource is its target's source.
	refusedNaming(t, "mark_annotation with a broken source", callTool(t, cs, "mark_annotation", map[string]any{
		"motivation": "highlighting", "target": map[string]any{"source": "not an id!"},
	}), "`target.source`")
	if sent := fake.RequestLog(); len(sent) != 0 {
		t.Errorf("a refused id was sent: %d requests, the first on %s", len(sent), sent[0].Channel)
	}
}

func clone(args map[string]any) map[string]any {
	cloned := map[string]any{}
	for name, value := range args {
		cloned[name] = value
	}
	return cloned
}

func TestMCPAnArgumentTheSchemaDoesNotNameIsRefused(t *testing.T) {
	cs, fake, _ := mcpFixture(t)
	refusedNaming(t, "browse_resource with a colour", callTool(t, cs, "browse_resource", map[string]any{"resourceId": "res-1", "colour": "red"}), "`colour`", "is not an argument this takes")
	if sent := fake.RequestLog(); len(sent) != 0 {
		t.Errorf("a refused call sent %d requests", len(sent))
	}
}

// A resource's media type is the caller's: the spec requires it, so a
// resource yielded with none is refused, and never given text/plain and a
// .txt name.
func TestMCPAResourceWithNoMediaTypeIsRefused(t *testing.T) {
	cs, _, gateway := mcpFixture(t)
	refusedNaming(t, "yield_resource with no format", callTool(t, cs, "yield_resource", map[string]any{
		"name": "Notes", "file": "hello", "storageUri": "file://notes.md",
	}), "`format`")
	for _, s := range gateway.bearers() {
		if s.route == "/resources" {
			t.Errorf("a resource with no media type was uploaded")
		}
	}
}

func TestMCPSeveralFaultsAreRefusedTogether(t *testing.T) {
	cs, _, _ := mcpFixture(t)
	refusedNaming(t, "a gather with four faults", callTool(t, cs, "gather_annotation", map[string]any{
		"resourceId": "not an id!", "options": map[string]any{"contextWindow": 50}, "colour": "red",
	}), "`resourceId`", "`annotationId`", "`options.contextWindow`", "`colour`")
}
