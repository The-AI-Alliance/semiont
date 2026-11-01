package launcher

import (
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// Every image the launcher names is pinned: a tag a reader goes by, and the
// digest of the bytes that run. A tag alone can be moved to other bytes.
func TestEveryImageTheLauncherNamesIsPinnedByDigest(t *testing.T) {
	pinned := regexp.MustCompile(`^[a-z0-9./_-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$`)
	images := map[string]string{"the probe": probeImage}
	for _, d := range serviceDescriptors {
		if d.image != "" {
			images[d.role+"/"+d.driver] = d.image
		}
	}
	if len(images) < 2 {
		t.Fatal("the table names no image: the census read nothing")
	}
	for what, image := range images {
		if !pinned.MatchString(image) {
			t.Errorf("%s runs %q, which is not a tag pinned by its digest (name:tag@sha256:<64 hex>)", what, image)
		}
	}
}

// ONE descriptor set, keyed by (role, driver), owns the facts: the two sweep
// lists, the `--service` vocabulary and the realm's client list derive from
// it, and the status roster is checked against it.
//
// The literals below are not a second home for those facts: they pin what
// the derivation produces, name for name and position for position. Delete
// a literal only together with the behaviour it pins.

// Every container the descriptor set can produce is in a stack's sweep —
// what start's preflight clears and stop tears down — except the machine's,
// each named for why: a container a stack runs that its sweep misses survives
// the teardown, and the port check then reports it as somebody else's
// process.
func TestAStacksSweepCoversEveryContainerItRuns(t *testing.T) {
	machine := map[string]string{
		"worker":    "the machine's worker: kept or replaced by flowWorker, and stopped after the last stack by stopMachineServices, from its own record, since it serves every KB on its list",
		"browser":   "not a stack member — kept open across stacks, and stopped after the last stack by stopMachineServices, from its own record",
		"inference": "the machine's Ollama: kept or replaced in the Ollama section, where a host instance may make the container unnecessary, and stopped after the last stack, from its own record",
		"collector": "the machine's collector: kept or replaced by flowMachine, and stopped after the last stack, from its own record, since it takes every KB's signals",
		"metrics":   "the machine's Prometheus: kept or replaced by flowMachine, and stopped after the last stack, from its own record",
		"traces":    "the machine's Jaeger: kept or replaced by flowMachine, and stopped after the last stack, from its own record",
	}
	swept := stackContainers("kb")
	for _, d := range serviceDescriptors {
		c := d.containerName("kb")
		if c == "" {
			continue // this driver launches nothing (oidc, anthropic, voyage, shared Ollama)
		}
		if reason, exempt := machine[d.role]; exempt {
			if contains(swept, c) {
				t.Errorf("%s/%s is the machine's (%s), but a stack's sweep lists it", d.role, d.driver, reason)
			}
			if !machineRole(d.role) {
				t.Errorf("%s/%s is exempt as the machine's, but machineRoles does not name it", d.role, d.driver)
			}
			continue
		}
		if !contains(swept, c) {
			t.Errorf("%s/%s runs %s, which a stack's sweep never reaches — it survives the teardown",
				d.role, d.driver, c)
		}
	}
}

// A machine role's container is the machine's one, whatever knowledge base
// asks; a stack role's is named for its knowledge base, so two knowledge
// bases' stacks never share a name. Naming a stack's container for no
// knowledge base is a fault, not a name.
func TestAStacksContainersAreNamedForItsKnowledgeBase(t *testing.T) {
	for role, want := range map[string]string{
		"database":  "semiont-example.org-kb-postgres",
		"gateway":   "semiont-example.org-kb-gateway",
		"identity":  "semiont-example.org-kb-keycloak",
		"worker":    "semiont-worker",
		"inference": "semiont-ollama",
		"collector": "semiont-otel-collector",
	} {
		if got := roleContainer(role, "example.org-kb"); got != want {
			t.Errorf("%s runs %s, want %s", role, got, want)
		}
	}
	if a, b := roleContainer("database", "a"), roleContainer("database", "b"); a == b {
		t.Errorf("two knowledge bases' databases share the name %s", a)
	}
	defer func() {
		if recover() == nil {
			t.Error("a stack's container was named for no knowledge base")
		}
	}()
	roleContainer("database", "")
}

// The `--service` vocabulary, derived from the start walk: a reader meets
// the roles in the order they come up — one list of roles, not two.
func TestRoleListDerivesTheStartWalk(t *testing.T) {
	want := "traces, metrics, collector, database, messaging, identity, gateway, graph, vectors, inference, embedding, archivist, librarian, dispatcher, worker, smelter, weaver, or browser"
	if roleList != want {
		t.Errorf("roleList =\n  %s\nwant\n  %s", roleList, want)
	}
}

// statusServices names roles; the descriptor set says which roles exist. The
// Browser is the one role status reports elsewhere (printBrowser opens the
// report, above every stack it views).
func TestStatusReportCoversEveryRole(t *testing.T) {
	reported := map[string]bool{}
	for _, s := range statusServices {
		if !knownRole(s.name) {
			t.Errorf("statusServices names %q, which is not a role", s.name)
		}
		reported[s.name] = true
	}
	for _, r := range roleOrder {
		if r == "browser" {
			if reported[r] {
				t.Errorf("browser is reported by printBrowser, above the stack table; it must not also be a row")
			}
			continue
		}
		if !reported[r] {
			t.Errorf("role %q exists but `semiont status` never reports it", r)
		}
	}
}

// The realm's accounts are every Semiont service that presents a token to
// another: the stack's, each with a secret, and the machine's worker, which
// proves itself with the machine's key. The Browser presents none — it is a
// viewer, and the only Semiont role without an account. The list is derived;
// the literal pins it.
func TestSecretClientsDeriveTheRealmAccountList(t *testing.T) {
	assertNames(t, "secretClients", secretClients,
		[]string{"archivist", "dispatcher", "gateway", "librarian", "smelter", "weaver"})
	if slices.Contains(stackServices, "worker") || slices.Contains(secretClients, "worker") || !slices.Contains(machineRoles, "worker") {
		t.Error("the worker is the machine's, not a stack service, and proves itself with a key, not a secret")
	}
}

// What keeping role and driver apart is FOR: a row asserting a container
// for a role is a row about a (role, driver) pair, so the identity role
// cannot claim Keycloak's container while the config selects an external
// issuer.
func TestExternalDriversCarryNoContainer(t *testing.T) {
	for _, pair := range [][2]string{{"identity", "oidc"}, {"inference", "anthropic"}, {"embedding", "voyage"}, {"embedding", "ollama"}} {
		d, ok := lookupDescriptor(pair[0], pair[1])
		if !ok {
			t.Fatalf("no descriptor for %s/%s", pair[0], pair[1])
		}
		if d.name != "" || d.image != "" || d.mem != "" {
			t.Errorf("%s/%s launches nothing, yet its descriptor claims container=%q image=%q mem=%q",
				pair[0], pair[1], d.name, d.image, d.mem)
		}
	}
}

// roleContainer answers with ONE name, which is only honest while no role
// has drivers running different containers. The day one does (a JanusGraph
// beside Neo4j), every roleContainer site must take a driver instead — this
// is the test that says so rather than letting the first row win silently.
func TestNoRoleHasTwoContainerNames(t *testing.T) {
	for _, role := range roleOrder {
		if names := containersForRole(role, "kb"); len(names) > 1 {
			t.Errorf("role %q runs %v — roleContainer() would answer with %q alone; the single-handle sites (status, logs, stop --service) must take a driver",
				role, names, names[0])
		}
	}
}

// The service catalog tells a reader the names `--service` takes and the
// containers a stack runs. Each list is held to the descriptors here, so a
// role or a container the table gains fails until the catalog names it.
func TestTheServiceCatalogNamesWhatTheDescriptorsRun(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "docs", "operator", "services", "OVERVIEW.md"))
	if err != nil {
		t.Fatal(err)
	}
	_, section, ok := strings.Cut(string(b), "## The launcher's names\n")
	if !ok {
		t.Fatal("the service catalog has no section on the launcher's names")
	}
	section, _, _ = strings.Cut(section, "\n## ")
	backticked := regexp.MustCompile("`([^`]+)`")
	named := func(after, upTo string) []string {
		t.Helper()
		_, rest, ok := strings.Cut(section, after)
		if !ok {
			t.Fatalf("the launcher's names say nothing after %q", after)
		}
		clause, _, _ := strings.Cut(rest, upTo)
		var out []string
		for _, m := range backticked.FindAllStringSubmatch(clause, -1) {
			out = append(out, m[1])
		}
		slices.Sort(out)
		return out
	}
	var products, machine []string
	for _, d := range serviceDescriptors {
		switch c := d.containerName("kb"); {
		case c == "":
		case machineRole(d.role):
			machine = append(machine, c)
		default:
			products = append(products, d.name)
		}
	}
	roles := slices.Clone(roleOrder)
	for _, list := range []*[]string{&roles, &products, &machine} {
		slices.Sort(*list)
		*list = slices.Compact(*list)
	}
	assertNames(t, "the roles --service takes", named("takes a role name from the tables above: ", ". It takes"), roles)
	assertNames(t, "a knowledge base's products", named("`<product>` is ", ". `<kb>`"), products)
	assertNames(t, "the machine's containers", named("are named `semiont-<name>`: ", ".\n"), machine)
}

func assertNames(t *testing.T, what string, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s has %d entries, want %d:\n  got  %s\n  want %s", what, len(got), len(want), strings.Join(got, " "), strings.Join(want, " "))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%s[%d] = %q, want %q:\n  got  %s\n  want %s", what, i, got[i], want[i], strings.Join(got, " "), strings.Join(want, " "))
		}
	}
}
