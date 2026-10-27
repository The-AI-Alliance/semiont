package verbs

// `semiont mcp`'s sessions: one for each knowledge base, held for hours
// (launcher.Sessions). A session is resumed on its knowledge base's first
// call and held for the next; one the SDK reports over ends that call, and
// the next is refused at once, without asking the issuer again; one signed in
// again is resumed on its next call. A codespace whose forward is down is
// said, with the command that restores it, and nothing is started.

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	launcher "github.com/The-AI-Alliance/semiont/apps/launcher/internal/launcher"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/semionttest"
)

func TestMCPASessionIsResumedOnItsFirstCallAndHeldForTheNext(t *testing.T) {
	cs, fake, gateway := mcpFixture(t)
	// A sign-in the SDK renews: its session asks the gateway who the token is
	// as it starts.
	storeSession(t, newIssuerStub(t, http.StatusOK, renewed()), 300*time.Second)
	callTool(t, cs, "browse_resources", map[string]any{})
	callTool(t, cs, "browse_resources", map[string]any{})
	if sent := requestsOf(fake, bus.BrowseResourcesRequested.Request().Channel()); len(sent) != 2 {
		t.Fatalf("%d lists reached the bus, want two", len(sent))
	}
	if asked := gateway.times("/api/users/me", "token-1"); asked != 1 {
		t.Errorf("the gateway was asked who the token is %d times, want once: the session is held, not resumed for each call", asked)
	}
}

func TestMCPASessionThatCannotBeRenewedIsRefusedAndTheNextCallAtOnce(t *testing.T) {
	cs, fake, _ := mcpFixture(t)
	issuer := newIssuerStub(t, http.StatusBadRequest, `{"error":"invalid_grant"}`)
	storeSession(t, issuer, -time.Minute)

	first := callTool(t, cs, "browse_resources", map[string]any{})
	if !first.IsError || !strings.Contains(said(first), "semiont login") {
		t.Fatalf("a session whose renewal failed was not refused naming semiont login:\n%s", said(first))
	}
	grants := len(issuer.refreshGrants())
	if grants != 1 {
		t.Errorf("the issuer was asked to renew %d times, want once", grants)
	}

	second := callTool(t, cs, "browse_resources", map[string]any{})
	if !second.IsError || !strings.Contains(said(second), "semiont login") {
		t.Fatalf("the call after a session ended was not refused naming semiont login:\n%s", said(second))
	}
	if again := len(issuer.refreshGrants()); again != grants {
		t.Errorf("the call after the session ended asked the issuer again (%d grants, was %d)", again, grants)
	}
	if sent := fake.RequestLog(); len(sent) != 0 {
		t.Errorf("a refused session sent %d requests", len(sent))
	}

	// Signed in again, the knowledge base is resumed on its next call. The
	// session that ended closed its transport, as every session does, so the
	// next is given one of its own.
	fresh := semionttest.NewFaultyTransport(semionttest.FaultyConfig{})
	t.Cleanup(launcher.UseTransport(func(semiont.HTTPTransportConfig) semiont.Transport { return fresh }))
	renewing := newIssuerStub(t, http.StatusOK, renewed())
	storeSession(t, renewing, 300*time.Second)
	third := callTool(t, cs, "browse_resources", map[string]any{})
	if sent := requestsOf(fresh, bus.BrowseResourcesRequested.Request().Channel()); len(sent) != 1 {
		t.Errorf("a knowledge base signed in again was not resumed:\n%s", said(third))
	}
}

// recordCodespace adds a codespace stack for o/n to the fixture's record,
// its forward recorded on port 4001 and no forward running, and a sign-in
// for it.
func recordCodespace(t *testing.T) {
	t.Helper()
	path := filepath.Join(launcher.StateDir(), "stack.json")
	written, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var record map[string]any
	if err := json.Unmarshal(written, &record); err != nil {
		t.Fatal(err)
	}
	stacks := record["stacks"].(map[string]any)
	stacks["codespace:o/n"] = map[string]any{
		"codespace": map[string]any{"name": "cs-1", "repo": "o/n", "forwardPort": 4001},
		"services":  map[string]any{},
	}
	if written, err = json.MarshalIndent(record, "", "  "); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, written, 0o600); err != nil {
		t.Fatal(err)
	}
	store := semiont.NewSignInStore(filepath.Join(launcher.StateDir(), semiont.SignInFile))
	if err := store.Entry("codespace:o/n").Keep(context.Background(), semiont.HeldSignIn{
		Access: tokenTagged("cs-token", 300*time.Second), ClientID: semiont.ScriptClientID,
	}); err != nil {
		t.Fatal(err)
	}
}

func TestMCPACodespaceWhoseForwardIsDownIsSaidAndNothingIsStarted(t *testing.T) {
	cs, fake, _ := mcpFixture(t)
	recordCodespace(t)
	before, err := os.ReadFile(filepath.Join(launcher.StateDir(), "stack.json"))
	if err != nil {
		t.Fatal(err)
	}

	listed := callTool(t, cs, "knowledge_bases", map[string]any{})
	if listed.IsError {
		t.Fatalf("knowledge_bases refused:\n%s", said(listed))
	}
	rows, _ := structured(t, listed)["knowledgeBases"].([]any)
	byKey := map[string]map[string]any{}
	for _, row := range rows {
		kb := row.(map[string]any)
		byKey[kb["kb"].(string)] = kb
	}
	if len(byKey) != 2 || byKey["local"] == nil || byKey["codespace:o/n"] == nil {
		t.Fatalf("knowledge_bases listed %v, want local and codespace:o/n", rows)
	}
	if up, _ := byKey["codespace:o/n"]["forwardUp"].(bool); up || byKey["codespace:o/n"]["forwardUp"] == nil {
		t.Errorf("a codespace whose forward is down is listed with forwardUp %v", byKey["codespace:o/n"]["forwardUp"])
	}

	down := callTool(t, cs, "browse_resources", map[string]any{"kb": "codespace:o/n"})
	if !down.IsError || !strings.Contains(said(down), "semiont status --repo o/n") {
		t.Errorf("a call to a codespace whose forward is down did not name semiont status --repo o/n:\n%s", said(down))
	}
	after, err := os.ReadFile(filepath.Join(launcher.StateDir(), "stack.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(before) {
		t.Errorf("a call to a codespace whose forward is down changed the record: something was started")
	}

	// With two signed in, a call names one, and the server picks none.
	unnamed := callTool(t, cs, "browse_resources", map[string]any{})
	if !unnamed.IsError || !strings.Contains(said(unnamed), "`kb` is required") ||
		!strings.Contains(said(unnamed), "`local`") || !strings.Contains(said(unnamed), "`codespace:o/n`") {
		t.Errorf("a call naming no kb with two signed in was not refused naming kb and both:\n%s", said(unnamed))
	}
	if sent := fake.RequestLog(); len(sent) != 0 {
		t.Errorf("%d requests were sent, and no call reached a knowledge base", len(sent))
	}

	// A call naming local reaches local's client.
	callTool(t, cs, "browse_resources", map[string]any{"kb": "local"})
	if sent := requestsOf(fake, bus.BrowseResourcesRequested.Request().Channel()); len(sent) != 1 {
		t.Errorf("a call naming local did not reach it")
	}
	// Nothing a call sends to a gateway names the kb.
	for _, frame := range fake.Emitted() {
		if strings.Contains(string(frame.Payload), `"kb"`) {
			t.Errorf("%s carried the kb: %s", frame.Channel, frame.Payload)
		}
	}
}

func TestMCPAKbNoKnowledgeBaseHasIsRefusedNamingIt(t *testing.T) {
	cs, _, _ := mcpFixture(t)
	result := callTool(t, cs, "browse_resources", map[string]any{"kb": "codespace:nobody/nothing"})
	if !result.IsError || !strings.Contains(said(result), "codespace:nobody/nothing") || !strings.Contains(said(result), "knowledge_bases") {
		t.Errorf("a kb no knowledge base has was not refused naming it:\n%s", said(result))
	}
}
