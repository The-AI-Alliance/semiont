package verbs

// `semiont mcp`'s tools, in process: the server `semiont mcp` runs, reached
// by an MCP client over the go-sdk's in-memory transports, its sessions the
// launcher's (launcher.Sessions) over the fixture's sign-in, the bus a
// FaultyTransport that logs what each call sent, the gateway a stub that says
// who the token is.

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	launcher "github.com/The-AI-Alliance/semiont/apps/launcher/internal/launcher"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/semionttest"
)

// mcpClient is an MCP client of `semiont mcp`'s server, in process.
func mcpClient(t *testing.T) *mcp.ClientSession {
	t.Helper()
	return mcpClientWith(t, nil)
}

// mcpClientWith is mcpClient, the client made with options.
func mcpClientWith(t *testing.T, options *mcp.ClientOptions) *mcp.ClientSession {
	t.Helper()
	sessions := launcher.NewSessions(launcher.NewUI(false), jobChannels...)
	t.Cleanup(sessions.Close)
	server, err := newMCPServer(sessions)
	if err != nil {
		t.Fatal(err)
	}
	serverSide, clientSide := mcp.NewInMemoryTransports()
	ctx := context.Background()
	if _, err := server.Connect(ctx, serverSide, nil); err != nil {
		t.Fatal(err)
	}
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "0"}, options).Connect(ctx, clientSide, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cs.Close() })
	return cs
}

// mcpFixture is a recorded local stack signed in to, whose gateway says who
// the token is (did:web:example.org:users:t) and whose bus is fake, and an
// MCP client of the server over it.
func mcpFixture(t *testing.T) (*mcp.ClientSession, *semionttest.FaultyTransport, *gatewayStub) {
	t.Helper()
	gateway := newGatewayStub(t, func(string) bool { return true })
	gatewayFixture(t, gateway)
	fake := semionttest.NewFaultyTransport(semionttest.FaultyConfig{})
	t.Cleanup(launcher.UseTransport(func(semiont.HTTPTransportConfig) semiont.Transport { return fake }))
	return mcpClient(t), fake, gateway
}

// callTool calls the tool name with args, and gives its result.
func callTool(t *testing.T, cs *mcp.ClientSession, name string, args map[string]any) *mcp.CallToolResult {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	result, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: a protocol error, where a tool answers its own: %v", name, err)
	}
	return result
}

// said is every text a result gives, in order.
func said(result *mcp.CallToolResult) string {
	var texts []string
	for _, content := range result.Content {
		if text, isText := content.(*mcp.TextContent); isText {
			texts = append(texts, text.Text)
		}
	}
	return strings.Join(texts, "\n")
}

// structured is a result's structured content, as an object.
func structured(t *testing.T, result *mcp.CallToolResult) map[string]any {
	t.Helper()
	written, err := json.Marshal(result.StructuredContent)
	if err != nil {
		t.Fatal(err)
	}
	var object map[string]any
	if err := json.Unmarshal(written, &object); err != nil {
		t.Fatalf("structured content is not an object: %s", written)
	}
	return object
}

// refusedNaming: the call was refused before anything was sent, naming each
// of names.
func refusedNaming(t *testing.T, call string, result *mcp.CallToolResult, names ...string) {
	t.Helper()
	text := said(result)
	if !result.IsError {
		t.Fatalf("%s was not refused:\n%s", call, text)
	}
	if !strings.Contains(text, "nothing was sent") {
		t.Errorf("%s's refusal does not say nothing was sent:\n%s", call, text)
	}
	for _, name := range names {
		if !strings.Contains(text, name) {
			t.Errorf("%s's refusal does not name %s:\n%s", call, name, text)
		}
	}
}

// surfaceMethods is every method of specs/src/client/surface.json, as
// `<namespace>.<method>`.
func surfaceMethods(t *testing.T) map[string]bool {
	t.Helper()
	text, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "specs", "src", "client", "surface.json"))
	if err != nil {
		t.Fatal(err)
	}
	var surface struct {
		Namespaces []struct {
			Namespace string `json:"namespace"`
			Methods   []struct {
				Method string `json:"method"`
			} `json:"methods"`
		} `json:"namespaces"`
	}
	if err := json.Unmarshal(text, &surface); err != nil {
		t.Fatal(err)
	}
	methods := map[string]bool{}
	for _, namespace := range surface.Namespaces {
		for _, method := range namespace.Methods {
			methods[namespace.Namespace+"."+method.Method] = true
		}
	}
	return methods
}

// Every method of the SDK's surface is called by a tool or left out with its
// reason, never both, and every method a tool calls or the list leaves out is
// one of the surface's.
func TestMCPToolsCensus(t *testing.T) {
	document, err := mcpDocument()
	if err != nil {
		t.Fatal(err)
	}
	surface := surfaceMethods(t)
	calledBy := map[string]string{}
	for _, tool := range document.Tools {
		for _, method := range tool.Calls {
			if !surface[method] {
				t.Errorf("%s calls %s, which surface.json has no row for", tool.Name, method)
			}
			if reason, left := document.LeftOut[method]; left {
				t.Errorf("%s calls %s, which the list also leaves out (%q)", tool.Name, method, reason)
			}
			calledBy[method] = tool.Name
		}
	}
	for method, reason := range document.LeftOut {
		if !surface[method] {
			t.Errorf("the list leaves out %s, which surface.json has no row for", method)
		}
		if strings.TrimSpace(reason) == "" {
			t.Errorf("the list leaves out %s with no reason", method)
		}
	}
	for method := range surface {
		_, called := calledBy[method]
		_, left := document.LeftOut[method]
		if !called && !left {
			t.Errorf("%s is called by no tool, and the list gives no reason for leaving it out", method)
		}
	}
}

// argumentNames is the JSON names of a tool's argument type's fields, those
// of an embedded generated type among them.
func argumentNames(of reflect.Type) []string {
	var names []string
	for i := 0; i < of.NumField(); i++ {
		field := of.Field(i)
		if field.Anonymous {
			names = append(names, argumentNames(field.Type)...)
			continue
		}
		name, _, _ := strings.Cut(field.Tag.Get("json"), ",")
		names = append(names, name)
	}
	return names
}

// Every tool has its work, and every work its tool; each work reads exactly
// the arguments its tool's input schema names, kb aside.
func TestMCPHandlersAreTheTools(t *testing.T) {
	document, err := mcpDocument()
	if err != nil {
		t.Fatal(err)
	}
	tools := map[string]bool{}
	for _, tool := range document.Tools {
		tools[tool.Name] = true
		handler, has := mcpHandlers[tool.Name]
		if !has {
			t.Errorf("%s has no work", tool.Name)
			continue
		}
		var input struct {
			Properties map[string]json.RawMessage `json:"properties"`
		}
		if err := json.Unmarshal(tool.Input, &input); err != nil {
			t.Fatal(err)
		}
		var schema []string
		for name := range input.Properties {
			if name != "kb" {
				schema = append(schema, name)
			}
		}
		read := argumentNames(reflect.TypeOf(handler.arguments))
		sort.Strings(schema)
		sort.Strings(read)
		if !slices.Equal(schema, read) {
			t.Errorf("%s's schema names %v, and its work reads %v", tool.Name, schema, read)
		}
		if _, takesKb := input.Properties["kb"]; takesKb != tool.takesKb() {
			t.Errorf("%s calls %v, and its schema's kb is %v", tool.Name, tool.Calls, takesKb)
		}
	}
	for name := range mcpHandlers {
		if !tools[name] {
			t.Errorf("the work %s is no tool's", name)
		}
	}
}

// tools/list gives every tool, in the document's order, each with its title,
// its input schema an object that names no argument it does not take, and
// its hints.
func TestMCPToolsAreListed(t *testing.T) {
	verbFixture(t)
	cs := mcpClient(t)
	listed, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	document, err := mcpDocument()
	if err != nil {
		t.Fatal(err)
	}
	if len(listed.Tools) != len(document.Tools) {
		t.Fatalf("listed %d tools, want %d", len(listed.Tools), len(document.Tools))
	}
	for i, tool := range listed.Tools {
		want := document.Tools[i]
		if tool.Name != want.Name || tool.Title == "" || tool.Description == "" {
			t.Errorf("tool %d is %q titled %q, want %q with a title and a description", i, tool.Name, tool.Title, want.Name)
		}
		written, _ := json.Marshal(tool.InputSchema)
		var input struct {
			Type                 string `json:"type"`
			AdditionalProperties *bool  `json:"additionalProperties"`
		}
		_ = json.Unmarshal(written, &input)
		if input.Type != "object" || input.AdditionalProperties == nil || *input.AdditionalProperties {
			t.Errorf("%s's input schema is not an object that refuses what it does not name: %s", tool.Name, written)
		}
		if tool.Annotations == nil || tool.Annotations.ReadOnlyHint != want.ReadOnly {
			t.Errorf("%s's readOnlyHint is not %v", tool.Name, want.ReadOnly)
		}
		if !want.ReadOnly && (tool.Annotations.DestructiveHint == nil || *tool.Annotations.DestructiveHint != want.Destructive) {
			t.Errorf("%s's destructiveHint is not %v", tool.Name, want.Destructive)
		}
	}
}
