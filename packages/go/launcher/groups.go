package launcher

// groups.go — the groups the launcher's roles fall into: what `status` shows
// together and what a start or stop of a group acts on.

import (
	"slices"
	"strings"
)

// serviceGroup: roles that are part of one thing, in the order status reads
// them.
type serviceGroup struct {
	name  string
	roles []string
}

// shared: whether g's services serve every knowledge base, once for all of
// them — a group the launcher runs a role of for the machine. Each knowledge
// base runs its own of the others.
func (g serviceGroup) shared() bool { return slices.ContainsFunc(g.roles, machineRole) }

// serviceGroups: every role, each in one group. A knowledge base is its
// record and its index, with the issuer whose accounts sign in to it while
// each runs a Keycloak of its own. The knowledge workers are where people
// and agents work on it. The providers serve every knowledge base its
// models, and the telemetry watches them all.
var serviceGroups = []serviceGroup{
	{"record", []string{"gateway", "archivist", "dispatcher", "messaging"}},
	{"index", []string{"librarian", "smelter", "weaver", "graph", "vectors"}},
	{"issuer", []string{"identity", "identity-store"}},
	{"knowledge-workers", []string{"browser", "worker"}},
	{"providers", []string{"inference", "embedding"}},
	{"telemetry", []string{"collector", "traces", "metrics"}},
}

// groupNamed: the group called name, as --group takes it.
func groupNamed(name string) (serviceGroup, bool) {
	i := slices.IndexFunc(serviceGroups, func(g serviceGroup) bool { return g.name == name })
	if i < 0 {
		return serviceGroup{}, false
	}
	return serviceGroups[i], true
}

// groupList: the names --group accepts, for usage and refusals.
var groupList = func() string {
	names := make([]string, len(serviceGroups))
	for i, g := range serviceGroups {
		names[i] = g.name
	}
	return strings.Join(names[:len(names)-1], ", ") + ", or " + names[len(names)-1]
}()

// groupMember: a role a group's stop acts on. because is "" for the
// group's own roles, and for one it takes along, the role it needs that
// brings it.
type groupMember struct{ role, because string }

// groupStops: what `stop --group g` stops, last-started first: g's roles,
// and each role of the knowledge base that needs one of them, transitively.
// A shared group stops alone: what needs it is in every knowledge base, and
// goes on without it. A machine's role that needs the group stops only with
// the last stack (last), as a bare stop stops the machine's containers.
func groupStops(g serviceGroup, last bool) []groupMember {
	because := map[string]string{}
	for _, role := range g.roles {
		because[role] = ""
	}
	if !g.shared() {
		// The start walk brings a role up after everything it needs, so one
		// pass in that order sees each dependency's verdict before its own.
		for _, role := range startOrder {
			if _, ok := because[role]; ok || machineRole(role) && !last {
				continue
			}
			for _, need := range dependenciesOf(role) {
				if _, ok := because[need]; ok {
					because[role] = need
					break
				}
			}
		}
	}
	return membersIn(teardownOrder, because)
}

// membersIn: the roles because names, in order.
func membersIn(order []string, because map[string]string) []groupMember {
	var out []groupMember
	for _, role := range order {
		if b, ok := because[role]; ok {
			out = append(out, groupMember{role, b})
		}
	}
	return out
}

// optionalBackends: the telemetry backends --no-observe leaves out. Status
// reports them, and does not count them toward its exit status.
var optionalBackends = []string{"traces", "metrics"}
