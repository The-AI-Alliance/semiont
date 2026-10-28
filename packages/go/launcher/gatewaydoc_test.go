package launcher

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/stack"
)

// externalBroker: st with a broker somebody else runs at nats.internal, its
// pair named BROKER_USER and BROKER_PASSWORD.
func externalBroker(st *stack.Stack) {
	m := &st.KnowledgeBase.Spec.Messaging
	m.Image, m.Resources = nil, nil
	m.External = &stack.KnowledgeBaseMessagingExternal{
		Servers:  "nats.internal:4222",
		User:     stack.SecretRef{FromEnv: "BROKER_USER"},
		Password: stack.SecretRef{FromEnv: "BROKER_PASSWORD"},
	}
}

func gatewayDocumentFrom(t *testing.T, b []byte) api.GatewayConfig {
	t.Helper()
	var doc api.GatewayConfig
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&doc); err != nil {
		t.Fatalf("the document is not a GatewayConfig: %v\n%s", err, b)
	}
	return doc
}

// gatewayDocumentOf: the gateway's document for p, under the example
// knowledge base's name and domain.
func gatewayDocumentOf(t *testing.T, p placement) api.GatewayConfig {
	t.Helper()
	b, err := gatewayDocument(p, "Example KB", "example.github.io:example-kb")
	if err != nil {
		t.Fatal(err)
	}
	return gatewayDocumentFrom(t, b)
}

// Every address is the placement's, the publicURL is the KnowledgeBase's as
// written, and the log level is the KnowledgeBase's.
func TestGatewayDocumentStatesWhatThePlacementDecides(t *testing.T) {
	st := fixtureStack(t, "ollama-gemma")
	st.KnowledgeBase.Spec.Gateway.PublicURL = "https://kb.example.com"
	st.KnowledgeBase.Spec.Messaging.Signal.Type = "nats"
	st.KnowledgeBase.Spec.LogLevel = api.LogLevelDebug
	doc := gatewayDocumentOf(t, placed(t, st))
	if doc.Kb.Name != "Example KB" || doc.Kb.Domain != "example.github.io:example-kb" {
		t.Errorf("kb = %+v, want the committed name and domain", doc.Kb)
	}
	if doc.Port != 4000 || doc.PublicUrl != "https://kb.example.com" {
		t.Errorf("port %d, publicUrl %q: want the KnowledgeBase's port and its publicURL as written", doc.Port, doc.PublicUrl)
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
	if doc.LogLevel != api.LogLevelDebug || doc.LogFormat != api.LogFormatJson {
		t.Errorf("log = %q %q, want the KnowledgeBase's level and JSON", doc.LogLevel, doc.LogFormat)
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
		st := fixtureStack(t, "ollama-gemma")
		st.KnowledgeBase.Spec.Messaging.Signal.Type = "nats"
		p := placed(t, st)
		p.rt, p.addr = c.rt, c.addr
		doc := gatewayDocumentOf(t, p)
		if doc.Identity.Issuer != "http://keycloak.localhost:8080/realms/semiont" {
			t.Errorf("%s at %s: issuer %q, want one the laptop resolves as well as the containers", c.rt, c.addr, doc.Identity.Issuer)
		}
		if doc.Signal.Servers == nil || *doc.Signal.Servers != c.addr+":4222" {
			t.Errorf("%s at %s: signal = %+v, want the broker on the host address", c.rt, c.addr, doc.Signal)
		}
	}
}

// The issuer of the Keycloak the launcher runs is at the port this start gives
// it — else the gateway advertises one issuer and the realm stamps another.
func TestGatewayDocumentNamesTheIssuerAtItsPort(t *testing.T) {
	st := fixtureStack(t, "ollama-gemma")
	plan, err := derivePlan(st, 8081)
	if err != nil {
		t.Fatal(err)
	}
	doc := gatewayDocumentOf(t, placement{st: st, plan: plan, rt: "docker", addr: "172.17.0.1"})
	if doc.Identity.Issuer != "http://keycloak.localhost:8081/realms/semiont" {
		t.Errorf("issuer %q, want the moved port", doc.Identity.Issuer)
	}
}

// Secrets are named, never carried. The broker the launcher runs has the pair
// the launcher keeps, so the document names that pair and the gateway is handed
// none of the user's. A broker somebody else runs has the pair its document
// names, and the gateway is handed those two — when the signal plane rides it.
func TestGatewayDocumentNamesTheBrokersPair(t *testing.T) {
	st := fixtureStack(t, "ollama-gemma")
	st.KnowledgeBase.Spec.Messaging.Signal.Type = "nats"
	p := placed(t, st)
	doc := gatewayDocumentOf(t, p)
	if doc.Signal.UserEnv == nil || *doc.Signal.UserEnv != "NATS_USER" ||
		doc.Signal.PasswordEnv == nil || *doc.Signal.PasswordEnv != daemonPasswords["messaging"].env {
		t.Errorf("signal = %+v, want the launcher broker's pair named", doc.Signal)
	}
	if got := gatewaySecrets(p); len(got) != 0 {
		t.Errorf("the gateway is handed %v of the user's for the launcher's broker", got)
	}

	st = fixtureStack(t, "ollama-gemma")
	st.KnowledgeBase.Spec.Messaging.Signal.Type = "nats"
	externalBroker(st)
	p = placed(t, st)
	doc = gatewayDocumentOf(t, p)
	if doc.Signal.Servers == nil || *doc.Signal.Servers != "nats.internal:4222" {
		t.Errorf("signal = %+v, want somebody else's broker where its document states it", doc.Signal)
	}
	if doc.Signal.UserEnv == nil || *doc.Signal.UserEnv != "BROKER_USER" || doc.Signal.PasswordEnv == nil || *doc.Signal.PasswordEnv != "BROKER_PASSWORD" {
		t.Errorf("signal = %+v, want the pair its document names", doc.Signal)
	}
	if got := strings.Join(gatewaySecrets(p), ","); got != "BROKER_USER,BROKER_PASSWORD" {
		t.Errorf("the gateway is handed %q, want exactly the names its document carries", got)
	}

	st = fixtureStack(t, "ollama-gemma")
	externalBroker(st)
	p = placed(t, st)
	doc = gatewayDocumentOf(t, p)
	if doc.Signal.Type != "in-process" || doc.Signal.Servers != nil || doc.Signal.UserEnv != nil || doc.Signal.PasswordEnv != nil {
		t.Errorf("signal = %+v, want the in-process plane, naming no broker", doc.Signal)
	}
	if got := gatewaySecrets(p); len(got) != 0 {
		t.Errorf("an in-process gateway is handed %v", got)
	}
}

// An Archivist the KnowledgeBase places — a topology the launcher cannot see —
// is where the KnowledgeBase says.
func TestGatewayDocumentReachesTheArchivistTheKnowledgeBaseStates(t *testing.T) {
	st := fixtureStack(t, "ollama-gemma")
	st.KnowledgeBase.Spec.Archivist.Address = &stack.HostPort{Host: "archivist.internal", Port: 9999}
	doc := gatewayDocumentOf(t, placed(t, st))
	if doc.Archivist.Host != "archivist.internal" || doc.Archivist.Port != 9999 {
		t.Errorf("archivist = %+v, want the stated address", doc.Archivist)
	}
}

// The gateway's capacity follows from the memory its container is given: for
// a 2G gateway, a gibibyte of bytes queued to its streams, and connections at
// 20 KiB each of the other half.
func TestGatewayDocumentStatesTheCapacityItsMemoryAllows(t *testing.T) {
	st := fixtureStack(t, "ollama-gemma")
	if got := st.KnowledgeBase.Spec.Gateway.Resources.Limits.Memory; got != "2G" {
		t.Fatalf("the fixture gives the gateway %s; this test states the capacity for 2G", got)
	}
	doc := gatewayDocumentOf(t, placed(t, st))
	if doc.Capacity.QueuedBytes != 1<<30 || doc.Capacity.Connections != 52428 {
		t.Errorf("capacity = %+v, want 1 GiB queued and 52428 connections", doc.Capacity)
	}

	// A gateway given 4G has twice the capacity.
	st = fixtureStack(t, "ollama-gemma")
	st.KnowledgeBase.Spec.Gateway.Resources.Limits.Memory = "4G"
	if doc = gatewayDocumentOf(t, placed(t, st)); doc.Capacity.QueuedBytes != 2<<30 || doc.Capacity.Connections != 104857 {
		t.Errorf("capacity at 4G = %+v, want 2 GiB queued and 104857 connections", doc.Capacity)
	}
}

// A KB that declares no identity gets no fabricated one: the launcher refuses
// to write a document the gateway would refuse.
func TestGatewayDocumentRefusesAnUndeclaredDomain(t *testing.T) {
	if _, err := gatewayDocument(placed(t, fixtureStack(t, "ollama-gemma")), "Example KB", ""); err == nil || !strings.Contains(err.Error(), "domain") {
		t.Fatalf("want a refusal naming the domain, got %v", err)
	}
}

// Where the launcher itself needs a credential a document names, it reads the
// variable's value from the start's --env list: a launcher-run Keycloak dials an
// external PostgreSQL with the value, never the name. An unset variable is
// refused by name.
func TestUserEnvValueReadsTheVariableADocumentNames(t *testing.T) {
	got, err := userEnvValue("spec.database.external.password", "EXT_PG_PASSWORD", []string{"--env", "EXT_PG_PASSWORD=pgsecret"})
	if err != nil || got != "pgsecret" {
		t.Errorf("got %q, %v; want the variable's value", got, err)
	}
	if _, err := userEnvValue("spec.database.external.password", "UNSET_PG_PASSWORD", nil); err == nil || !strings.Contains(err.Error(), "UNSET_PG_PASSWORD") {
		t.Errorf("an unset variable must refuse, naming it; got %v", err)
	}
}
