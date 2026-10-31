package launcher

// The knowledge bases on this machine's worker's list: what a start and
// `semiont worker kb` keep, where, and to whom; what the worker's document
// makes of them; what a start takes off it; and the start a knowledge base
// added to it refuses.

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
			"resource": "https://other.example/kb",
			// A gateway that names none names an empty list: a nil slice writes null.
			"authorization_servers":    append([]string{}, issuers...),
			"bearer_methods_supported": []string{"header"},
		})
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

// addedKBOf: an added knowledge base, as `semiont worker kb add` keeps one
// run inside the local knowledge base at lender.
func addedKBOf(domain, gateway, issuer, clientID, lender string) addedKB {
	kb := addedKB{Domain: domain, GatewayUrl: gateway, EnginesOf: lender}
	kb.Identity.Issuer, kb.Identity.ClientId = issuer, clientID
	return kb
}

// localEntryOf: a local knowledge base's entry, as its start puts it on the
// list, at gateway, with one engine whose key is named keyEnv ("" for none).
func localEntryOf(domain, gateway, keyEnv string) api.WorkerKnowledgeBaseConfig {
	engine := api.WorkerEngineConfig{BaseUrl: "http://192.168.64.1:11434"}
	engine.Engine.Provider, engine.Engine.Model = api.EngineProviderOllama, "gemma3:1b"
	if keyEnv != "" {
		engine.Engine.Provider, engine.Engine.Model, engine.BaseUrl = api.EngineProviderAnthropic, "claude-haiku", "https://api.anthropic.com"
		engine.ApiKeyEnv = &keyEnv
	}
	entry := api.WorkerKnowledgeBaseConfig{Domain: domain, GatewayUrl: gateway, Engines: []api.WorkerEngineConfig{engine}}
	entry.Identity.Issuer, entry.Identity.ClientId = "http://keycloak.localhost:8080/realms/semiont", serviceClientID("worker")
	return entry
}

// insideLocalKB: the test runs inside the fixture knowledge base, which is
// on the worker's list beside the local entries others; its domain.
func insideLocalKB(t *testing.T, others ...api.WorkerKnowledgeBaseConfig) string {
	t.Helper()
	root, err := filepath.Abs(fixtureRoot)
	if err != nil {
		t.Fatal(err)
	}
	ident, err := readKBIdentity(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Chdir(root)
	list := workerList{Local: append(others, localEntryOf(ident.Domain, "http://192.168.64.1:14000", ""))}
	if err := saveWorkerList(list); err != nil {
		t.Fatal(err)
	}
	return ident.Domain
}

// workerOutput runs the worker verb and returns its exit code and what it
// printed.
func workerOutput(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	var code int
	stdout, stderr := harness.CaptureOutput(t, func() { code = Worker(args) })
	return code, stdout, stderr
}

// keptList: the list kept for the machine, read as a start reads it.
func keptList(t *testing.T) workerList {
	t.Helper()
	list, err := loadWorkerList()
	if err != nil {
		t.Fatal(err)
	}
	return list
}

// An added knowledge base is its entry in the worker's document but for its
// engines, member for member, plus the local knowledge base whose engines it
// is offered: a member the schema gains is one `add` keeps, or the entry the
// launcher writes from it lacks it.
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
	kept := members(reflect.TypeFor[addedKB](), "enginesOf")
	if f, ok := reflect.TypeFor[addedKB]().FieldByName("EnginesOf"); !ok || f.Tag.Get("json") != "enginesOf" || f.Type.Kind() != reflect.String {
		t.Error("an added knowledge base keeps no enginesOf: the local knowledge base whose engines it is offered")
	}
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

// A local knowledge base's entry is where its start places it: its domain,
// the gateway and issuer the start places, signed in at as this machine's own
// worker, offered the engines its Inference document gives jobs.
func TestALocalEntryIsWhereItsStartPlacesIt(t *testing.T) {
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

// The worker's document serves each local knowledge base, then each added
// one, offered the engines of the local one it names; an added one whose
// local one is not on the list is left out, and said. The same list is the
// same document every time.
func TestTheListServesEachAddedWithItsLendersEngines(t *testing.T) {
	list := workerList{
		Local: []api.WorkerKnowledgeBaseConfig{
			localEntryOf("a.example:local", "http://192.168.64.1:14000", ""),
			localEntryOf("b.example:local", "http://192.168.64.1:14001", "ANTHROPIC_API_KEY"),
		},
		Added: []addedKB{
			addedKBOf("x.example:kb", "https://x.example", "https://id.x/realms/x", "semiont-worker-alice", "b.example:local"),
			addedKBOf("y.example:kb", "https://y.example", "https://id.y/realms/y", "semiont-worker-alice", "gone.example:local"),
			addedKBOf("z.example:kb", "https://z.example", "https://id.z/realms/z", "semiont-worker-alice", "a.example:local"),
		},
	}
	entries, unserved := list.served()
	var domains []string
	for _, e := range entries {
		domains = append(domains, e.Domain)
	}
	if want := []string{"a.example:local", "b.example:local", "x.example:kb", "z.example:kb"}; !reflect.DeepEqual(domains, want) {
		t.Fatalf("the document serves %v, want %v", domains, want)
	}
	if !reflect.DeepEqual(entries[2], list.Added[0].entry(list.Local[1].Engines)) || !reflect.DeepEqual(entries[3], list.Added[2].entry(list.Local[0].Engines)) {
		t.Errorf("an added knowledge base is not offered its lender's engines: %+v", entries[2:])
	}
	if len(unserved) != 1 || unserved[0].Domain != "y.example:kb" {
		t.Errorf("unserved %+v, want y.example:kb, whose lender is not on the list", unserved)
	}
	b, err := workerDocument(entries, catalogWorkerPoolDocument)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 20; i++ {
		again, _ := workerDocument(entries, catalogWorkerPoolDocument)
		if string(again) != string(b) {
			t.Fatalf("the same list gave two worker documents:\n%s\nand\n%s", b, again)
		}
	}
}

// A start takes off the list its own old entry, which it places afresh, and
// every other local knowledge base whose gateway was on the port its own
// takes: none of those answers there now, and the worker refuses for good a
// knowledge base that answers as another. One on another port stays, as do
// the added ones.
func TestAStartDisplacesTheLocalKnowledgeBasesOnItsGatewayPort(t *testing.T) {
	harness.Home(t)
	added := addedKBOf("x.example:kb", "https://x.example", "https://id.x/realms/x", "semiont-worker-alice", "c.example:local")
	if err := saveWorkerList(workerList{
		Local: []api.WorkerKnowledgeBaseConfig{
			localEntryOf("a.example:local", "http://192.168.64.1:14000", ""),
			localEntryOf("b.example:local", "http://192.168.64.1:14000", ""),
			localEntryOf("c.example:local", "http://192.168.64.1:14001", ""),
			localEntryOf("d.example:local", "http://192.168.64.2:14000", ""),
		},
		Added: []addedKB{added},
	}); err != nil {
		t.Fatal(err)
	}
	serving, err := planWorkerServing("b.example:local", 14000)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"a.example:local", "d.example:local"}; !reflect.DeepEqual(serving.displaced, want) {
		t.Errorf("displaced %v, want %v: every other local one on port 14000, whatever its address", serving.displaced, want)
	}
	if len(serving.others.Local) != 1 || serving.others.Local[0].Domain != "c.example:local" {
		t.Errorf("the others on the list are %+v, want c.example:local alone", serving.others.Local)
	}
	if !reflect.DeepEqual(serving.others.Added, []addedKB{added}) {
		t.Errorf("the added ones are %+v, want them as they were", serving.others.Added)
	}
	if after := keptList(t); len(after.Local) != 4 {
		t.Errorf("planning changed the list kept: %+v", after)
	}
}

// A start of a knowledge base that is added to the worker as one someone else
// runs is refused, saying how to remove it: the worker refuses a document
// that names one domain twice.
func TestAKnowledgeBaseAddedToItsOwnStartIsRefused(t *testing.T) {
	harness.Home(t)
	if err := saveWorkerList(workerList{Added: []addedKB{
		addedKBOf("a.example:kb", "https://a.example", "https://id.a.example/realms/a", "semiont-worker-alice", "c.example:local"),
		addedKBOf(exampleKB.Domain, "https://example.github.io", "https://id.example/realms/kb", "semiont-worker-alice", "c.example:local"),
	}}); err != nil {
		t.Fatal(err)
	}
	_, err := planWorkerServing(exampleKB.Domain, 14000)
	if err == nil || !strings.Contains(err.Error(), "semiont worker kb remove "+exampleKB.Domain) {
		t.Errorf("want a refusal saying how to remove %s, got %v", exampleKB.Domain, err)
	}
}

// The worker is handed the key of every engine its list names: this start's,
// and each other local knowledge base's; and the knowledge base whose engines
// alone name one is the one a missing key's refusal names.
func TestTheWorkerIsHandedEveryKeyItsListNames(t *testing.T) {
	p := placed(t, fixtureStack(t, "ollama-gemma"))
	p.plan.Serving.others.Local = []api.WorkerKnowledgeBaseConfig{
		localEntryOf("a.example:local", "http://192.168.64.1:14001", "ANTHROPIC_API_KEY"),
		localEntryOf("b.example:local", "http://192.168.64.1:14002", "OTHER_KEY"),
	}
	if got := workerSecrets(p); !reflect.DeepEqual(got, []string{"ANTHROPIC_API_KEY", "OTHER_KEY"}) {
		t.Errorf("the worker is handed %v, want both listed knowledge bases' keys", got)
	}
	if kb, ok := p.plan.Serving.keyNamer("OTHER_KEY"); !ok || kb != "b.example:local" {
		t.Errorf("OTHER_KEY is named by %q, want b.example:local", kb)
	}
	if _, ok := p.plan.Serving.keyNamer("UNNAMED"); ok {
		t.Error("a variable no listed engine names has a namer")
	}
}

// `add`, run inside a local knowledge base on the list, asks the gateway which
// issuer it trusts and keeps that, with the local knowledge base whose
// engines it is offered, to its owner, for the machine: what a start reads.
func TestWorkerKBAddKeepsWhatTheGatewayNames(t *testing.T) {
	harness.Home(t)
	lender := insideLocalKB(t)
	gateway := gatewayNaming(t, "https://id.other.example/realms/kb")
	code, stdout, stderr := workerOutput(t, "kb", "add", "other.example:kb", "--gateway", gateway, "--client-id", "semiont-worker-alice")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	harness.MustContainAll(t, "stdout", stdout, "added other.example:kb", "https://id.other.example/realms/kb", "semiont-worker-alice", "Engines of: "+lender)
	want := []addedKB{addedKBOf("other.example:kb", gateway, "https://id.other.example/realms/kb", "semiont-worker-alice", lender)}
	if got := keptList(t).Added; !reflect.DeepEqual(got, want) {
		t.Errorf("kept %+v, want %+v", got, want)
	}
	kept := workerListPath()
	if fi, err := os.Stat(kept); err != nil {
		t.Fatalf("nothing is kept for the machine: %v", err)
	} else if fi.Mode().Perm()&0o077 != 0 {
		t.Errorf("the worker's list is readable beyond its owner: %v", fi.Mode().Perm())
	}
	if _, err := os.Stat(kept + ".tmp"); !os.IsNotExist(err) {
		t.Errorf("the write left its temporary file: %v", err)
	}
}

// Adding a domain already added replaces its entry, says so, and keeps the
// others; the kept order is the domains', whatever order they were added in.
func TestWorkerKBAddOfADomainAddedReplacesIt(t *testing.T) {
	harness.Home(t)
	lender := insideLocalKB(t)
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
		addedKBOf("a.example:kb", first, "https://id.one/realms/kb", "semiont-worker-alice", lender),
		addedKBOf("z.example:kb", second, "https://id.two/realms/kb", "semiont-worker-zed", lender),
	}
	if got := keptList(t).Added; !reflect.DeepEqual(got, want) {
		t.Errorf("kept %+v, want %+v", got, want)
	}
}

// A gateway that cannot be reached, or names no issuer, adds nothing: the
// worker could sign in nowhere. Nor does anything `add` must not keep: a
// domain that names no knowledge base, a gateway or client left out, or a
// domain that is a local knowledge base on the list.
func TestWorkerKBAddThatFailsKeepsNothing(t *testing.T) {
	harness.Home(t)
	lender := insideLocalKB(t)
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
		{[]string{"kb", "add", lender, "--gateway", named, "--client-id", "semiont-worker-alice"}, lender + " is a local knowledge base on this machine's worker's list"},
	} {
		code, _, stderr := workerOutput(t, c.args...)
		if code != 1 {
			t.Errorf("%v: exit %d, want 1", c.args, code)
		}
		harness.MustContainAll(t, "stderr", stderr, c.want)
	}
	if added := keptList(t).Added; len(added) != 0 {
		t.Errorf("a failed add kept %+v", added)
	}
}

// `add` offers the one added a local knowledge base's engines, so it runs
// inside one on the list: outside every knowledge base, or inside one not on
// the list, it adds nothing.
func TestWorkerKBAddRunsInsideALocalKnowledgeBaseOnTheList(t *testing.T) {
	harness.Home(t)
	named := gatewayNaming(t, "https://id.other.example/realms/kb")
	add := []string{"kb", "add", "other.example:kb", "--gateway", named, "--client-id", "semiont-worker-alice"}

	lender := insideLocalKB(t)
	if err := saveWorkerList(workerList{}); err != nil {
		t.Fatal(err)
	}
	code, _, stderr := workerOutput(t, add...)
	if code != 1 {
		t.Errorf("inside a knowledge base not on the list: exit %d, want 1", code)
	}
	harness.MustContainAll(t, "stderr", stderr, lender+" is not on this machine's worker's list", "A start of it puts it there")

	t.Chdir(t.TempDir())
	code, _, stderr = workerOutput(t, add...)
	if code != 1 {
		t.Errorf("outside a knowledge base: exit %d, want 1", code)
	}
	harness.MustContainAll(t, "stderr", stderr, "add runs inside a local knowledge base on this machine's worker's list")
	if _, err := os.Stat(workerListPath()); !os.IsNotExist(err) {
		t.Errorf("a refused add kept a list: %v", err)
	}
}

// `remove` takes that knowledge base off the list and no other, an added one
// or a local one; a local one whose engines an added one is offered is
// refused, naming it; one not on the list is refused, naming what is. The
// last taken off leaves no file, as before anything was put on it.
func TestWorkerKBRemoveTakesOffThatOneAlone(t *testing.T) {
	harness.Home(t)
	if err := saveWorkerList(workerList{
		Local: []api.WorkerKnowledgeBaseConfig{
			localEntryOf("a.example:local", "http://192.168.64.1:14000", ""),
			localEntryOf("b.example:local", "http://192.168.64.1:14001", ""),
		},
		Added: []addedKB{addedKBOf("x.example:kb", "https://x.example", "https://id.x/realms/x", "semiont-worker-alice", "b.example:local")},
	}); err != nil {
		t.Fatal(err)
	}
	code, _, stderr := workerOutput(t, "kb", "remove", "c.example:kb")
	if code != 1 {
		t.Errorf("remove of a knowledge base not on the list: exit %d, want 1", code)
	}
	harness.MustContainAll(t, "stderr", stderr, "c.example:kb is not on this machine's worker's list", "On it: a.example:local, b.example:local, x.example:kb")

	code, _, stderr = workerOutput(t, "kb", "remove", "b.example:local")
	if code != 1 {
		t.Errorf("remove of a lender: exit %d, want 1", code)
	}
	harness.MustContainAll(t, "stderr", stderr, "b.example:local's engines are offered to x.example:kb")

	for _, domain := range []string{"a.example:local", "x.example:kb"} {
		if code, _, stderr := workerOutput(t, "kb", "remove", domain); code != 0 {
			t.Fatalf("remove %s: exit %d\n%s", domain, code, stderr)
		}
	}
	if got := keptList(t); len(got.Local) != 1 || got.Local[0].Domain != "b.example:local" || len(got.Added) != 0 {
		t.Errorf("kept %+v, want b.example:local alone", got)
	}
	if code, _, stderr := workerOutput(t, "kb", "remove", "b.example:local"); code != 0 {
		t.Fatalf("exit %d\n%s", code, stderr)
	}
	if _, err := os.Stat(workerListPath()); !os.IsNotExist(err) {
		t.Errorf("an empty list left a file: %v", err)
	}
	code, _, stderr = workerOutput(t, "kb", "remove", "b.example:local")
	if code != 1 {
		t.Errorf("remove with nothing on the list: exit %d, want 1", code)
	}
	harness.MustContainAll(t, "stderr", stderr, "Nothing is.")
}

// `list` prints each knowledge base on the list, the local ones first, with
// what is kept of it; with nothing on it it says so, and prints nothing a
// pipe would read.
func TestWorkerKBListPrintsWhatIsKept(t *testing.T) {
	harness.Home(t)
	code, stdout, stderr := workerOutput(t, "kb", "list")
	if code != 0 || stdout != "" {
		t.Errorf("with nothing on the list: exit %d, stdout %q", code, stdout)
	}
	harness.MustContainAll(t, "stderr", stderr, "Nothing is on this machine's worker's list")

	if err := saveWorkerList(workerList{
		Local: []api.WorkerKnowledgeBaseConfig{localEntryOf("b.example:local", "http://192.168.64.1:14000", "")},
		Added: []addedKB{addedKBOf("a.example:kb", "https://a.example", "https://id.a/realms/a", "semiont-worker-alice", "b.example:local")},
	}); err != nil {
		t.Fatal(err)
	}
	code, stdout, stderr = workerOutput(t, "kb", "list")
	if code != 0 {
		t.Fatalf("exit %d\n%s", code, stderr)
	}
	want := "b.example:local (local)\n" +
		"  Gateway:    http://192.168.64.1:14000\n" +
		"  Issuer:     http://keycloak.localhost:8080/realms/semiont\n" +
		"  Client id:  " + serviceClientID("worker") + "\n" +
		"a.example:kb (added)\n" +
		"  Gateway:    https://a.example\n" +
		"  Issuer:     https://id.a/realms/a\n" +
		"  Client id:  semiont-worker-alice\n" +
		"  Engines of: b.example:local\n"
	if stdout != want {
		t.Errorf("list printed:\n%s\nwant:\n%s", stdout, want)
	}
}

// What is kept and cannot be read is refused by every verb that reads it, and
// by the start, naming the file: never read as an empty list.
func TestAnUnreadableKeptFileIsRefused(t *testing.T) {
	harness.Home(t)
	kept := workerListPath()
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
		harness.MustContainAll(t, "stderr", stderr, kept, "does not hold the knowledge bases this machine's worker serves")
	}
	if _, err := planWorkerServing(exampleKB.Domain, 14000); err == nil || !strings.Contains(err.Error(), kept) {
		t.Errorf("a start read an unreadable list as %v, want its refusal naming %s", err, kept)
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
