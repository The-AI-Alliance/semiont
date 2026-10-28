package readme

import (
	"context"
	"fmt"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/state"
)

// ShowHover shows what is hovered as it changes.
func ShowHover(ctx context.Context, beckon *state.BeckonStateUnit) {
	// What it holds now, then each change, until the unit is closed.
	for hovered := range beckon.HoveredAnnotationId().Changes(ctx) {
		if hovered.IsZero() {
			fmt.Println("nothing hovered")
		} else {
			fmt.Println("hovering", hovered)
		}
	}
}
