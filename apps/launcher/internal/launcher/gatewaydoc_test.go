package launcher

import (
	"encoding/json"
	"strings"
	"testing"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	toml "github.com/pelletier/go-toml/v2"
)

// The KB config a `semiont init` writes, as far as the gateway reads it.
const gatewayDocFixture = `[defaults]
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

[environments.local.signal]
type = "nats"
servers = "${NATS_HOST}:4222"
`

func envFrom(t *testing.T, text string) *envConfig {
	t.Helper()
	var cfg semiontConfig
	if err := toml.Unmarshal([]byte(text), &cfg); err != nil {
		t.Fatalf("fixture is not valid TOML: %v", err)
	}
	env := cfg.Environments[cfg.Defaults.Environment]
	if err := resolveGatewaySection(&env, "fixture", cfg.Defaults.Environment); err != nil {
		t.Fatal(err)
	}
	return &env
}

func documentFrom(t *testing.T, b []byte) semiont.GatewayConfig {
	t.Helper()
	var doc semiont.GatewayConfig
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&doc); err != nil {
		t.Fatalf("the document is not a GatewayConfig: %v\n%s", err, b)
	}
	return doc
}

// Resolved: every ${VAR} a value, as the gateway's own loader would have
// resolved it in the container the launcher starts — the dependency hosts are
// the launcher's address, and GATEWAY_HOST, which the gateway never receives,
// takes its default.
func TestGatewayDocumentIsResolved(t *testing.T) {
	b, err := gatewayDocument(envFrom(t, gatewayDocFixture), "Example KB", "example.github.io:example-kb", "container", "192.168.64.1", 4000, nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "${") {
		t.Fatalf("an unresolved reference reached the document:\n%s", b)
	}
	doc := documentFrom(t, b)
	if doc.Kb.Name != "Example KB" || doc.Kb.Domain != "example.github.io:example-kb" {
		t.Errorf("kb = %+v, want the committed name and domain", doc.Kb)
	}
	if doc.Port != 4000 || doc.PublicUrl != "http://localhost:4000" {
		t.Errorf("port %d, publicUrl %q", doc.Port, doc.PublicUrl)
	}
	if doc.Identity.Issuer != "http://192.168.64.1:8080/realms/semiont" || doc.Identity.SubjectClaim != "sub" {
		t.Errorf("identity = %+v", doc.Identity)
	}
	if doc.Archivist.Host != "192.168.64.1" || doc.Archivist.Port != semiontDescriptor("archivist").ports[0].port {
		t.Errorf("archivist = %+v, want the launcher's address and the descriptor's port", doc.Archivist)
	}
	if doc.Signal.Type != "nats" || doc.Signal.Servers == nil || *doc.Signal.Servers != "192.168.64.1:4222" {
		t.Errorf("signal = %+v", doc.Signal)
	}
	if doc.LogLevel != "debug" {
		t.Errorf("logLevel = %q", doc.LogLevel)
	}
}

// The issuer is ONE URL — a token's `iss` is the URL it was asked from, and the
// gateway verifies it — so it must be one the laptop's Browser and every
// container reach alike. Under Docker and Podman the laptop is never promised
// the host address — an alias that resolves only inside containers, or in
// docker-in-docker a bridge gateway on another machine — so there the issuer
// is named on keycloak.localhost; the other dependencies keep the host
// address, which only containers dial.
func TestGatewayDocumentNamesAnIssuerTheLaptopReaches(t *testing.T) {
	for _, c := range []struct{ rt, addr string }{
		{"docker", "host.docker.internal"},
		{"docker", "172.17.0.1"},
		{"podman", "host.containers.internal"},
		{"podman", "172.17.0.1"},
	} {
		b, err := gatewayDocument(envFrom(t, gatewayDocFixture), "Example KB", "example.github.io:example-kb", c.rt, c.addr, 4000, nil)
		if err != nil {
			t.Fatal(err)
		}
		doc := documentFrom(t, b)
		if doc.Identity.Issuer != "http://keycloak.localhost:8080/realms/semiont" {
			t.Errorf("%s at %s: issuer %q, want one the laptop resolves as well as the containers", c.rt, c.addr, doc.Identity.Issuer)
		}
		if doc.Signal.Servers == nil || *doc.Signal.Servers != c.addr+":4222" {
			t.Errorf("%s at %s: signal = %+v, want the broker on the host address", c.rt, c.addr, doc.Signal)
		}
	}
}

// Secrets are named, never carried: a broker credential is a ${NAME} in the
// KB config, and the document names NAME.
func TestGatewayDocumentNamesSecretsAndNeverCarriesThem(t *testing.T) {
	text := gatewayDocFixture + "user = \"${NATS_USER}\"\npassword = \"${NATS_PASSWORD}\"\n"
	userEnv := []string{"--env", "NATS_USER=the-user-value", "--env", "NATS_PASSWORD=the-password-value"}
	b, err := gatewayDocument(envFrom(t, text), "Example KB", "example.github.io:example-kb", "container", "192.168.64.1", 4000, userEnv)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"the-user-value", "the-password-value"} {
		if strings.Contains(string(b), secret) {
			t.Fatalf("a secret value reached the document:\n%s", b)
		}
	}
	doc := documentFrom(t, b)
	if doc.Signal.UserEnv == nil || *doc.Signal.UserEnv != "NATS_USER" || doc.Signal.PasswordEnv == nil || *doc.Signal.PasswordEnv != "NATS_PASSWORD" {
		t.Errorf("signal = %+v, want the credentials named", doc.Signal)
	}
}

func TestGatewayDocumentRefusesALiteralSecret(t *testing.T) {
	text := gatewayDocFixture + "password = \"hunter2\"\n"
	_, err := gatewayDocument(envFrom(t, text), "Example KB", "example.github.io:example-kb", "container", "192.168.64.1", 4000, nil)
	if err == nil || !strings.Contains(err.Error(), "signal") || !strings.Contains(err.Error(), "${") {
		t.Fatalf("want a refusal naming the field and the ${VAR} form, got %v", err)
	}
	if strings.Contains(err.Error(), "hunter2") {
		t.Fatalf("the refusal repeated the secret: %v", err)
	}
}

// Absent sections are decided here and nowhere else: no [signal] is the
// in-process plane, no logLevel is info, the log format is JSON (a KB config
// names none), and a hand-written archivist section — a topology the
// launcher cannot see — wins over its address.
func TestGatewayDocumentFillsWhatTheConfigLeavesOut(t *testing.T) {
	text := strings.Replace(gatewayDocFixture, "[environments.local.signal]\ntype = \"nats\"\nservers = \"${NATS_HOST}:4222\"\n", "", 1)
	text = strings.Replace(text, "logLevel = \"debug\"\n", "", 1)
	text += "\n[environments.local.archivist]\nhost = \"archivist.internal\"\nport = 9999\n"
	b, err := gatewayDocument(envFrom(t, text), "Example KB", "example.github.io:example-kb", "container", "192.168.64.1", 4000, nil)
	if err != nil {
		t.Fatal(err)
	}
	doc := documentFrom(t, b)
	if doc.Signal.Type != "in-process" || doc.Signal.Servers != nil {
		t.Errorf("signal = %+v, want in-process", doc.Signal)
	}
	if doc.LogLevel != "info" {
		t.Errorf("logLevel = %q, want info", doc.LogLevel)
	}
	if doc.LogFormat != semiont.Json {
		t.Errorf("logFormat = %q, want json", doc.LogFormat)
	}
	if doc.Archivist.Host != "archivist.internal" || doc.Archivist.Port != 9999 {
		t.Errorf("archivist = %+v, want the hand-written section", doc.Archivist)
	}
}

// The gateway's capacity follows from the memory its container is given: for
// the 2G gateway, a gibibyte of bytes queued to its streams, and connections at
// 20 KiB each of the other half.
func TestGatewayDocumentStatesTheCapacityItsMemoryAllows(t *testing.T) {
	b, err := gatewayDocument(envFrom(t, gatewayDocFixture), "Example KB", "example.github.io:example-kb", "container", "192.168.64.1", 4000, nil)
	if err != nil {
		t.Fatal(err)
	}
	doc := documentFrom(t, b)
	if got := semiontDescriptor("gateway").mem; got != "2G" {
		t.Fatalf("the gateway's container is given %s; this test states the capacity for 2G", got)
	}
	if doc.Capacity.QueuedBytes != 1<<30 || doc.Capacity.Connections != 52428 {
		t.Errorf("capacity = %+v, want 1 GiB queued and 52428 connections", doc.Capacity)
	}
}

// A KB that declares no identity gets no fabricated one: the launcher refuses
// to write a document the gateway would refuse.
func TestGatewayDocumentRefusesAnUndeclaredDomain(t *testing.T) {
	if _, err := gatewayDocument(envFrom(t, gatewayDocFixture), "Example KB", "", "container", "192.168.64.1", 4000, nil); err == nil || !strings.Contains(err.Error(), "domain") {
		t.Fatalf("want a refusal naming the domain, got %v", err)
	}
}
