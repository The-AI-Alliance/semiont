package launcher

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
)

// The KB config a `semiont init` writes, as far as the dispatcher reads it.
const dispatcherDocFixture = `[defaults]
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

[environments.local.jobs]
type = "jetstream"
servers = "${NATS_HOST}:4222"
`

func dispatcherDocumentFrom(t *testing.T, b []byte) semiont.DispatcherConfig {
	t.Helper()
	var doc semiont.DispatcherConfig
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&doc); err != nil {
		t.Fatalf("the document is not a DispatcherConfig: %v\n%s", err, b)
	}
	return doc
}

// Resolved: every ${VAR} a value, as the dispatcher's own loader resolved it in
// the container before it read a document. The gateway host is the launcher's
// address — the one resolution the gateway's own document does not share.
func TestDispatcherDocumentIsResolved(t *testing.T) {
	b, err := dispatcherDocument(envFrom(t, dispatcherDocFixture), "container", "192.168.64.1", 8080, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "${") {
		t.Fatalf("an unresolved reference reached the document:\n%s", b)
	}
	doc := dispatcherDocumentFrom(t, b)
	if doc.GatewayUrl != "http://192.168.64.1:4000" {
		t.Errorf("gatewayUrl = %q, want the gateway at the launcher's address, not the dispatcher's own container", doc.GatewayUrl)
	}
	if doc.Identity.Issuer != "http://192.168.64.1:8080/realms/semiont" {
		t.Errorf("issuer = %q", doc.Identity.Issuer)
	}
	if doc.Queue.Servers != "192.168.64.1:4222" || doc.Queue.UserEnv != nil || doc.Queue.PasswordEnv != nil {
		t.Errorf("queue = %+v, want the broker's address and no credentials", doc.Queue)
	}
	if doc.Port != semiontDescriptor("dispatcher").ports[0].port {
		t.Errorf("port = %d, want the descriptor's", doc.Port)
	}
	if doc.LogLevel != "debug" || doc.LogFormat != semiont.Json {
		t.Errorf("log = %q %q", doc.LogLevel, doc.LogFormat)
	}
	if doc.Timing.TickMs != 30_000 || doc.Timing.StaleRunningMs != 30*60_000 || doc.Timing.AckWaitMs != 30_000 ||
		doc.Timing.RetentionMs != 24*60*60_000 || doc.Timing.RetentionSweepMs != 60*60_000 ||
		doc.Timing.ProgressWriteIntervalMs != 5_000 || doc.Timing.BootDeadlineMs != 60_000 {
		t.Errorf("timing = %+v, want the values a deployment runs with", doc.Timing)
	}
}

// The broker the launcher runs has the pair the launcher keeps; the dispatcher
// is handed their names.
func TestDispatcherDocumentNamesTheLauncherBrokersPair(t *testing.T) {
	b, err := dispatcherDocument(envFrom(t, dispatcherDocFixture), "container", "192.168.64.1", 8080, nil, true)
	if err != nil {
		t.Fatal(err)
	}
	doc := dispatcherDocumentFrom(t, b)
	if doc.Queue.UserEnv == nil || *doc.Queue.UserEnv != "NATS_USER" ||
		doc.Queue.PasswordEnv == nil || *doc.Queue.PasswordEnv != daemonPasswords["messaging"].env {
		t.Errorf("queue = %+v, want the launcher broker's pair named", doc.Queue)
	}
}

func TestDispatcherDocumentNamesSecretsAndNeverCarriesThem(t *testing.T) {
	text := dispatcherDocFixture + "user = \"${BROKER_USER}\"\npassword = \"${BROKER_PASSWORD}\"\n"
	userEnv := []string{"--env", "BROKER_USER=the-user-value", "--env", "BROKER_PASSWORD=the-password-value"}
	b, err := dispatcherDocument(envFrom(t, text), "container", "192.168.64.1", 8080, userEnv, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"the-user-value", "the-password-value"} {
		if strings.Contains(string(b), secret) {
			t.Fatalf("a secret value reached the document:\n%s", b)
		}
	}
	doc := dispatcherDocumentFrom(t, b)
	if doc.Queue.UserEnv == nil || *doc.Queue.UserEnv != "BROKER_USER" || doc.Queue.PasswordEnv == nil || *doc.Queue.PasswordEnv != "BROKER_PASSWORD" {
		t.Errorf("queue = %+v, want the credentials named", doc.Queue)
	}
	if got := dispatcherNamedVars(envFrom(t, text)); strings.Join(got, ",") != "BROKER_USER,BROKER_PASSWORD" {
		t.Errorf("the dispatcher is handed %v, want exactly the names its document carries", got)
	}
}

func TestDispatcherDocumentRefusesALiteralSecret(t *testing.T) {
	text := dispatcherDocFixture + "password = \"hunter2\"\n"
	_, err := dispatcherDocument(envFrom(t, text), "container", "192.168.64.1", 8080, nil, false)
	if err == nil || !strings.Contains(err.Error(), "jobs.password") || !strings.Contains(err.Error(), "${") {
		t.Fatalf("want a refusal naming the field and the ${VAR} form, got %v", err)
	}
	if strings.Contains(err.Error(), "hunter2") {
		t.Fatalf("the refusal repeated the secret: %v", err)
	}
}

// The dispatcher's queue is JetStream: it holds no state tree for another
// driver to write, so a [jobs] of any other type, or none, refuses by name.
func TestDispatcherDocumentRefusesAQueueItCannotHold(t *testing.T) {
	for label, text := range map[string]string{
		"fs":   strings.Replace(dispatcherDocFixture, `type = "jetstream"`, `type = "fs"`, 1),
		"none": strings.Replace(dispatcherDocFixture, "[environments.local.jobs]\ntype = \"jetstream\"\nservers = \"${NATS_HOST}:4222\"\n", "", 1),
	} {
		_, err := dispatcherDocument(envFrom(t, text), "container", "192.168.64.1", 8080, nil, false)
		if err == nil || !strings.Contains(err.Error(), "jetstream") {
			t.Errorf("%s: want a refusal naming jetstream, got %v", label, err)
		}
	}
}

func TestDispatcherDocumentRefusesAMissingGatewayOrIssuer(t *testing.T) {
	noGateway := strings.Replace(dispatcherDocFixture, `publicURL = "http://${GATEWAY_HOST:-localhost}:4000"`, "", 1)
	if _, err := dispatcherDocument(envFrom(t, noGateway), "container", "192.168.64.1", 8080, nil, false); err == nil || !strings.Contains(err.Error(), "publicURL") {
		t.Errorf("no publicURL: want a refusal naming it, got %v", err)
	}
	env := envFrom(t, dispatcherDocFixture)
	env.Identity = nil
	if _, err := dispatcherDocument(env, "container", "192.168.64.1", 8080, nil, false); err == nil || !strings.Contains(err.Error(), "identity") {
		t.Errorf("no [identity]: want a refusal naming it, got %v", err)
	}
}

// The launcher mounts the document where the image's command points --config
// (TestConfigDocumentsAreWhereTheImagesLook), and hands the dispatcher nothing
// else: no *_HOST variables, because the document already carries every
// address. Its health port is the descriptor's, which the document carries and
// the image probes.
func TestDispatcherDocumentIsWhereTheImageLooks(t *testing.T) {
	df, err := os.ReadFile(filepath.Join("..", "..", "..", "dispatcher", "Dockerfile"))
	if err != nil {
		t.Fatal(err)
	}

	args := strings.Join(dispatcherArgs("/stage", "container", "1.2.3.4", "client-secret", "v", nil, nil), " ")
	if want := "/stage/" + dispatcherDocumentFile + ":" + dispatcherDocumentTarget + ":ro"; !strings.Contains(args, want) {
		t.Errorf("the dispatcher's document is not mounted onto %s:\n%s", dispatcherDocumentTarget, args)
	}
	for _, unread := range []string{"GATEWAY_HOST", "BACKEND_HOST", "NATS_HOST", "KEYCLOAK_HOST", ".semiontconfig"} {
		if strings.Contains(args, unread) {
			t.Errorf("the dispatcher is handed %s, which it no longer reads:\n%s", unread, args)
		}
	}

	port := fmt.Sprint(semiontDescriptor("dispatcher").ports[0].port)
	for label, re := range map[string]*regexp.Regexp{
		"EXPOSE":          regexp.MustCompile(`(?m)^EXPOSE (\d+)`),
		"HEALTHCHECK":     regexp.MustCompile(`localhost:(\d+)/health`),
		"SUPERVISE_PROBE": regexp.MustCompile(`SUPERVISE_PROBE=http://localhost:(\d+)/health`),
	} {
		if m := re.FindSubmatch(df); m == nil || string(m[1]) != port {
			t.Errorf("the dispatcher image's %s disagrees with the port its document carries, %s", label, port)
		}
	}
}
