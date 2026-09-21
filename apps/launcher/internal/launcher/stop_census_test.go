package launcher

import "testing"

// Two hand-written lists name the containers the launcher sweeps: start's
// preflight (preflightNames) and stop's teardown (stopNames). The roles table
// owns the names themselves, so both lists are mirrors of it — and a mirror
// nothing checks drifts silently. It did: `semiont-keycloak` reached preflight
// and never reached stop, so `semiont stop` left Keycloak running and the
// port-release check then called it "not a Semiont container". Invisible,
// because the NEXT start's preflight swept it.
//
// The Browser is the one documented absence from stopNames: it is not a stack
// member (BROWSER-LIFECYCLE), so a bare stop deliberately leaves the viewer up.
func TestEverySweepListCoversEveryContainerRole(t *testing.T) {
	in := func(list []string, name string) bool {
		for _, n := range list {
			if n == name {
				return true
			}
		}
		return false
	}
	// The two DOCUMENTED absences, each with the reason it is one. Anything
	// else missing is drift.
	noPreflight := map[string]string{
		"browser":   "not a stack member — the preflight must not sweep a viewer kept open across stacks (BROWSER-LIFECYCLE)",
		"inference": "handled in the Ollama section, where a host instance may make the container unnecessary",
	}
	noStop := map[string]string{
		"browser": "not a stack member — a bare stop leaves the viewer running; `stop --service browser` is its off-switch",
	}
	for role, spec := range roles {
		if spec.container == "" {
			continue // a role with no container of its own (embedding)
		}
		if _, exempt := noPreflight[role]; !exempt && !in(preflightNames, spec.container) {
			t.Errorf("role %q runs %s, which start's preflight never sweeps — a survivor of the last run holds its port and the start fails on it",
				role, spec.container)
		}
		if _, exempt := noStop[role]; exempt {
			if in(stopNames, spec.container) {
				t.Errorf("role %q is exempt from stopNames (%s), but it is listed", role, noStop[role])
			}
			continue
		}
		if !in(stopNames, spec.container) {
			t.Errorf("role %q runs %s, which `semiont stop` never stops — it survives the teardown, and the port check then reports it as somebody else's process",
				role, spec.container)
		}
	}
}
