package launcher

// executor_roles_test.go — the census gate on the executor's surface
// (LAUNCHER-PACKAGE-BOUNDARIES P4).
//
// `executor` is the seam that lets flows.go be written once and walked twice,
// live and as a plan. That is worth keeping. What it had stopped being is a
// ROLE: 52 methods accumulated into a catalog of everything a flow can do, and
// a catalog is a thing you add to without deciding anything.
//
// So the catalog is now a composition of named roles, and this gate holds that
// shape: every method belongs to exactly one role, and the roles account for
// every method. A new effect therefore has to be PLACED — which is a decision,
// made once, where the next reader can see it — rather than appended to a list
// of 52.
//
// Reflection rather than a hand-written list, deliberately: a list here would
// be a second statement of the interface, and the first thing to drift.

import (
	"reflect"
	"sort"
	"strings"
	"testing"
)

func methodsOf[T any]() []string {
	t := reflect.TypeOf((*T)(nil)).Elem()
	names := make([]string, 0, t.NumMethod())
	for i := 0; i < t.NumMethod(); i++ {
		names = append(names, t.Method(i).Name)
	}
	sort.Strings(names)
	return names
}

func TestExecutorRolesPartitionItsSurface(t *testing.T) {
	roles := map[string][]string{
		"stager":    methodsOf[stager](),
		"runner":    methodsOf[runner](),
		"prober":    methodsOf[prober](),
		"recorder":  methodsOf[recorder](),
		"keeper":    methodsOf[keeper](),
		"admitter":  methodsOf[admitter](),
		"storer":    methodsOf[storer](),
		"modeler":   methodsOf[modeler](),
		"narrator":  methodsOf[narrator](),
		"modeScope": methodsOf[modeScope](),
	}

	owner := map[string]string{}
	for role, ms := range roles {
		for _, m := range ms {
			if prev, dup := owner[m]; dup {
				t.Errorf("%s is in two roles (%s and %s) — a method belongs to one", m, prev, role)
			}
			owner[m] = m0(role)
		}
	}

	var missing []string
	for _, m := range methodsOf[executor]() {
		if _, placed := owner[m]; !placed {
			missing = append(missing, m)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Errorf("%d executor method(s) belong to no role: %s\n"+
			"Put each in the role it serves. A method nobody placed is the catalog growing back.",
			len(missing), strings.Join(missing, ", "))
	}

	// The reverse: a role naming something the executor does not have would
	// mean the roles had drifted from the seam they describe.
	have := map[string]bool{}
	for _, m := range methodsOf[executor]() {
		have[m] = true
	}
	for role, ms := range roles {
		for _, m := range ms {
			if !have[m] {
				t.Errorf("role %s names %s, which executor does not have", role, m)
			}
		}
	}
}

func m0(s string) string { return s }
