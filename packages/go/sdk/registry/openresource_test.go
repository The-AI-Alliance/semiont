package registry_test

import (
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/registry"
)

func tab(named string, openedAt int64, order int) registry.OpenResource {
	return registry.OpenResource{ID: id(named), Name: "name of " + named, OpenedAt: openedAt, Order: order, MediaType: "text/plain"}
}

func ids(list []registry.OpenResource) []string {
	var named []string
	for _, each := range list {
		named = append(named, each.ID.String())
	}
	return named
}

func TestTheyAreOrderedByPlaceAndThenByWhenTheyWereOpened(t *testing.T) {
	sorted := registry.SortOpenResources([]registry.OpenResource{tab("b", 20, 1), tab("a", 30, 0), tab("d", 15, 1), tab("c", 10, 2)})
	if got := ids(sorted); !equalStrings(got, []string{"a", "d", "b", "c"}) {
		t.Errorf("sorted: %v", got)
	}
}

func TestOnlyAResourceTheKnowledgeBaseSaysIsGoneIsDropped(t *testing.T) {
	checks := map[string]registry.TabCheck{
		"gone":    {Verdict: registry.TabGone},
		"found":   {Verdict: registry.TabReady, Name: "Its name now"},
		"unknown": {Verdict: registry.TabUnknown},
	}
	byID := map[api.ResourceId]registry.TabCheck{}
	for named, check := range checks {
		byID[id(named)] = check
	}
	kept := registry.ApplyTabChecks([]registry.OpenResource{tab("gone", 1, 0), tab("found", 2, 1), tab("unknown", 3, 2), tab("opened-meanwhile", 4, 3)}, byID)
	if got := ids(kept); !equalStrings(got, []string{"found", "unknown", "opened-meanwhile"}) {
		t.Fatalf("kept: %v", got)
	}
	if kept[0].Name != "Its name now" {
		t.Errorf("what was found is named %q", kept[0].Name)
	}
	// A check that states no media type leaves the one it had.
	if kept[0].MediaType != "text/plain" {
		t.Errorf("what was found has the media type %q", kept[0].MediaType)
	}
	if kept[1].Name != "name of unknown" {
		t.Errorf("what is unknown is named %q", kept[1].Name)
	}
}
