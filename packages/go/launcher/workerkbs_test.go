package launcher

// The knowledge bases added to this machine's worker: what `semiont worker kb`
// keeps, where, and to whom; what each start's worker document makes of them;
// and the start a knowledge base among them refuses.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/harness"
)

// gatewayNaming: a gateway whose resource metadata names issuers as the
// authorization servers it trusts, as the gateway serves it (RFC 9728).
func gatewayNaming(t *testing.T, issuers ...string) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/.well-known/oauth-protected-resource" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"resource":                 "https://other.example/kb",
			"authorization_servers":    issuers,
			"bearer_methods_supported": []string{"header"},
		})
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

// addedKBOf: an added knowledge base, as `semiont worker kb add` keeps one.
func addedKBOf(domain, gateway, issuer, clientID string) addedKB {
	kb := addedKB{Domain: domain, GatewayUrl: gateway}
	kb.Identity.Issuer, kb.Identity.ClientId = issuer, clientID
	return kb
}

// workerOutput runs the worker verb and returns its exit code and what it
// printed.
func workerOutput(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	var code int
	stdout, stderr := harness.CaptureOutput(t, func() { code = Worker(args) })
	return code, stdout, stderr
}

// keptKBs: the knowledge bases kept for the machine, read as a start reads
// them.
func keptKBs(t *testing.T) []addedKB {
	t.Helper()
	added, err := loadAddedKBs()
	if err != nil {
		t.Fatal(err)
	}
	return added
}

// An added knowledge base is its entry in the worker's document but for its
// engines, member for member: a member the schema gains is one `add` keeps,
// or the entry the launcher writes from it lacks it.
func TestAnAddedKnowledgeBaseIsAWorkerEntryButItsEngines(t *testing.T) {
	members := func(of reflect.Type, but string) map[string]reflect.StructField {
		fields := map[string]reflect.StructField{}
		for i := 0; i < of.NumField(); i++ {
			if f := of.Field(i); f.Tag.Get("json") != but {
				fields[f.Tag.Get("json")] = f
			}
		}
		return fields
	}
	entry := members(reflect.TypeFor[api.WorkerKnowledgeBaseConfig](), "engines")
	kept := members(reflect.TypeFor[addedKB](), "")
	if len(entry) == 0 {
		t.Fatal("the entry has no member: a gate that checks nothing passes on silence")
	}
	for name, f := range entry {
		if k, ok := kept[name]; !ok || k.Name != f.Name || k.Type != f.Type {
			t.Errorf("the worker's entry has %s (%s %v), and an added knowledge base keeps no such member", name, f.Name, f.Type)
		}
	}
	for name := range kept {
		if _, ok := entry[name]; !ok {
			t.Errorf("an added knowledge base keeps %s, which the worker's entry has not", name)
		}
	}
}

// With none added, the document names one knowledge base: the one the start
// runs, at the gateway and issuer it places, as this machine's own worker,
// offered the engines the Inference document gives jobs.
func TestAStartWithNoKnowledgeBaseAddedServesItsOwnAlone(t *testing.T) {
	p := placed(t, threeEngines(t))
	engines, err := workerEngines(p)
	if err != nil {
		t.Fatal(err)
	}
	want := api.WorkerKnowledgeBaseConfig{Domain: exampleKB.Domain, GatewayUrl: p.gatewayURL(), Engines: engines}
	want.Identity.Issuer, want.Identity.ClientId = p.issuer(), serviceClientID("worker")
	got, err := json.Marshal(workerDocumentOf(t, p).KnowledgeBases)
	if err != nil {
		t.Fatal(err)
	}
	if wanted, _ := json.Marshal([]api.WorkerKnowledgeBaseConfig{want}); string(got) != string(wanted) {
		t.Errorf("knowledgeBases = %s\nwant %s", got, wanted)
	}
}

// Each added knowledge base follows the start's own, in the order they are
// kept, with its own gateway, issuer and client, and the engines the start
// offers its own: the same documents are the same document every time.
func TestAddedKnowledgeBasesFollowTheStartsOwnWithItsEngines(t *testing.T) {
	added := []addedKB{
		addedKBOf("a.example:kb", "https://a.example", "https://id.a.example/realms/a", "semiont-worker-alice"),
		addedKBOf("b.example:kb", "https://b.example", "https://id.b.example/realms/b", "semiont-worker-bob"),
	}
	p := placed(t, threeEngines(t))
	b, err := workerDocument(p, exampleKB.Domain, added)
	if err != nil {
		t.Fatal(err)
	}
	doc := workerDocumentFrom(t, b)
	var domains []string
	for _, kb := range doc.KnowledgeBases {
		domains = append(domains, kb.Domain)
	}
	if want := []string{exampleKB.Domain, "a.example:kb", "b.example:kb"}; !reflect.DeepEqual(domains, want) {
		t.Fatalf("knowledgeBases name %v, want %v", domains, want)
	}
	own := doc.KnowledgeBases[0]
	for i, kb := range doc.KnowledgeBases[1:] {
		got, err := json.Marshal(kb)
		if err != nil {
			t.Fatal(err)
		}
		if want, _ := json.Marshal(added[i].entry(own.Engines)); string(got) != string(want) {
			t.Errorf("knowledgeBases[%d] = %s\nwant %s", i+1, got, want)
		}
	}
	for i := 0; i < 20; i++ {
		again, err := workerDocument(placed(t, threeEngines(t)), exampleKB.Domain, added)
		if err != nil {
			t.Fatal(err)
		}
		if string(again) != string(b) {
			t.Fatalf("the same documents gave two worker documents:\n%s\nand\n%s", b, again)
		}
	}
}

// A start of a knowledge base that is among those added is refused, saying how
// to remove it: the worker would serve it twice, and refuses a document that
// names one domain twice.
func TestAKnowledgeBaseAddedToItsOwnStartIsRefused(t *testing.T) {
	p := placed(t, fixtureStack(t, "anthropic"))
	added := []addedKB{
		addedKBOf("a.example:kb", "https://a.example", "https://id.a.example/realms/a", "semiont-worker-alice"),
		addedKBOf(exampleKB.Domain, "https://example.github.io", "https://id.example/realms/kb", "semiont-worker-alice"),
	}
	_, err := workerDocument(p, exampleKB.Domain, added)
	if err == nil || !strings.Contains(err.Error(), "semiont worker kb remove "+exampleKB.Domain) {
		t.Errorf("want a refusal saying how to remove %s, got %v", exampleKB.Domain, err)
	}
}

// `add` asks the gateway which issuer it trusts and keeps that, to its owner,
// for the machine: what a start reads.
func TestWorkerKBAddKeepsWhatTheGatewayNames(t *testing.T) {
	harness.Home(t)
	gateway := gatewayNaming(t, "https://id.other.example/realms/kb")
	code, stdout, stderr := workerOutput(t, "kb", "add", "other.example:kb", "--gateway", gateway, "--client-id", "semiont-worker-alice")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	harness.MustContainAll(t, "stdout", stdout, "added other.example:kb", "https://id.other.example/realms/kb", "semiont-worker-alice")
	want := []addedKB{addedKBOf("other.example:kb", gateway, "https://id.other.example/realms/kb", "semiont-worker-alice")}
	if got := keptKBs(t); !reflect.DeepEqual(got, want) {
		t.Errorf("kept %+v, want %+v", got, want)
	}
	kept := filepath.Join(machineStateDir(), addedKBsFile)
	if fi, err := os.Stat(kept); err != nil {
		t.Fatalf("nothing is kept for the machine: %v", err)
	} else if fi.Mode().Perm()&0o077 != 0 {
		t.Errorf("the added knowledge bases are readable beyond their owner: %v", fi.Mode().Perm())
	}
	if _, err := os.Stat(kept + ".tmp"); !os.IsNotExist(err) {
		t.Errorf("the write left its temporary file: %v", err)
	}
}

// Adding a domain already added replaces its entry, says so, and keeps the
// others; the kept order is the domains', whatever order they were added in.
func TestWorkerKBAddOfADomainAddedReplacesIt(t *testing.T) {
	harness.Home(t)
	first, second := gatewayNaming(t, "https://id.one/realms/kb"), gatewayNaming(t, "https://id.two/realms/kb")
	for _, args := range [][]string{
		{"kb", "add", "z.example:kb", "--gateway", first, "--client-id", "semiont-worker-alice"},
		{"kb", "add", "a.example:kb", "--gateway", first, "--client-id", "semiont-worker-alice"},
	} {
		if code, _, stderr := workerOutput(t, args...); code != 0 {
			t.Fatalf("%v: exit %d\n%s", args, code, stderr)
		}
	}
	code, stdout, stderr := workerOutput(t, "kb", "add", "z.example:kb", "--gateway", second, "--client-id", "semiont-worker-zed")
	if code != 0 {
		t.Fatalf("exit %d\n%s", code, stderr)
	}
	harness.MustContainAll(t, "stdout", stdout, "replaced z.example:kb, which was added already")
	want := []addedKB{
		addedKBOf("a.example:kb", first, "https://id.one/realms/kb", "semiont-worker-alice"),
		addedKBOf("z.example:kb", second, "https://id.two/realms/kb", "semiont-worker-zed"),
	}
	if got := keptKBs(t); !reflect.DeepEqual(got, want) {
		t.Errorf("kept %+v, want %+v", got, want)
	}
}

// A gateway that cannot be reached, or names no issuer, adds nothing: the
// worker could sign in nowhere. Nor does anything `add` must not keep: a
// domain that names no knowledge base, or a gateway or client left out.
func TestWorkerKBAddThatFailsKeepsNothing(t *testing.T) {
	harness.Home(t)
	named := gatewayNaming(t, "https://id.other.example/realms/kb")
	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{"kb", "add", "other.example:kb", "--gateway", harness.DeadOrigin(t), "--client-id", "semiont-worker-alice"}, "Nothing is added"},
		{[]string{"kb", "add", "other.example:kb", "--gateway", gatewayNaming(t), "--client-id", "semiont-worker-alice"}, "published no authorization server"},
		{[]string{"kb", "add", "not a domain", "--gateway", named, "--client-id", "semiont-worker-alice"}, "is not a knowledge base's domain"},
		{[]string{"kb", "add", "other.example:kb", "--client-id", "semiont-worker-alice"}, "add needs --gateway <url> and --client-id <id>"},
		{[]string{"kb", "add", "other.example:kb", "--gateway", named}, "add needs --gateway <url> and --client-id <id>"},
		{[]string{"kb", "add", "--gateway", named, "--client-id", "semiont-worker-alice"}, "add takes one domain"},
		{[]string{"kb", "add", "other.example:kb", "--gateway", named, "--client-id", "semiont-worker-alice", "--issuer", "x"}, "Unknown flag: --issuer"},
	} {
		code, _, stderr := workerOutput(t, c.args...)
		if code != 1 {
			t.Errorf("%v: exit %d, want 1", c.args, code)
		}
		harness.MustContainAll(t, "stderr", stderr, c.want)
	}
	if _, err := os.Stat(filepath.Join(machineStateDir(), addedKBsFile)); !os.IsNotExist(err) {
		t.Errorf("a failed add kept something: %v", err)
	}
}

// `remove` takes that knowledge base out and no other; one not added is
// refused, naming what is. The last removed leaves no file, as before the
// first was added.
func TestWorkerKBRemoveTakesOutThatOneAlone(t *testing.T) {
	harness.Home(t)
	if err := saveAddedKBs([]addedKB{
		addedKBOf("a.example:kb", "https://a.example", "https://id.a/realms/a", "semiont-worker-alice"),
		addedKBOf("b.example:kb", "https://b.example", "https://id.b/realms/b", "semiont-worker-alice"),
	}); err != nil {
		t.Fatal(err)
	}
	code, _, stderr := workerOutput(t, "kb", "remove", "c.example:kb")
	if code != 1 {
		t.Errorf("remove of a knowledge base not added: exit %d, want 1", code)
	}
	harness.MustContainAll(t, "stderr", stderr, "c.example:kb is not added", "Added: a.example:kb, b.example:kb")

	if code, _, stderr := workerOutput(t, "kb", "remove", "a.example:kb"); code != 0 {
		t.Fatalf("exit %d\n%s", code, stderr)
	}
	if got := keptKBs(t); len(got) != 1 || got[0].Domain != "b.example:kb" {
		t.Errorf("kept %+v, want b.example:kb alone", got)
	}
	if code, _, stderr := workerOutput(t, "kb", "remove", "b.example:kb"); code != 0 {
		t.Fatalf("exit %d\n%s", code, stderr)
	}
	if _, err := os.Stat(filepath.Join(machineStateDir(), addedKBsFile)); !os.IsNotExist(err) {
		t.Errorf("none added left a file: %v", err)
	}
	code, _, stderr = workerOutput(t, "kb", "remove", "b.example:kb")
	if code != 1 {
		t.Errorf("remove with none added: exit %d, want 1", code)
	}
	harness.MustContainAll(t, "stderr", stderr, "None is added")
}

// `list` prints each knowledge base added, with what is kept of it; with none
// it says so, and prints nothing a pipe would read.
func TestWorkerKBListPrintsWhatIsKept(t *testing.T) {
	harness.Home(t)
	code, stdout, stderr := workerOutput(t, "kb", "list")
	if code != 0 || stdout != "" {
		t.Errorf("with none added: exit %d, stdout %q", code, stdout)
	}
	harness.MustContainAll(t, "stderr", stderr, "No knowledge base is added")

	if err := saveAddedKBs([]addedKB{addedKBOf("a.example:kb", "https://a.example", "https://id.a/realms/a", "semiont-worker-alice")}); err != nil {
		t.Fatal(err)
	}
	code, stdout, stderr = workerOutput(t, "kb", "list")
	if code != 0 {
		t.Fatalf("exit %d\n%s", code, stderr)
	}
	harness.MustContainAll(t, "stdout", stdout, "a.example:kb\n", "Gateway:    https://a.example\n", "Issuer:     https://id.a/realms/a\n", "Client id:  semiont-worker-alice\n")
}

// What is kept and cannot be read is refused by every verb that reads it, and
// by the start, naming the file: never read as none added.
func TestAnUnreadableKeptFileIsRefused(t *testing.T) {
	harness.Home(t)
	kept := filepath.Join(machineStateDir(), addedKBsFile)
	if err := writeOwnerOnly(kept, []byte(`[{"domain": "a.example:kb", "engines": []}]`)); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{
		{"kb", "list"},
		{"kb", "remove", "a.example:kb"},
		{"kb", "add", "b.example:kb", "--gateway", gatewayNaming(t, "https://id.b/realms/b"), "--client-id", "semiont-worker-alice"},
	} {
		code, _, stderr := workerOutput(t, args...)
		if code != 1 {
			t.Errorf("%v: exit %d, want 1", args, code)
		}
		harness.MustContainAll(t, "stderr", stderr, kept, "does not hold the knowledge bases added")
	}
}

// What the worker kb verbs do not take is refused.
func TestTheWorkerKBVerbsRefuseWhatTheyDoNotTake(t *testing.T) {
	harness.Home(t)
	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{"kb"}, "worker kb takes add, remove or list"},
		{[]string{"kb", "rename"}, "Unknown worker kb subcommand: rename"},
		{[]string{"kb", "list", "a.example:kb"}, "list takes no argument"},
		{[]string{"kb", "remove"}, "remove takes one domain"},
		{[]string{"kb", "remove", "a.example:kb", "b.example:kb"}, "remove takes one domain"},
		{[]string{"kb", "remove", "a.example:kb", "--gateway", "x"}, "Unknown flag: --gateway"},
	} {
		code, _, stderr := workerOutput(t, c.args...)
		if code != 1 {
			t.Errorf("%v: exit %d, want 1", c.args, code)
		}
		harness.MustContainAll(t, "stderr", stderr, c.want)
	}
}
