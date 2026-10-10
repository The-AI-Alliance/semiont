package launcher

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeConfigTOML(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "semiontconfig.toml")
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

const localDefaults = "[defaults]\nenvironment = \"local\"\n\n"

// The gateway's section has one name. A section under another name is one the
// launcher does not model: the config loads, and it declares no gateway, so a
// start gets the refusal every config without a gateway gets.
func TestTheGatewaySectionHasOneName(t *testing.T) {
	t.Run("gateway: read", func(t *testing.T) {
		p := writeConfigTOML(t, localDefaults+"[environments.local.gateway]\nplatform = \"posix\"\nport = 3001\n")
		env, _, _, err := loadConfig(p)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if env.Gateway == nil {
			t.Fatal("the gateway section was not read")
		}
		if env.Gateway.Port != 3001 {
			t.Errorf("port = %d, want 3001", env.Gateway.Port)
		}
	})

	t.Run("backend only: no gateway", func(t *testing.T) {
		p := writeConfigTOML(t, localDefaults+"[environments.local.backend]\nplatform = \"posix\"\nport = 3001\npublicURL = \"http://localhost:3001\"\n")
		env, _, _, err := loadConfig(p)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if env.Gateway != nil {
			t.Errorf("a [backend] section was read as the gateway's: %+v", env.Gateway)
		}
		if env.declaresRole("gateway") {
			t.Error("a [backend] section declares the gateway role")
		}
		_, err = dispatcherDocument(env, "container", "192.168.64.1", 8080, nil, false)
		if err == nil || !strings.Contains(err.Error(), "declares no [gateway] publicURL") {
			t.Errorf("want the refusal of an environment with no gateway, got %v", err)
		}
	})
}

// A generated config declares the gateway: the Archivist's, the worker's and
// the dispatcher's documents refuse an environment without one.
func TestAGeneratedConfigDeclaresTheGateway(t *testing.T) {
	out := generateSemiontconfig(genParams{Inference: "anthropic", Model: "m", EmbeddingModel: "nomic-embed-text"})
	if !strings.Contains(out, "[environments.local.gateway]") {
		t.Error("generated config does not use the [gateway] section")
	}
}

func TestLoadConfigRefusesAnEnvironmentSite(t *testing.T) {
	// In every environment, selected or not: the whole file is staged into each
	// service, and the services' loader refuses the section wherever it is.
	path := filepath.Join(t.TempDir(), "sited.toml")
	body := "[defaults]\nenvironment = \"local\"\n\n[environments.local.gateway]\nport = 4000\n\n" +
		"[environments.prod.site]\nsiteName = \"Prod\"\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	_, _, _, err := loadConfig(path)
	if err == nil || !strings.Contains(err.Error(), "[environments.prod.site]") || !strings.Contains(err.Error(), path) {
		t.Fatalf("want a refusal naming [environments.prod.site] and %s, got %v", path, err)
	}
}
