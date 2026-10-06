package launcher

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
)

// The KB config a `semiont init` writes, as far as the Archivist's document
// reads it.
const archivistDocFixture = `[defaults]
environment = "local"

[environments.local]
logLevel = "debug"

[environments.local.gateway]
platform = "container"
port = 4000
publicURL = "http://${GATEWAY_HOST:-localhost}:4000"

[environments.local.identity]
type = "keycloak"
issuer = "http://${KEYCLOAK_HOST}:8080/realms/semiont"
subjectClaim = "sub"

[environments.local.workers.default.inference]
type = "anthropic"
model = "claude-haiku-4-5"
`

func archivistDocumentFrom(t *testing.T, b []byte) semiont.ArchivistConfig {
	t.Helper()
	var doc semiont.ArchivistConfig
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&doc); err != nil {
		t.Fatalf("the document is not an ArchivistConfig: %v\n%s", err, b)
	}
	return doc
}

// Resolved: every ${VAR} a value, and every path the one the launcher mounts
// onto. The gateway host is the launcher's address, not the Archivist's own
// container.
func TestArchivistDocumentIsResolved(t *testing.T) {
	b, err := archivistDocument(envFrom(t, archivistDocFixture), "container", "192.168.64.1", 8080, nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "${") {
		t.Fatalf("an unresolved reference reached the document:\n%s", b)
	}
	doc := archivistDocumentFrom(t, b)
	if doc.GatewayUrl != "http://192.168.64.1:4000" {
		t.Errorf("gatewayUrl = %q, want the gateway at the launcher's address", doc.GatewayUrl)
	}
	if doc.Identity.Issuer != "http://192.168.64.1:8080/realms/semiont" {
		t.Errorf("issuer = %q", doc.Identity.Issuer)
	}
	if doc.Root != kbMountTarget || doc.AnchoredTextDir != stateStores["anchored-text"].mounts[0].target || doc.StateHome != stateStores["state"].mounts[0].target {
		t.Errorf("root = %q, anchoredTextDir = %q, stateHome = %q: want the paths the launcher mounts onto", doc.Root, doc.AnchoredTextDir, doc.StateHome)
	}
	if doc.Port != semiontDescriptor("archivist").ports[0].port {
		t.Errorf("port = %d, want the descriptor's", doc.Port)
	}
	if doc.SkipRebuild {
		t.Error("skipRebuild is set: a started Archivist rebuilds its views")
	}
	if doc.Staging.FlushMs != 250 || doc.Staging.MaxWaitMs != 2_000 {
		t.Errorf("staging = %+v, want the bounds a deployment runs with", doc.Staging)
	}
	if doc.LogLevel != "debug" || doc.LogFormat != semiont.Json {
		t.Errorf("log = %q %q", doc.LogLevel, doc.LogFormat)
	}
	if doc.Roster.Workers.Generation == nil || doc.Roster.Workers.Generation.Model != "claude-haiku-4-5" {
		t.Errorf("roster = %+v, want workers.default serving generation", doc.Roster)
	}
}

func TestArchivistDocumentRefusesAMissingGatewayOrIssuer(t *testing.T) {
	noGateway := strings.Replace(archivistDocFixture, `publicURL = "http://${GATEWAY_HOST:-localhost}:4000"`, "", 1)
	if _, err := archivistDocument(envFrom(t, noGateway), "container", "192.168.64.1", 8080, nil); err == nil || !strings.Contains(err.Error(), "publicURL") {
		t.Errorf("no publicURL: want a refusal naming it, got %v", err)
	}
	env := envFrom(t, archivistDocFixture)
	env.Identity = nil
	if _, err := archivistDocument(env, "container", "192.168.64.1", 8080, nil); err == nil || !strings.Contains(err.Error(), "identity") {
		t.Errorf("no [identity]: want a refusal naming it, got %v", err)
	}
}

// A binding that names half an agent, or a provider Semiont has no client
// for, is refused by its place in the config.
func TestArchivistRosterRefusesAMalformedBinding(t *testing.T) {
	for field, binding := range map[string]string{
		"workers.generation":           "[environments.local.workers.generation.inference]\ntype = \"anthropic\"\n",
		"actors.matcher":               "[environments.local.actors.matcher.inference]\nmodel = \"m\"\n",
		"make-meaning.default":         "[environments.local.make-meaning.default.inference]\ntype = \"openai\"\nmodel = \"m\"\n",
		"make-meaning.actors.gatherer": "[environments.local.make-meaning.actors.gatherer.inference]\ntype = \"ollama\"\n",
	} {
		_, err := archivistDocument(envFrom(t, archivistDocFixture+"\n"+binding), "container", "192.168.64.1", 8080, nil)
		if err == nil || !strings.Contains(err.Error(), field+".inference") {
			t.Errorf("%s: want a refusal naming it, got %v", field, err)
		}
	}
}

// TestRosterAgreesWithTheSharedTable runs every case in
// specs/src/service-config/roster-cases.json through the launcher's
// resolution. The TypeScript loader, which the worker and the Librarian route
// work by, runs the same table (packages/core toml-loader.test.ts); together
// they gate a mirror that spans languages and cannot be generated.
func TestRosterAgreesWithTheSharedTable(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "specs", "src", "service-config", "roster-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var table struct {
		Cases []struct {
			Why    string          `json:"why"`
			Config string          `json:"config"`
			Roster json.RawMessage `json:"roster"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(b, &table); err != nil {
		t.Fatal(err)
	}
	if len(table.Cases) == 0 {
		t.Fatal("the shared table has no cases: a gate that runs nothing passes on silence")
	}
	for _, c := range table.Cases {
		t.Run(c.Why, func(t *testing.T) {
			got, err := archivistRoster(envFrom(t, c.Config))
			if err != nil {
				t.Fatal(err)
			}
			var want semiont.ArchivistRoster
			dec := json.NewDecoder(strings.NewReader(string(c.Roster)))
			dec.DisallowUnknownFields()
			if err := dec.Decode(&want); err != nil {
				t.Fatalf("the case's roster is not an ArchivistRoster: %v", err)
			}
			if !reflect.DeepEqual(got, want) {
				gotJSON, _ := json.Marshal(got)
				t.Errorf("roster = %s\nwant     %s", gotJSON, c.Roster)
			}
		})
	}
}

// The launcher mounts the document where the image's command points --config,
// and hands the Archivist no address by environment: the document carries
// them.
func TestArchivistDocumentIsMountedAndNoHostVariableIsPassed(t *testing.T) {
	args := strings.Join(archivistArgs("/host/kb", "/stage", "container", "1.2.3.4", "client-secret", "v", nil, nil), " ")
	if want := "/stage/" + archivistDocumentFile + ":" + archivistDocumentTarget + ":ro"; !strings.Contains(args, want) {
		t.Errorf("the Archivist's document is not mounted (%s):\n%s", want, args)
	}
	for _, unwanted := range []string{"GATEWAY_HOST", "BACKEND_HOST", "XDG_STATE_HOME", ".semiontconfig"} {
		if strings.Contains(args, unwanted) {
			t.Errorf("the Archivist is handed %s, which its document replaces:\n%s", unwanted, args)
		}
	}
}
