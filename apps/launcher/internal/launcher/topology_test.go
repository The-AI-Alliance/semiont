package launcher

// Deployment topology is the launcher's to know, never the KB config's to
// declare. A config says WHAT a knowledge base needs; WHERE each daemon
// listens on this machine is a fact of the start that placed it.

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	toml "github.com/pelletier/go-toml/v2"
)

// fixtureConfig: one of the scenario KB's committed configs.
func fixtureConfig(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "testdata", "kb", ".semiont", "semiontconfig", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// addressLine: a line of a KB config that states where a daemon is reached.
var addressLine = regexp.MustCompile(`(?m)^(servers|uri|host|baseURL|issuer) = .*\n`)

// withoutAddresses: a config as a knowledge base writes it once it states no
// address — what the daemons are, and nothing of where.
func withoutAddresses(cfg []byte) []byte {
	return addressLine.ReplaceAll(cfg, nil)
}

// loadedFrom: loadConfig over config bytes, with the plan derived from them.
func loadedFrom(t *testing.T, cfg []byte) (*envConfig, *launchPlan) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, cfg, 0o644); err != nil {
		t.Fatal(err)
	}
	env, envName, _, err := loadConfig(path)
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	plan, err := derivePlan(env, envName, path, descriptorFor("identity", "keycloak").defaultPort)
	if err != nil {
		t.Fatalf("derivePlan: %v", err)
	}
	return env, plan
}

// stagedSection: [environments.local.<path...>] of a staged config.
func stagedSection(t *testing.T, staged []byte, path ...string) map[string]any {
	t.Helper()
	var doc map[string]any
	if err := toml.Unmarshal(staged, &doc); err != nil {
		t.Fatalf("the staged config is not valid TOML: %v\n%s", err, staged)
	}
	section := environmentSection(doc, "local")
	for _, name := range path {
		section, _ = section[name].(map[string]any)
	}
	return section
}

// A config that states no address is a whole config: the launcher places
// every daemon it names, exactly as it does for one that still writes each
// address as the launcher's own reference.
func TestAnUnstatedAddressIsTheLaunchersToPlace(t *testing.T) {
	for _, name := range []string{"ollama-gemma.toml", "anthropic.toml"} {
		_, written := loadedFrom(t, fixtureConfig(t, name))
		_, unstated := loadedFrom(t, withoutAddresses(fixtureConfig(t, name)))
		for role, want := range written.Roles {
			got := unstated.Roles[role]
			if got.Presence != want.Presence || got.Port != want.Port || got.Driver != want.Driver {
				t.Errorf("%s, %s: with no address stated the role is (%v, %s, port %d), want what the reference gave: (%v, %s, port %d)",
					name, role, got.Presence, got.Driver, got.Port, want.Presence, want.Driver, want.Port)
			}
		}
		for _, role := range []string{"graph", "vectors", "database", "messaging", "identity"} {
			if unstated.Roles[role].Presence != presenceLauncher {
				t.Errorf("%s: the launcher does not run the %s a config with no address names", name, role)
			}
		}
	}
}

// Every address the launcher places reaches a service as a literal in its own
// staged copy, whether the KB config left it unstated or wrote the launcher's
// reference. The copy loads in a container whose environment says nothing of
// topology.
func TestAStagedConfigStatesEveryPlacedAddressAsALiteral(t *testing.T) {
	const addr = "192.168.64.1"
	for _, c := range []struct {
		rt, issuer string
	}{
		{"container", "http://192.168.64.1:8080/realms/semiont"},
		{"docker", "http://" + identityHostName + ":8080/realms/semiont"},
	} {
		for name, cfg := range map[string][]byte{
			"as committed":      fixtureConfig(t, "ollama-gemma.toml"),
			"with no addresses": withoutAddresses(fixtureConfig(t, "ollama-gemma.toml")),
		} {
			_, plan := loadedFrom(t, cfg)
			vars := topologyVars(c.rt, addr, plan.Roles["identity"].Port)
			want := map[string]map[string]any{
				"graph":     {"uri": "bolt://192.168.64.1:7687"},
				"vectors":   {"host": addr, "port": int64(6333)},
				"embedding": {"baseURL": "http://192.168.64.1:11434"},
				"identity":  {"issuer": c.issuer},
			}
			for svc, sections := range serviceConfigSections {
				staged := stagedServiceConfig(svc, cfg, plan, vars, addr, "test-kb", "example.com")
				for section, keys := range want {
					if !contains(sections, section) {
						continue
					}
					for key, value := range keys {
						if got := stagedSection(t, staged, section)[key]; got != value {
							t.Errorf("%s (%s), %s: [%s] %s = %v, want the literal %v", c.rt, name, svc, section, key, got, value)
						}
					}
				}
				if contains(sections, "inference") {
					if got := stagedSection(t, staged, "inference", "ollama")["baseURL"]; got != "http://192.168.64.1:11434" {
						t.Errorf("%s (%s), %s: [inference.ollama] baseURL = %v, want the literal address", c.rt, name, svc, got)
					}
				}
				// Nothing a service reads is left for its environment to say.
				for _, section := range sections {
					b, _ := toml.Marshal(stagedSection(t, staged, section))
					for ref := range vars {
						if strings.Contains(string(b), "${"+ref) {
							t.Errorf("%s (%s), %s: [%s] still references ${%s}:\n%s", c.rt, name, svc, section, ref, b)
						}
					}
				}
			}
		}
	}
}

// An address a config states is the operator describing a topology the
// launcher cannot see: the daemon is somebody else's, and the address reaches
// each service as it was written.
func TestAStatedAddressIsStagedAsWritten(t *testing.T) {
	cfg := []byte(strings.Replace(string(withoutAddresses(fixtureConfig(t, "ollama-gemma.toml"))),
		"type = \"qdrant\"\nport = 6333\n", "type = \"qdrant\"\nhost = \"qdrant.internal\"\nport = 7000\n", 1))
	if !strings.Contains(string(cfg), "qdrant.internal") {
		t.Fatal("the fixture's [vectors] no longer reads as this test expects")
	}
	_, plan := loadedFrom(t, cfg)
	if got := plan.Roles["vectors"]; got.Presence != presenceExternal || got.Address != "qdrant.internal" {
		t.Fatalf("a stated vector store is planned as (%v, %q), want somebody else's at qdrant.internal", got.Presence, got.Address)
	}
	vars := topologyVars("container", "192.168.64.1", plan.Roles["identity"].Port)
	vectors := stagedSection(t, stagedServiceConfig("smelter", cfg, plan, vars, "192.168.64.1", "test-kb", "example.com"), "vectors")
	if vectors["host"] != "qdrant.internal" || vectors["port"] != int64(7000) {
		t.Errorf("the stated vector store was staged as %v, want it as written", vectors)
	}
}

// Staging resolves the launcher's references and nothing else: a secret and an
// operator's own variable are the consumer's loader's to resolve, defaults
// included.
func TestStagingResolvesOnlyTheLaunchersReferences(t *testing.T) {
	vars := topologyVars("container", "192.168.64.1", 8080)
	for written, want := range map[string]string{
		"bolt://${NEO4J_HOST}:7687":                    "bolt://192.168.64.1:7687",
		"http://${OLLAMA_HOST:-localhost}:11434":       "http://192.168.64.1:11434",
		"http://${KEYCLOAK_HOST}:${KEYCLOAK_PORT}/r/x": "http://192.168.64.1:8080/r/x",
		"${ANTHROPIC_API_KEY}":                         "${ANTHROPIC_API_KEY}",
		"http://${GATEWAY_HOST:-localhost}:4000":       "http://${GATEWAY_HOST:-localhost}:4000",
		"graph.internal":                               "graph.internal",
	} {
		if got := resolveTopology(written, vars); got != want {
			t.Errorf("%q staged as %q, want %q", written, got, want)
		}
	}
}

// A section a service does not read is staged as the KB config wrote it: the
// launcher says only what each consumer needs.
func TestStagingLeavesWhatAServiceDoesNotRead(t *testing.T) {
	cfg := fixtureConfig(t, "ollama-gemma.toml")
	_, plan := loadedFrom(t, cfg)
	vars := topologyVars("container", "192.168.64.1", plan.Roles["identity"].Port)
	staged := stagedServiceConfig("weaver", cfg, plan, vars, "192.168.64.1", "test-kb", "example.com")
	if contains(serviceConfigSections["weaver"], "vectors") {
		t.Fatal("the weaver reads [vectors] now: pick another section for this test")
	}
	if got := stagedSection(t, staged, "vectors")["host"]; got != "${QDRANT_HOST}" {
		t.Errorf("[vectors] host in the weaver's copy = %v, want it as written", got)
	}
}

// The archivist's address and the KB's identity card are staged as before:
// for the services that dial it or describe it, and never over a hand-written
// section.
func TestStagingPlacesTheArchivistAndTheIdentityCard(t *testing.T) {
	cfg := withoutAddresses(fixtureConfig(t, "ollama-gemma.toml"))
	_, plan := loadedFrom(t, cfg)
	vars := topologyVars("container", "192.168.64.1", plan.Roles["identity"].Port)
	port := int64(semiontDescriptor("archivist").ports[0].port)
	for svc := range serviceConfigSections {
		staged := stagedServiceConfig(svc, cfg, plan, vars, "192.168.64.1", "test-kb", "example.com")
		archivist := stagedSection(t, staged, "archivist")
		switch {
		case archivistDialers[svc] && (archivist["host"] != "192.168.64.1" || archivist["port"] != port):
			t.Errorf("%s dials the archivist, and its copy says %v", svc, archivist)
		case !archivistDialers[svc] && archivist != nil:
			t.Errorf("%s does not dial the archivist, and its copy says %v", svc, archivist)
		}
		var doc map[string]any
		if err := toml.Unmarshal(staged, &doc); err != nil {
			t.Fatal(err)
		}
		kb, _ := doc["kb"].(map[string]any)
		switch {
		case kbIdentityStaged[svc] && (kb["name"] != "test-kb" || kb["domain"] != "example.com"):
			t.Errorf("%s describes a tree it does not mount, and its copy's [kb] is %v", svc, kb)
		case !kbIdentityStaged[svc] && kb != nil:
			t.Errorf("%s mounts or needs no identity card, and its copy's [kb] is %v", svc, kb)
		}
	}
	handWritten := append(append([]byte{}, cfg...), "\n[environments.local.archivist]\nhost = \"archivist.internal\"\nport = 9999\n\n[kb]\nname = \"elsewhere\"\n"...)
	_, plan = loadedFrom(t, handWritten)
	staged := stagedServiceConfig("librarian", handWritten, plan, vars, "192.168.64.1", "test-kb", "example.com")
	if a := stagedSection(t, staged, "archivist"); a["host"] != "archivist.internal" || a["port"] != int64(9999) {
		t.Errorf("a hand-written archivist section was staged as %v", a)
	}
	var doc map[string]any
	_ = toml.Unmarshal(staged, &doc)
	if kb, _ := doc["kb"].(map[string]any); kb["name"] != "elsewhere" {
		t.Errorf("a hand-written [kb] was staged as %v", kb)
	}
	// A KB that declares no domain is staged none: the consumer's refusal is
	// the point, and a fabricated identity is the one outcome worse than it.
	_ = toml.Unmarshal(stagedServiceConfig("librarian", cfg, plan, vars, "192.168.64.1", "test-kb", ""), &doc)
	if kb, _ := doc["kb"].(map[string]any); kb["name"] != "test-kb" || kb["domain"] != nil {
		t.Errorf("a KB with no declared domain was staged the card %v", kb)
	}
	// A section for another environment is not this one's.
	other := append(append([]byte{}, cfg...), "\n[environments.production.archivist]\nhost = \"archivist.example.com\"\nport = 9999\n"...)
	_, plan = loadedFrom(t, other)
	if a := stagedSection(t, stagedServiceConfig("worker", other, plan, vars, "192.168.64.1", "test-kb", "example.com"), "archivist"); a["host"] != "192.168.64.1" {
		t.Errorf("another environment's archivist section suppressed this one's: %v", a)
	}
	// TOML the launcher cannot read is the consumer's loader's to refuse.
	if out := stagedServiceConfig("worker", []byte("not [toml"), plan, vars, "192.168.64.1", "test-kb", "example.com"); string(out) != "not [toml" {
		t.Errorf("invalid TOML was rewritten:\n%s", out)
	}
}

// No container is told where anything is through its environment, and the
// launcher asks no user for an address it places.
func TestNoTopologyTravelsInAnEnvironment(t *testing.T) {
	placed := topologyVars("container", "192.168.64.1", 8080)
	if len(placed) == 0 {
		t.Fatal("topologyVars resolves nothing: this test would pass for the wrong reason")
	}
	builders := map[string][]string{
		"gateway":    gatewayArgs("/stage", "docker", "192.168.64.1", "secret", "jwt", "latest", 4000, nil, nil),
		"worker":     sidecarArgs("worker", 24100, "/stage", "docker", "192.168.64.1", "secret", "latest", nil, nil),
		"archivist":  archivistArgs("/kb", "/stage", "docker", "192.168.64.1", "secret", "latest", nil, nil),
		"librarian":  librarianArgs("/stage", "docker", "192.168.64.1", "secret", "latest", nil, nil),
		"dispatcher": dispatcherArgs("/stage", "docker", "192.168.64.1", "secret", "latest", nil, nil),
	}
	set := map[string]bool{}
	for svc, args := range builders {
		for i, a := range args {
			if a != "--env" || i+1 >= len(args) {
				continue
			}
			name, _, _ := strings.Cut(args[i+1], "=")
			set[name] = true
			if _, isPlaced := placed[name]; isPlaced {
				t.Errorf("%s is handed %s in its environment", svc, name)
			}
		}
	}
	// The two lists that once disagreed are one: a variable the launcher says
	// it injects is one a service is in fact handed, and none of them is an
	// address resolved at staging.
	for name := range injectedVars {
		if !set[name] {
			t.Errorf("injectedVars names %s, and no service is handed it", name)
		}
		if _, isPlaced := placed[name]; isPlaced {
			t.Errorf("%s is resolved at staging and also listed as injected", name)
		}
	}
	// A config that still writes the references asks the user for none of them.
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, fixtureConfig(t, "ollama-gemma.toml"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, _, refs, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	required, optional := refs.read("")
	for _, name := range append(required, optional...) {
		if _, isPlaced := placed[name]; isPlaced {
			t.Errorf("a start demands %s of the user's environment", name)
		}
	}
}

// A generated config states no address: a new knowledge base's config is the
// same on every machine.
func TestAGeneratedConfigStatesNoAddress(t *testing.T) {
	for _, inference := range []string{"ollama", "anthropic"} {
		content := generateSemiontconfig(genParams{Inference: inference, Model: "m", EmbeddingModel: "e"})
		if stated := addressLine.FindAllString(content, -1); len(stated) > 0 {
			t.Errorf("%s: the generated config states %d addresses:\n%s", inference, len(stated), strings.Join(stated, ""))
		}
		for name := range topologyVars("container", "192.168.64.1", 8080) {
			if strings.Contains(content, "${"+name) {
				t.Errorf("%s: the generated config references ${%s}", inference, name)
			}
		}
		// A reference it does write is one the launcher injects, or the
		// provider's key: nothing a new knowledge base's first start would
		// demand that the launcher itself could have supplied.
		for _, m := range placeholderRe.FindAllStringSubmatch(content, -1) {
			if name, _, _ := strings.Cut(m[1], ":-"); !injectedVars[name] && name != "ANTHROPIC_API_KEY" {
				t.Errorf("%s: the generated config references ${%s}, which the launcher does not inject", inference, name)
			}
		}
		// It is still a config the launcher can start.
		_, plan := loadedFrom(t, []byte(content))
		if plan.Roles["graph"].Presence != presenceLauncher || plan.Roles["messaging"].Presence != presenceLauncher {
			t.Errorf("%s: the launcher does not place the daemons of the config it generated", inference)
		}
	}
}
