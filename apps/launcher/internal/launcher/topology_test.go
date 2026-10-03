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

// A daemon somebody else runs (`platform = "external"`) is a topology the
// launcher cannot see: its address is the config's to state, and reaches each
// service as it was written.
func TestAStatedAddressIsStagedAsWritten(t *testing.T) {
	cfg := []byte(strings.Replace(string(withoutAddresses(fixtureConfig(t, "ollama-gemma.toml"))),
		"type = \"qdrant\"\nport = 6333\n", "platform = \"external\"\ntype = \"qdrant\"\nhost = \"qdrant.internal\"\nport = 7000\n", 1))
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

// `platform = "external"` is how a config says somebody else runs a daemon.
// The section then states where it is, and the launcher verifies it and
// launches nothing.
func TestPlatformExternalSaysSomebodyElseRunsTheDaemon(t *testing.T) {
	for _, c := range []struct {
		role, section, body, address string
	}{
		{"graph", "graph", "[environments.local.graph]\nplatform = \"external\"\ntype = \"neo4j\"\nuri = \"bolt://graph.internal:7687\"\nusername = \"neo4j\"\npassword = \"${GRAPH_PASSWORD}\"\n", "graph.internal"},
		{"vectors", "vectors", "[environments.local.vectors]\nplatform = \"external\"\ntype = \"qdrant\"\nhost = \"qdrant.internal\"\n", "qdrant.internal"},
		{"database", "database", "[environments.local.database]\nplatform = \"external\"\nhost = \"pg.internal\"\nname = \"semiont\"\nuser = \"postgres\"\npassword = \"${PG_PASSWORD}\"\n", "pg.internal"},
		{"messaging", "jobs", "[environments.local.jobs]\nplatform = \"external\"\ntype = \"jetstream\"\nservers = \"nats.internal:4222\"\nuser = \"${BROKER_USER}\"\npassword = \"${BROKER_PASSWORD}\"\n", "nats.internal"},
		{"identity", "identity", "[environments.local.identity]\nplatform = \"external\"\ntype = \"keycloak\"\nissuer = \"https://login.example.com/realms/kb\"\nsubjectClaim = \"sub\"\n", "login.example.com"},
		{"embedding", "embedding", "[environments.local.embedding]\nplatform = \"external\"\ntype = \"ollama\"\nmodel = \"nomic-embed-text\"\nbaseURL = \"http://gpu.internal:11434\"\n", "gpu.internal"},
	} {
		plan := mustDerive(t, variantConfig(t, map[string]string{c.section: c.body}))
		if rp := plan.Roles[c.role]; rp.Presence != presenceExternal || rp.Address != c.address {
			t.Errorf("%s: planned as (%v, %q), want somebody else's at %s", c.role, rp.Presence, rp.Address, c.address)
		}
	}
}

// refusal: derivePlan refuses the config variant, and the refusal says each
// of the wanted things.
func refusal(t *testing.T, replace map[string]string, want ...string) {
	t.Helper()
	path := variantConfig(t, replace)
	env, envName, _, err := loadConfig(path)
	if err == nil {
		_, err = derivePlan(env, envName, "variant.toml", 8080)
	}
	if err == nil {
		t.Errorf("the config was accepted; want a refusal naming %v", want)
		return
	}
	for _, w := range want {
		if !strings.Contains(err.Error(), w) {
			t.Errorf("the refusal %q does not say %q", err, w)
		}
	}
}

// A section that says somebody else runs its daemon states where: the
// launcher has no address to give it.
func TestPlatformExternalStatesItsAddress(t *testing.T) {
	refusal(t, map[string]string{"graph": "[environments.local.graph]\nplatform = \"external\"\ntype = \"neo4j\"\nusername = \"neo4j\"\n"}, "graph", "uri", `platform = "external"`)
	refusal(t, map[string]string{"vectors": "[environments.local.vectors]\nplatform = \"external\"\ntype = \"qdrant\"\n"}, "vectors", "host", `platform = "external"`)
	refusal(t, map[string]string{"database": "[environments.local.database]\nplatform = \"external\"\nname = \"semiont\"\n"}, "database", "host", `platform = "external"`)
	refusal(t, map[string]string{"jobs": "[environments.local.jobs]\nplatform = \"external\"\ntype = \"jetstream\"\n"}, "jobs", "servers", `platform = "external"`)
	refusal(t, map[string]string{"embedding": "[environments.local.embedding]\nplatform = \"external\"\ntype = \"ollama\"\nmodel = \"m\"\n"}, "embedding", "baseURL", `platform = "external"`)
	refusal(t, map[string]string{"identity": "[environments.local.identity]\nplatform = \"external\"\ntype = \"keycloak\"\nsubjectClaim = \"sub\"\n"}, "identity", "issuer")
}

// An address is stated only for a daemon somebody else runs. One stated
// without `platform = "external"` is two answers to who runs it, so the
// launcher refuses and says both ways out.
func TestAStatedAddressNeedsPlatformExternal(t *testing.T) {
	refusal(t, map[string]string{"graph": "[environments.local.graph]\nplatform = \"container\"\ntype = \"neo4j\"\nuri = \"bolt://graph.internal:7687\"\nusername = \"neo4j\"\n"}, "graph", "uri", `platform = "external"`, "delete")
	refusal(t, map[string]string{"vectors": "[environments.local.vectors]\ntype = \"qdrant\"\nhost = \"qdrant.internal\"\n"}, "vectors", "host", `platform = "external"`, "delete")
	refusal(t, map[string]string{"database": "[environments.local.database]\nplatform = \"container\"\nhost = \"pg.internal\"\nname = \"semiont\"\n"}, "database", "host", `platform = "external"`)
	refusal(t, map[string]string{"jobs": "[environments.local.jobs]\ntype = \"jetstream\"\nservers = \"nats.internal:4222\"\n"}, "jobs", "servers", `platform = "external"`)
	refusal(t, map[string]string{"embedding": "[environments.local.embedding]\ntype = \"ollama\"\nmodel = \"m\"\nbaseURL = \"http://gpu.internal:11434\"\n"}, "embedding", "baseURL", `platform = "external"`)
	refusal(t, map[string]string{"identity": "[environments.local.identity]\ntype = \"keycloak\"\nissuer = \"https://login.example.com/realms/kb\"\nsubjectClaim = \"sub\"\n"}, "identity", "issuer", `platform = "external"`)
}

// The shape the fleet's configs were committed in says `platform = "external"`
// on a graph, a database and an embedding the launcher runs, each with its
// address written as the launcher's own reference. That reference is the
// launcher's whatever the platform says, so those configs start as they did.
func TestTheLaunchersReferenceIsTheLaunchersUnderAnyPlatform(t *testing.T) {
	plan := mustDerive(t, variantConfig(t, map[string]string{
		"graph":     "[environments.local.graph]\nplatform = \"external\"\ntype = \"neo4j\"\nuri = \"bolt://${NEO4J_HOST}:7687\"\nusername = \"neo4j\"\n",
		"database":  "[environments.local.database]\nplatform = \"external\"\nhost = \"${POSTGRES_HOST}\"\nport = 5432\nname = \"semiont\"\nuser = \"postgres\"\n",
		"embedding": "[environments.local.embedding]\nplatform = \"external\"\ntype = \"ollama\"\nmodel = \"nomic-embed-text\"\nbaseURL = \"http://${OLLAMA_HOST}:11434\"\n",
	}))
	for _, role := range []string{"graph", "database"} {
		if plan.Roles[role].Presence != presenceLauncher {
			t.Errorf("%s: planned as %v, want the launcher's", role, plan.Roles[role].Presence)
		}
	}
	if rp := plan.Roles["embedding"]; rp.Presence != presenceHostPreferred {
		t.Errorf("embedding: planned as %v, want the launcher's own Ollama", rp.Presence)
	}
}

// What a config says of who runs each daemon is what the launcher does: in
// the scenario KB's configs and in every config the launcher generates, a
// section says `platform = "external"` exactly when its daemon is planned as
// somebody else's.
func TestOnlyAnExternalDaemonSaysPlatformExternal(t *testing.T) {
	configs := map[string][]byte{
		"ollama-gemma.toml":   fixtureConfig(t, "ollama-gemma.toml"),
		"anthropic.toml":      fixtureConfig(t, "anthropic.toml"),
		"generated ollama":    []byte(generateSemiontconfig(genParams{Inference: "ollama", Model: "m", EmbeddingModel: "e"})),
		"generated anthropic": []byte(generateSemiontconfig(genParams{Inference: "anthropic", Model: "m", EmbeddingModel: "e"})),
	}
	roleOf := map[string]string{"graph": "graph", "vectors": "vectors", "database": "database", "jobs": "messaging"}
	for name, cfg := range configs {
		_, plan := loadedFrom(t, cfg)
		var doc map[string]any
		if err := toml.Unmarshal(cfg, &doc); err != nil {
			t.Fatal(err)
		}
		env := environmentSection(doc, "local")
		for section, role := range roleOf {
			table, ok := env[section].(map[string]any)
			if !ok {
				continue
			}
			says := table["platform"] == "external"
			if is := plan.Roles[role].Presence == presenceExternal; says != is {
				t.Errorf("%s: [%s] says platform = %v, and the launcher plans its %s as %v", name, section, table["platform"], role, plan.Roles[role].Presence)
			}
		}
		// The local Ollama is the launcher's, whichever section names it.
		if table, ok := env["embedding"].(map[string]any); ok && table["type"] == "ollama" && table["platform"] == "external" {
			t.Errorf("%s: [embedding] says platform = external of the Ollama this stack runs", name)
		}
	}
}

// [jobs] and [signal] name one broker, so they agree on who runs it.
func TestTheBrokersTwoSectionsAgreeOnWhoRunsIt(t *testing.T) {
	const pair = "user = \"${BROKER_USER}\"\npassword = \"${BROKER_PASSWORD}\"\n"
	refusal(t, map[string]string{
		"jobs":   "[environments.local.jobs]\nplatform = \"external\"\ntype = \"jetstream\"\nservers = \"nats.internal:4222\"\n" + pair,
		"signal": "[environments.local.signal]\ntype = \"nats\"\nservers = \"nats.internal:4222\"\n" + pair,
	}, "signal", "who runs the broker")
	plan := mustDerive(t, variantConfig(t, map[string]string{
		"jobs":   "[environments.local.jobs]\nplatform = \"external\"\ntype = \"jetstream\"\nservers = \"nats.internal:4222\"\n" + pair,
		"signal": "[environments.local.signal]\nplatform = \"external\"\ntype = \"nats\"\nservers = \"nats.internal:4222\"\n" + pair,
	}))
	if rp := plan.Roles["messaging"]; rp.Presence != presenceExternal || rp.Address != "nats.internal" {
		t.Errorf("the broker is planned as (%v, %q), want somebody else's at nats.internal", rp.Presence, rp.Address)
	}
}
