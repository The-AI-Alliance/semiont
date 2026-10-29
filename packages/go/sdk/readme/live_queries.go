package readme

import (
	"context"
	"fmt"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// Watch shows a resource's annotations as they change, until ctx is done.
func Watch(ctx context.Context, client *semiont.Client, resource api.ResourceId) {
	for state := range client.Browse.Annotations(resource).States(ctx) { // holds the resource's scope
		switch state := state.(type) {
		case semiont.Pending:
			fmt.Println("asking")
		case semiont.Ready[[]api.Annotation]:
			fmt.Println(len(state.Value), "annotations")
		case semiont.Failed: // a state, not the end: the query lives on
			fmt.Println("failed:", state.Err)
		}
	}
}
