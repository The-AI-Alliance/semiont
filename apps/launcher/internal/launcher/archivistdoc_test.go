package launcher

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/stack"
)

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

func archivistDocumentOf(t *testing.T, p placement) semiont.ArchivistConfig {
	t.Helper()
	b, err := archivistDocument(p)
	if err != nil {
		t.Fatal(err)
	}
	return archivistDocumentFrom(t, b)
}

// Every address is the placement's and every path the one the launcher mounts
// onto. The roster is the Inference document's, whole: the worker's document
// and the Librarian's are written from the same one. The log level is the
// KnowledgeBase's.
func TestArchivistDocumentStatesWhatThePlacementDecides(t *testing.T) {
	st := fixtureStack(t, "anthropic")
	st.KnowledgeBase.Spec.LogLevel = semiont.LogLevelDebug
	doc := archivistDocumentOf(t, placed(t, st))
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
	if doc.LogLevel != semiont.LogLevelDebug || doc.LogFormat != semiont.LogFormatJson {
		t.Errorf("log = %q %q, want the KnowledgeBase's level and JSON", doc.LogLevel, doc.LogFormat)
	}
	if !reflect.DeepEqual(doc.Roster, st.Inference.Spec.Roster) {
		got, _ := json.Marshal(doc.Roster)
		want, _ := json.Marshal(st.Inference.Spec.Roster)
		t.Errorf("roster = %s\nwant     %s, the Inference document's", got, want)
	}
}

// The launcher mounts the document where the image's command points --config,
// and hands the Archivist no address by environment: the document carries
// them.
func TestArchivistDocumentIsMountedAndNoHostVariableIsPassed(t *testing.T) {
	args := strings.Join(archivistArgs("/host/kb", "/stage", "container", "1.2.3.4", "client-secret", "v", semiontDescriptor("archivist").mem, nil, nil), " ")
	if want := "/stage/" + archivistDocumentFile + ":" + archivistDocumentTarget + ":ro"; !strings.Contains(args, want) {
		t.Errorf("the Archivist's document is not mounted (%s):\n%s", want, args)
	}
	for _, unwanted := range []string{"GATEWAY_HOST", "XDG_STATE_HOME", stack.Dir} {
		if strings.Contains(args, unwanted) {
			t.Errorf("the Archivist is handed %s, which its document replaces:\n%s", unwanted, args)
		}
	}
}
