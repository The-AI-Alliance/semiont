package registry

// One open resource of a knowledge base (a tab, where there are tabs), and
// what is a function of a list of them and nothing else: their order, and
// what checking them against their knowledge base keeps and drops.

import (
	"cmp"
	"slices"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
)

// OpenResource is one resource open in a knowledge base.
type OpenResource struct {
	ID   api.ResourceId `json:"id"`
	Name string         `json:"name"`
	// OpenedAt is when it was opened, in milliseconds since the epoch.
	OpenedAt int64 `json:"openedAt"`
	// Order is its place among the others.
	Order int `json:"order"`
	// MediaType is "" when none is known.
	MediaType string `json:"mediaType,omitempty"`
	// StorageURI is where it is in the working tree, such as
	// file://docs/overview.md; "" when that is not known.
	StorageURI string `json:"storageUri,omitempty"`
}

// TabVerdict is what checking one open resource against its knowledge base
// concluded.
type TabVerdict string

const (
	// TabGone: the knowledge base said the resource does not exist.
	TabGone TabVerdict = "gone"
	// TabReady: the knowledge base has it, and said what it is.
	TabReady TabVerdict = "ready"
	// TabUnknown: the check failed some other way.
	TabUnknown TabVerdict = "unknown"
)

// TabCheck is one open resource's verdict.
//
// TabGone is the only verdict that removes, and it means the knowledge base
// said the resource does not exist, not that the check failed. A transport
// failure, a timeout and a peer that is down are all TabUnknown, and an
// unknown resource stays open: closing everything because a service was
// briefly down would be worse than the stale entries this removes.
type TabCheck struct {
	Verdict TabVerdict
	// Name and MediaType are what the knowledge base said of a resource it
	// has, a TabReady's alone. MediaType is "" when it said none.
	Name      string
	MediaType string
}

// ApplyTabChecks applies each verdict to list: it drops what is gone, takes
// the name and media type of what was found, and leaves everything else as it
// was. One with no verdict is left: it was opened while the checks were in
// flight.
func ApplyTabChecks(list []OpenResource, checks map[api.ResourceId]TabCheck) []OpenResource {
	kept := []OpenResource{}
	for _, tab := range list {
		check, checked := checks[tab.ID]
		switch {
		case checked && check.Verdict == TabGone:
			continue
		case checked && check.Verdict == TabReady:
			tab.Name = check.Name
			if check.MediaType != "" {
				tab.MediaType = check.MediaType
			}
		}
		kept = append(kept, tab)
	}
	return kept
}

// SortOpenResources is resources by the place each has, and among those
// given the same place, by when each was opened.
func SortOpenResources(resources []OpenResource) []OpenResource {
	sorted := slices.Clone(resources)
	slices.SortStableFunc(sorted, func(a, b OpenResource) int {
		return cmp.Or(cmp.Compare(a.Order, b.Order), cmp.Compare(a.OpenedAt, b.OpenedAt))
	})
	return sorted
}
