package readme

import (
	"context"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
)

// Summarize ingests a paper, has a model mark the concepts it mentions,
// gathers the context around it, and generates a summary grounded in it. ok
// is false when the job declined, and made nothing.
func Summarize(ctx context.Context, client *semiont.Client, paper []byte) (summary api.ResourceId, ok bool, err error) {
	// Ingest: the paper's bytes become a resource.
	created, err := client.Yield.Resource(ctx, semiont.PutBinaryRequest{
		Name:       "Attention Is All You Need",
		Bytes:      paper,
		Format:     "application/pdf",
		StorageURI: "file://papers/attention-is-all-you-need.pdf",
	}).Wait(ctx)
	if err != nil {
		return api.ResourceId{}, false, err
	}
	paperID := created.ResourceId

	// Annotate: a model reads it and marks each mention of a concept.
	var linking api.MarkJobParams
	if err := linking.FromLinkingJobParams(api.LinkingJobParams{Motivation: api.LinkingJobParamsMotivationLinking, EntityTypes: []string{"Concept"}}); err != nil {
		return api.ResourceId{}, false, err
	}
	if _, err := client.Mark.Delegate(paperID, linking).Wait(ctx); err != nil {
		return api.ResourceId{}, false, err
	}

	// Gather: the paper, its annotations, and what the knowledge base holds around it.
	gathered, err := client.Gather.Resource(ctx, paperID, api.GatherResourceRequestOptions{})
	if err != nil {
		return api.ResourceId{}, false, err
	}

	// Generate: a new resource, grounded in that context and linked to its source.
	task := "summary"
	done, err := client.Yield.Delegate(api.GenerationJobParams{
		Title:      "Attention Is All You Need: a summary",
		StorageUri: "file://generated/attention-summary.md",
		Context:    gathered,
		Task:       &task,
	}, 0).Wait(ctx)
	if err != nil {
		return api.ResourceId{}, false, err
	}
	// What a yield job reports is the resource it made. One that could not read what it was given declines, and makes nothing.
	if done.Result == nil {
		return api.ResourceId{}, false, nil
	}
	if declined, err := done.Result.AsJobDeclined(); err == nil && declined.Declined == api.JobDeclinedDeclinedTrue {
		return api.ResourceId{}, false, nil
	}
	made, err := done.Result.AsYieldJobDone()
	return made.ResourceId, err == nil, err
}
