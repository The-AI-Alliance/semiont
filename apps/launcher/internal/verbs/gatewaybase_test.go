package verbs

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/harness"
	launcher "github.com/The-AI-Alliance/semiont/apps/launcher/internal/launcher"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
)

// noGatewayFixture is verbFixture with the local stack's record naming no
// gateway endpoint, and a transport seam that counts what was built.
func noGatewayFixture(t *testing.T) *int {
	t.Helper()
	verbFixture(t)
	ss := &launcher.StackSet{Stacks: map[string]*launcher.StackState{
		"local": {Runtime: "container", Services: map[string]launcher.ServiceState{
			"gateway": {Container: "semiont-gateway"},
		}},
	}}
	b, _ := json.MarshalIndent(ss, "", "  ")
	if err := os.WriteFile(filepath.Join(launcher.StateDir(), "stack.json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
	built := 0
	t.Cleanup(launcher.UseTransport(func(semiont.HTTPTransportConfig) semiont.Transport {
		built++
		return nil
	}))
	return &built
}

// A local stack whose record names no gateway is refused, with the command
// that records one, and nothing is dialled: no address is made up for it.
func TestAVerbAgainstARecordThatNamesNoGatewayIsRefused(t *testing.T) {
	built := noGatewayFixture(t)
	_, stderr := harness.CaptureOutput(t, func() {
		if code := Browse([]string{"--json"}); code == 0 {
			t.Error("browse: exit 0 against a record that names no gateway")
		}
	})
	for _, want := range []string{"names no gateway", "semiont start"} {
		if !strings.Contains(stderr, want) {
			t.Errorf("the refusal does not say %q:\n%s", want, stderr)
		}
	}
	if *built != 0 {
		t.Errorf("%d transports were built for a stack with no recorded gateway", *built)
	}
}

func TestMCPAgainstARecordThatNamesNoGatewayIsRefused(t *testing.T) {
	built := noGatewayFixture(t)
	result := callTool(t, mcpClient(t), "browse_resources", map[string]any{})
	if !result.IsError || !strings.Contains(said(result), "names no gateway") || !strings.Contains(said(result), "semiont start") {
		t.Errorf("a call to a stack with no recorded gateway was not refused naming semiont start:\n%s", said(result))
	}
	if *built != 0 {
		t.Errorf("%d transports were built for a stack with no recorded gateway", *built)
	}
}
