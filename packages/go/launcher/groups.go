package launcher

// groups.go — the groups the launcher's roles fall into: what `status` shows
// together and what a start or stop of a group acts on.

import "iter"

// serviceGroup: roles that are part of one thing, in the order status reads
// them.
type serviceGroup struct {
	name  string
	roles []string
}

// serviceGroups: every role, each in one group. A knowledge base is its
// record and its index, with the issuer whose accounts sign in to it. The
// knowledge workers are where people and agents work on it. The providers
// serve every knowledge base its models, and the telemetry watches them all.
var serviceGroups = []serviceGroup{
	{"record", []string{"gateway", "archivist", "dispatcher", "messaging"}},
	{"index", []string{"librarian", "smelter", "weaver", "graph", "vectors"}},
	{"issuer", []string{"identity", "identity-store"}},
	{"knowledge-workers", []string{"browser", "worker"}},
	{"providers", []string{"inference", "embedding"}},
	{"telemetry", []string{"collector", "traces", "metrics"}},
}

// groupedRoles: each group's name and each of its roles, group by group.
func groupedRoles() iter.Seq2[string, string] {
	return func(yield func(string, string) bool) {
		for _, g := range serviceGroups {
			for _, role := range g.roles {
				if !yield(g.name, role) {
					return
				}
			}
		}
	}
}

// optionalBackends: the telemetry backends --no-observe leaves out. Status
// reports them, and does not count them toward its exit status.
var optionalBackends = []string{"traces", "metrics"}
