package launcher

import (
	"slices"
	"sort"
	"testing"
)

// Each of Semiont's services the stack runs is run from the image its
// document names, with the memory its document states: the plan carries one
// of each for every such service and for nothing else, and a change to one
// service's document changes that service alone. (A stack that runs no
// worker: TestPlanRunsAWorkerOnlyWhenAJobIsBound.)
func TestThePlanRunsEachServiceAsItsDocumentSays(t *testing.T) {
	before := mustPlan(t, fixtureStack(t, "anthropic"))
	for what, services := range map[string]map[string]string{"an image": before.Images, "a memory": before.Memory} {
		var got []string
		for svc := range services {
			got = append(got, svc)
		}
		sort.Strings(got)
		want := slices.Clone(stackServices)
		sort.Strings(want)
		if !slices.Equal(got, want) {
			t.Errorf("the plan gives %s to %v, want each service the stack runs: %v", what, got, want)
		}
	}

	st := fixtureStack(t, "anthropic")
	st.KnowledgeIndex.Spec.Smelter.Resources.Limits.Memory = "8G"
	st.KnowledgeBase.Spec.Gateway.Image = "ghcr.io/the-ai-alliance/semiont-gateway:local"
	after := mustPlan(t, st)
	for svc := range before.Memory {
		want := before.Memory[svc]
		if svc == "smelter" {
			want = "8G"
		}
		if after.Memory[svc] != want {
			t.Errorf("%s is given %s, want %s", svc, after.Memory[svc], want)
		}
	}
	for svc := range before.Images {
		want := before.Images[svc]
		if svc == "gateway" {
			want = st.KnowledgeBase.Spec.Gateway.Image
		}
		if after.Images[svc] != want {
			t.Errorf("%s runs from %s, want %s", svc, after.Images[svc], want)
		}
	}
}
