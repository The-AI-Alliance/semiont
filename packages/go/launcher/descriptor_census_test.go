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
// what start's preflight clears and stop tears down — except the shared ones,
// each named for why: a container a stack runs that its sweep misses survives
// the teardown, and the port check then reports it as somebody else's
// process.
func TestAStacksSweepCoversEveryContainerItRuns(t *testing.T) {
	shared := map[string]string{
		"worker":    "the shared worker: kept or replaced by flowWorker, and stopped after the last stack by stopSharedServices, from its own record, since it serves every KB on its list",
		"browser":   "not a stack member — kept open across stacks, and stopped after the last stack by stopSharedServices, from its own record",
		"inference": "the shared Ollama: kept or replaced in the Ollama section, where a host instance may make the container unnecessary, and stopped after the last stack, from its own record",
		"collector": "the shared collector: kept or replaced by flowShared, and stopped after the last stack, from its own record, since it takes every KB's signals",
		"metrics":   "the shared Prometheus: kept or replaced by flowShared, and stopped after the last stack, from its own record",
		"traces":    "the shared Jaeger: kept or replaced by flowShared, and stopped after the last stack, from its own record",
	}
	swept := stackContainers("kb")
	for _, d := range serviceDescriptors {
		c := d.containerName("kb")
		if c == "" {
			continue // this driver launches nothing (oidc, anthropic, voyage, shared Ollama)
		}
		if reason, exempt := shared[d.role]; exempt {
			if contains(swept, c) {
				t.Errorf("%s/%s is shared (%s), but a stack's sweep lists it", d.role, d.driver, reason)
			}
			if !sharedRole(d.role) {
				t.Errorf("%s/%s is exempt as shared, but sharedRoles does not name it", d.role, d.driver)
			}
			continue
		}
		if !contains(swept, c) {
			t.Errorf("%s/%s runs %s, which a stack's sweep never reaches — it survives the teardown",
				d.role, d.driver, c)
		}
	}
}

// A shared role's container is the shared one, whatever knowledge base
// asks; a stack role's is named for its knowledge base, so two knowledge
// bases' stacks never share a name. Naming a stack's container for no
// knowledge base is a fault, not a name.
func TestAStacksContainersAreNamedForItsKnowledgeBase(t *testing.T) {
	for role, want := range map[string]string{
		"identity-store": "semiont-example.org-kb-postgres",
		"gateway":        "semiont-example.org-kb-gateway",
		"identity":       "semiont-example.org-kb-keycloak",
		"worker":         "semiont-worker",
		"inference":      "semiont-ollama",
		"collector":      "semiont-otel-collector",
	} {
		if got := roleContainer(role, "example.org-kb"); got != want {
			t.Errorf("%s runs %s, want %s", role, got, want)
		}
	}
	if a, b := roleContainer("identity-store", "a"), roleContainer("identity-store", "b"); a == b {
		t.Errorf("two knowledge bases' identity stores share the name %s", a)
	}
	defer func() {
		if recover() == nil {
			t.Error("a stack's container was named for no knowledge base")
		}
	}()
	roleContainer("identity-store", "")
}

// The `--service` vocabulary, derived from the start walk: a reader meets
// the roles in the order they come up — one list of roles, not two.
func TestRoleListDerivesTheStartWalk(t *testing.T) {
	want := "traces, metrics, collector, identity-store, messaging, identity, gateway, graph, vectors, inference, embedding, archivist, librarian, dispatcher, worker, smelter, weaver, or browser"
	if roleList != want {
		t.Errorf("roleList =\n  %s\nwant\n  %s", roleList, want)
	}
}

// Every role is in one group, each group's roles are roles, and no two groups
// share a name. The telemetry group is the telemetry the launcher runs for every knowledge base here, and holds the backends --no-observe leaves out.
func TestEveryRoleHasOneGroup(t *testing.T) {
	groupOf := map[string]string{}
	var telemetry []string
	for _, g := range serviceGroups {
		for _, role := range g.roles {
			if !knownRole(role) {
				t.Errorf("the %s group names %q, which is not a role", g.name, role)
			}
			if other, ok := groupOf[role]; ok {
				t.Errorf("%s is in the %s group and the %s group", role, other, g.name)
			}
			groupOf[role] = g.name
			if g.name == "telemetry" {
				telemetry = append(telemetry, role)
			}
		}
	}
	for _, role := range roleOrder {
		if _, ok := groupOf[role]; !ok {
			t.Errorf("%s is in no group", role)
		}
	}
	named := map[string]bool{}
	for _, g := range serviceGroups {
		if named[g.name] {
			t.Errorf("two groups are named %s", g.name)
		}
		named[g.name] = true
	}
	if got, want := slices.Sorted(slices.Values(telemetry)), slices.Sorted(slices.Values(telemetryRoles)); !slices.Equal(got, want) {
		t.Errorf("the telemetry group is %v; the shared telemetry is %v", got, want)
	}
	for _, role := range optionalBackends {
		if groupOf[role] != "telemetry" {
			t.Errorf("--no-observe leaves out %s, which is in the %s group, not telemetry", role, groupOf[role])
		}
	}
	var shared []string
	for _, g := range serviceGroups {
		if g.shared() {
			shared = append(shared, g.name)
		}
	}
	// The issuer joins them when one Keycloak serves every knowledge base.
	assertNames(t, "shared groups", shared, []string{"knowledge-workers", "providers", "telemetry"})
}

// The realm's accounts are every Semiont service that presents a token to
// another: the stack's, each with a secret, and the shared worker, which
// proves itself with the worker key. The Browser presents none — it is a
// viewer, and the only Semiont role without an account. The list is derived;
// the literal pins it.
func TestSecretClientsDeriveTheRealmAccountList(t *testing.T) {
	assertNames(t, "secretClients", secretClients,
		[]string{"archivist", "dispatcher", "gateway", "librarian", "smelter", "weaver"})
	if slices.Contains(stackServices, "worker") || slices.Contains(secretClients, "worker") || !slices.Contains(sharedRoles, "worker") {
		t.Error("the worker is shared, not a stack service, and proves itself with a key, not a secret")
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
	var products, shared []string
	for _, d := range serviceDescriptors {
		switch c := d.containerName("kb"); {
		case c == "":
		case sharedRole(d.role):
			shared = append(shared, c)
		default:
			products = append(products, d.name)
		}
	}
	roles := slices.Clone(roleOrder)
	for _, list := range []*[]string{&roles, &products, &shared} {
		slices.Sort(*list)
		*list = slices.Compact(*list)
	}
	assertNames(t, "the roles --service takes", named("takes a role name from the tables above: ", ". It takes"), roles)
	assertNames(t, "a knowledge base's products", named("`<product>` is ", ". `<kb>`"), products)
	assertNames(t, "the shared containers", named("are named `semiont-<name>`: ", ".\n"), shared)
}

// The operator's guide tells a reader the groups `status` reads and `--group`
// takes, what each holds and whether every knowledge base shares it. Its table
// is held to serviceGroups here, so a group or a member the launcher gains
// fails until the guide names it.
func TestTheOperatorGuideNamesEachGroup(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "docs", "operator", "LOCAL-SEMIONT.md"))
	if err != nil {
		t.Fatal(err)
	}
	_, section, ok := strings.Cut(string(b), "## What runs\n")
	if !ok {
		t.Fatal("the operator's guide has no section on what runs")
	}
	section, _, _ = strings.Cut(section, "\n## ")
	backticked := regexp.MustCompile("`([^`]+)`")
	var rows [][]string
	for _, line := range strings.Split(section, "\n") {
		cells := strings.Split(strings.Trim(line, "|"), "|")
		if len(cells) != 3 || !strings.HasPrefix(strings.TrimSpace(cells[0]), "`") {
			continue
		}
		row := []string{strings.Trim(strings.TrimSpace(cells[0]), "`"), strings.TrimSpace(cells[2])}
		for _, m := range backticked.FindAllStringSubmatch(cells[1], -1) {
			row = append(row, m[1])
		}
		rows = append(rows, row)
	}
	if len(rows) != len(serviceGroups) {
		t.Fatalf("the guide's table has %d groups, want %d: %v", len(rows), len(serviceGroups), rows)
	}
	for i, g := range serviceGroups {
		whose := "each knowledge base's own"
		if g.shared() {
			whose = "shared"
		}
		want := append([]string{g.name, whose}, g.roles...)
		if !slices.Equal(rows[i], want) {
			t.Errorf("the guide's row %d reads %q, want %q", i+1, rows[i], want)
		}
	}
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

// The SERVICE column is as wide as its longest cell: a role, and the product
// a driver of it names.
func TestTheServiceColumnIsAsWideAsItsLongestCell(t *testing.T) {
	longest := ""
	for _, role := range roleOrder {
		for _, driver := range driversFor(role) {
			if cell := role + " (" + driverDisplay(role, driver) + ")"; len(cell) > len(longest) {
				longest = cell
			}
		}
	}
	if len(longest) != serviceCell {
		t.Errorf("the longest SERVICE cell is %q, %d wide; the column is %d", longest, len(longest), serviceCell)
	}
}
