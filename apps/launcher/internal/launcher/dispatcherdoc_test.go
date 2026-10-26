package launcher

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/stack"
)

func dispatcherDocumentFrom(t *testing.T, b []byte) api.DispatcherConfig {
	t.Helper()
	var doc api.DispatcherConfig
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&doc); err != nil {
		t.Fatalf("the document is not a DispatcherConfig: %v\n%s", err, b)
	}
	return doc
}

func dispatcherDocumentOf(t *testing.T, p placement) api.DispatcherConfig {
	t.Helper()
	b, err := dispatcherDocument(p)
	if err != nil {
		t.Fatal(err)
	}
	return dispatcherDocumentFrom(t, b)
}

// Every address is the placement's: the gateway at this start's address on the
// containers' side of the port the KnowledgeBase gives it — never its
// publicURL, which is where clients reach it — and the broker the launcher runs, with the pair the launcher keeps
// named. The log level is the KnowledgeBase's.
func TestDispatcherDocumentStatesWhatThePlacementDecides(t *testing.T) {
	st := fixtureStack(t, "ollama-gemma")
	st.KnowledgeBase.Spec.Gateway.Port = 4100
	st.KnowledgeBase.Spec.LogLevel = api.LogLevelDebug
	p := placed(t, st)
	doc := dispatcherDocumentOf(t, p)
	if doc.GatewayUrl != "http://192.168.64.1:14100" {
		t.Errorf("gatewayUrl = %q, want the gateway at the launcher's address on its port", doc.GatewayUrl)
	}
	if doc.Identity.Issuer != "http://192.168.64.1:8080/realms/semiont" {
		t.Errorf("issuer = %q", doc.Identity.Issuer)
	}
	if doc.Queue.Servers != "192.168.64.1:4222" {
		t.Errorf("queue.servers = %q, want the broker at the launcher's address", doc.Queue.Servers)
	}
	if doc.Queue.UserEnv == nil || *doc.Queue.UserEnv != "NATS_USER" ||
		doc.Queue.PasswordEnv == nil || *doc.Queue.PasswordEnv != daemonPasswords["messaging"].env {
		t.Errorf("queue = %+v, want the launcher broker's pair named", doc.Queue)
	}
	if got := dispatcherSecrets(p); len(got) != 0 {
		t.Errorf("the dispatcher is handed %v of the user's for the launcher's broker", got)
	}
	if doc.Port != semiontDescriptor("dispatcher").ports[0].port {
		t.Errorf("port = %d, want the descriptor's", doc.Port)
	}
	if doc.LogLevel != api.LogLevelDebug || doc.LogFormat != api.LogFormatJson {
		t.Errorf("log = %q %q, want the KnowledgeBase's level and JSON", doc.LogLevel, doc.LogFormat)
	}
	if doc.Timing.TickMs != 30_000 || doc.Timing.StaleRunningMs != 30*60_000 || doc.Timing.AckWaitMs != 30_000 ||
		doc.Timing.RetentionMs != 24*60*60_000 || doc.Timing.RetentionSweepMs != 60*60_000 ||
		doc.Timing.ProgressWriteIntervalMs != 5_000 || doc.Timing.BootDeadlineMs != 60_000 {
		t.Errorf("timing = %+v, want the values a deployment runs with", doc.Timing)
	}
}

// A broker somebody else runs is where its document states it, and the
// dispatcher is handed exactly the pair the document names.
func TestDispatcherDocumentNamesAnExternalBrokersPair(t *testing.T) {
	st := fixtureStack(t, "ollama-gemma")
	externalBroker(st)
	p := placed(t, st)
	doc := dispatcherDocumentOf(t, p)
	if doc.Queue.Servers != "nats.internal:4222" {
		t.Errorf("queue.servers = %q, want the stated broker", doc.Queue.Servers)
	}
	if doc.Queue.UserEnv == nil || *doc.Queue.UserEnv != "BROKER_USER" || doc.Queue.PasswordEnv == nil || *doc.Queue.PasswordEnv != "BROKER_PASSWORD" {
		t.Errorf("queue = %+v, want the credentials named", doc.Queue)
	}
	if got := strings.Join(dispatcherSecrets(p), ","); got != "BROKER_USER,BROKER_PASSWORD" {
		t.Errorf("the dispatcher is handed %q, want exactly the names its document carries", got)
	}
}

// The launcher mounts the document where the image's command points --config
// (TestConfigDocumentsAreWhereTheImagesLook), and hands the dispatcher nothing
// else: no *_HOST variables and no copy of the KB's documents, because its own
// document already carries every address. Its health port is the descriptor's,
// which the document carries and the image probes.
func TestDispatcherDocumentIsWhereTheImageLooks(t *testing.T) {
	df, err := os.ReadFile(filepath.Join("..", "..", "..", "dispatcher", "Dockerfile"))
	if err != nil {
		t.Fatal(err)
	}

	args := strings.Join(dispatcherArgs("/stage", "container", "1.2.3.4", "client-secret", "v", semiontDescriptor("dispatcher").mem, nil, nil), " ")
	if want := "/stage/" + dispatcherDocumentFile + ":" + dispatcherDocumentTarget + ":ro"; !strings.Contains(args, want) {
		t.Errorf("the dispatcher's document is not mounted onto %s:\n%s", dispatcherDocumentTarget, args)
	}
	for _, unread := range []string{"GATEWAY_HOST", "NATS_HOST", "KEYCLOAK_HOST", stack.Dir} {
		if strings.Contains(args, unread) {
			t.Errorf("the dispatcher is handed %s, which it does not read:\n%s", unread, args)
		}
	}

	port := fmt.Sprint(dispatcherDocumentOf(t, placed(t, fixtureStack(t, "ollama-gemma"))).Port)
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
