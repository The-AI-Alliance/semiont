package semiont

// Frame: the knowledge base's vocabulary. Each write is confirmed: it returns
// when the knowledge base says it is recorded, and fails with the failure it
// answered.

import (
	"context"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

// FrameNamespace is the vocabulary: what kinds of things exist.
type FrameNamespace struct {
	links *links
}

// AddEntityType adds one entity type. Adding one that is there already
// changes nothing.
func (n *FrameNamespace) AddEntityType(ctx context.Context, entityType string) error {
	_, err := ask(ctx, n.links, bus.FrameAddEntityType, api.FrameAddEntityTypeCommand{Tag: entityType})
	return err
}

// AddEntityTypes adds several, one request each, in order. The first that
// fails ends it.
func (n *FrameNamespace) AddEntityTypes(ctx context.Context, entityTypes []string) error {
	for _, entityType := range entityTypes {
		if err := n.AddEntityType(ctx, entityType); err != nil {
			return err
		}
	}
	return nil
}

// AddTagSchema registers a tag schema. The last registration under an id is
// the one that stands.
func (n *FrameNamespace) AddTagSchema(ctx context.Context, schema api.TagSchema) error {
	_, err := ask(ctx, n.links, bus.FrameAddTagSchema, api.FrameAddTagSchemaCommand{Schema: schema})
	return err
}
