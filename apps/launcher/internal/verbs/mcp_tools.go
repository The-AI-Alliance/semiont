package verbs

// mcp_tools.go — the work of each of `semiont mcp`'s tools (mcp-tools.json
// names them, and the SDK methods each calls). A tool's arguments are read
// into the SDK's generated types after its input schema has held them, and
// each is passed on as it was given: one the caller left out is left out, and
// the SDK's own rule for it applies, as the client surface states it
// (specs/src/client/surface.json) for every SDK.

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	launcher "github.com/The-AI-Alliance/semiont/apps/launcher/internal/launcher"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
)

// listedKnowledgeBase is one row of knowledge_bases' answer.
type listedKnowledgeBase struct {
	Kb         string `json:"kb"`
	Did        string `json:"did,omitempty"`
	Root       string `json:"root,omitempty"`
	Repo       string `json:"repo,omitempty"`
	SignedInAs string `json:"signedInAs"`
	Renews     bool   `json:"renews"`
	ForwardUp  *bool  `json:"forwardUp,omitempty"`
}

// mcpHandlers: each tool's work, by the tool's name. TestMCPToolsCensus holds
// it to the tools both ways.
var mcpHandlers = map[string]mcpHandler{
	"knowledge_bases": handle(func(_ context.Context, _ mcpCall, _ struct{}) (mcpAnswer, error) {
		known, err := launcher.SignedInKnowledgeBases()
		if err != nil {
			return mcpAnswer{}, err
		}
		rows := make([]listedKnowledgeBase, 0, len(known))
		for _, kb := range known {
			row := listedKnowledgeBase{Kb: kb.Key, Did: kb.Did, Root: kb.Root, Repo: kb.Repo, SignedInAs: kb.SignedInAs, Renews: kb.Renews}
			if kb.Repo != "" {
				up := kb.Forward == nil
				row.ForwardUp = &up
			}
			rows = append(rows, row)
		}
		return mcpAnswer{structured: map[string]any{"knowledgeBases": rows}}, nil
	}),

	"match_resources": handle(func(ctx context.Context, call mcpCall, args struct {
		Search     string  `json:"search"`
		Archived   *bool   `json:"archived"`
		EntityType *string `json:"entityType"`
		Limit      int     `json:"limit"`
		Offset     int     `json:"offset"`
	}) (mcpAnswer, error) {
		found, err := call.client().Match.Resources(args.Search, semiont.ResourceFilters{Limit: args.Limit, Offset: args.Offset, Archived: args.Archived, EntityType: args.EntityType}).Fresh(ctx)
		return mcpAnswer{structured: found}, err
	}),

	"browse_resources": handle(func(ctx context.Context, call mcpCall, args struct {
		Archived   *bool   `json:"archived"`
		EntityType *string `json:"entityType"`
		Limit      int     `json:"limit"`
		Offset     int     `json:"offset"`
	}) (mcpAnswer, error) {
		listed, err := call.client().Browse.Resources(semiont.ResourceFilters{Limit: args.Limit, Offset: args.Offset, Archived: args.Archived, EntityType: args.EntityType}).Fresh(ctx)
		return mcpAnswer{structured: listed}, err
	}),

	"browse_resource": handle(func(ctx context.Context, call mcpCall, args struct {
		ResourceId api.ResourceId `json:"resourceId"`
		WithText   bool           `json:"withText"`
	}) (mcpAnswer, error) {
		c := call.client()
		descriptor, err := c.Browse.Resource(args.ResourceId).Fresh(ctx)
		if err != nil {
			return mcpAnswer{}, err
		}
		answer := map[string]any{"resource": descriptor}
		if args.WithText {
			text, err := c.Browse.ResourceContent(ctx, args.ResourceId)
			if err != nil {
				return mcpAnswer{}, err
			}
			answer["text"] = text
		}
		return mcpAnswer{structured: answer, links: []*mcp.ResourceLink{resourceLink(call.kb, descriptor)}}, nil
	}),

	"browse_annotations": handle(func(ctx context.Context, call mcpCall, args struct {
		ResourceId api.ResourceId `json:"resourceId"`
	}) (mcpAnswer, error) {
		annotations, err := call.client().Browse.Annotations(args.ResourceId).Fresh(ctx)
		return mcpAnswer{structured: map[string]any{"annotations": annotations}}, err
	}),

	"gather_annotation": handle(func(ctx context.Context, call mcpCall, args struct {
		ResourceId   api.ResourceId              `json:"resourceId"`
		AnnotationId api.AnnotationId            `json:"annotationId"`
		Options      api.GatherAnnotationOptions `json:"options"`
	}) (mcpAnswer, error) {
		gathered, err := call.client().Gather.Annotation(args.ResourceId, args.AnnotationId, args.Options).Wait(ctx)
		return mcpAnswer{structured: gathered}, err
	}),

	"gather_resource": handle(func(ctx context.Context, call mcpCall, args struct {
		ResourceId api.ResourceId                    `json:"resourceId"`
		Options    *api.GatherResourceRequestOptions `json:"options"`
	}) (mcpAnswer, error) {
		options := semiont.GatherResourceDefaults()
		if args.Options != nil {
			options = *args.Options
		}
		gathered, err := call.client().Gather.Resource(ctx, args.ResourceId, options)
		return mcpAnswer{structured: map[string]any{"context": gathered}}, err
	}),

	"browse_related": handle(func(ctx context.Context, call mcpCall, args struct {
		ResourceId api.ResourceId `json:"resourceId"`
	}) (mcpAnswer, error) {
		c := call.client()
		graph, err := c.Browse.ResourceGraph(ctx, args.ResourceId)
		if err != nil {
			return mcpAnswer{}, err
		}
		referencedBy, err := c.Gather.ReferencedBy(args.ResourceId).Fresh(ctx)
		return mcpAnswer{structured: map[string]any{"graph": graph, "referencedBy": referencedBy}}, err
	}),

	"mark_annotation": handle(func(ctx context.Context, call mcpCall, args struct {
		Motivation api.Motivation        `json:"motivation"`
		Target     api.AnnotationTarget  `json:"target"`
		Body       *api.AnnotationBodies `json:"body"`
	}) (mcpAnswer, error) {
		created, err := call.client().Mark.Annotation(ctx, api.CreateAnnotationRequest{Motivation: args.Motivation, Target: args.Target, Body: args.Body})
		return mcpAnswer{structured: created}, err
	}),

	"mark_delete": handle(func(ctx context.Context, call mcpCall, args struct {
		ResourceId   api.ResourceId   `json:"resourceId"`
		AnnotationId api.AnnotationId `json:"annotationId"`
	}) (mcpAnswer, error) {
		if err := call.client().Mark.Delete(ctx, args.ResourceId, args.AnnotationId); err != nil {
			return mcpAnswer{}, err
		}
		return mcpAnswer{text: fmt.Sprintf("Deleted annotation %s from resource %s.", args.AnnotationId, args.ResourceId)}, nil
	}),

	"mark_archive": handle(func(ctx context.Context, call mcpCall, args struct {
		ResourceId api.ResourceId `json:"resourceId"`
	}) (mcpAnswer, error) {
		if err := call.client().Mark.Archive(ctx, args.ResourceId); err != nil {
			return mcpAnswer{}, err
		}
		return mcpAnswer{text: fmt.Sprintf("Archived resource %s.", args.ResourceId)}, nil
	}),

	"mark_delegate": handle(func(ctx context.Context, call mcpCall, args struct {
		ResourceId api.ResourceId    `json:"resourceId"`
		Params     api.MarkJobParams `json:"params"`
	}) (mcpAnswer, error) {
		done, err := followDelegation(ctx, call, call.client().Mark.Delegate(args.ResourceId, args.Params))
		return mcpAnswer{structured: done}, err
	}),

	"match_link_targets": handle(func(ctx context.Context, call mcpCall, args struct {
		ResourceId         api.ResourceId              `json:"resourceId"`
		ReferenceId        api.AnnotationId            `json:"referenceId"`
		Gather             api.GatherAnnotationOptions `json:"gather"`
		Limit              int                         `json:"limit"`
		UseSemanticScoring *bool                       `json:"useSemanticScoring"`
	}) (mcpAnswer, error) {
		c := call.client()
		gathered, err := c.Gather.Annotation(args.ResourceId, args.ReferenceId, args.Gather).Wait(ctx)
		if err != nil {
			return mcpAnswer{}, err
		}
		found, err := c.Match.Search(args.ResourceId, args.ReferenceId, gathered.Response, semiont.MatchSearchOptions{Limit: args.Limit, UseSemanticScoring: args.UseSemanticScoring}).Wait(ctx)
		return mcpAnswer{structured: found}, err
	}),

	"bind_link": handle(func(ctx context.Context, call mcpCall, args struct {
		ResourceId   api.ResourceId          `json:"resourceId"`
		AnnotationId api.AnnotationId        `json:"annotationId"`
		Operations   []api.BindBodyOperation `json:"operations"`
	}) (mcpAnswer, error) {
		if err := call.client().Bind.Body(ctx, args.ResourceId, args.AnnotationId, args.Operations); err != nil {
			return mcpAnswer{}, err
		}
		return mcpAnswer{text: fmt.Sprintf("Changed the body of annotation %s on resource %s.", args.AnnotationId, args.ResourceId)}, nil
	}),

	"yield_resource": handle(func(ctx context.Context, call mcpCall, args struct {
		Name       string `json:"name"`
		File       string `json:"file"`
		Format     string `json:"format"`
		StorageUri string `json:"storageUri"`
		Language   string `json:"language"`
	}) (mcpAnswer, error) {
		upload := call.client().Yield.Resource(ctx, semiont.PutBinaryRequest{Name: args.Name, Bytes: []byte(args.File), Format: args.Format, StorageURI: args.StorageUri, Language: args.Language})
		created, err := upload.Wait(ctx)
		return mcpAnswer{structured: map[string]any{"resourceId": created.ResourceId}}, err
	}),

	"yield_generate": handle(func(ctx context.Context, call mcpCall, args struct {
		ResourceId   api.ResourceId              `json:"resourceId"`
		AnnotationId api.AnnotationId            `json:"annotationId"`
		Gather       api.GatherAnnotationOptions `json:"gather"`
		api.GenerationJobRequest
	}) (mcpAnswer, error) {
		c := call.client()
		gathered, err := c.Gather.Annotation(args.ResourceId, args.AnnotationId, args.Gather).Wait(ctx)
		if err != nil {
			return mcpAnswer{}, err
		}
		// A generation job's parameters are what it is asked to make and the
		// context it is made from; the context's focus names the annotation.
		var params api.GenerationJobParams
		asked, err := json.Marshal(args.GenerationJobRequest)
		if err == nil {
			err = json.Unmarshal(asked, &params)
		}
		if err != nil {
			return mcpAnswer{}, err
		}
		params.Context = gathered.Response
		done, err := followDelegation(ctx, call, c.Yield.Delegate(params, 0))
		return mcpAnswer{structured: done}, err
	}),

	"browse_vocabulary": handle(func(ctx context.Context, call mcpCall, _ struct{}) (mcpAnswer, error) {
		c := call.client()
		entityTypes, err := c.Browse.EntityTypes().Fresh(ctx)
		if err != nil {
			return mcpAnswer{}, err
		}
		tagSchemas, err := c.Browse.TagSchemas().Fresh(ctx)
		return mcpAnswer{structured: map[string]any{"entityTypes": entityTypes, "tagSchemas": tagSchemas}}, err
	}),

	"frame_entity_types": handle(func(ctx context.Context, call mcpCall, args struct {
		EntityTypes []string `json:"entityTypes"`
	}) (mcpAnswer, error) {
		if err := call.client().Frame.AddEntityTypes(ctx, args.EntityTypes); err != nil {
			return mcpAnswer{}, err
		}
		return mcpAnswer{text: fmt.Sprintf("Added %s.", plural(len(args.EntityTypes), "entity type"))}, nil
	}),

	"frame_tag_schema": handle(func(ctx context.Context, call mcpCall, args struct {
		Schema api.TagSchema `json:"schema"`
	}) (mcpAnswer, error) {
		if err := call.client().Frame.AddTagSchema(ctx, args.Schema); err != nil {
			return mcpAnswer{}, err
		}
		return mcpAnswer{text: fmt.Sprintf("Added the tag schema %s.", args.Schema.Id)}, nil
	}),

	"job_status": handle(func(ctx context.Context, call mcpCall, args struct {
		JobId api.JobId `json:"jobId"`
	}) (mcpAnswer, error) {
		status, err := callersJob(ctx, call, args.JobId)
		if err != nil {
			return mcpAnswer{}, err
		}
		return jobAnswer(status)
	}),

	"job_cancel": handle(func(ctx context.Context, call mcpCall, args struct {
		JobId api.JobId `json:"jobId"`
	}) (mcpAnswer, error) {
		if _, err := callersJob(ctx, call, args.JobId); err != nil {
			return mcpAnswer{}, err
		}
		cancelled, err := call.client().Job.Cancel(ctx, args.JobId)
		return mcpAnswer{structured: map[string]any{"cancelled": cancelled}}, err
	}),

	"beckon_attention": handle(func(ctx context.Context, call mcpCall, args struct {
		AnnotationId api.AnnotationId `json:"annotationId"`
		ResourceId   api.ResourceId   `json:"resourceId"`
	}) (mcpAnswer, error) {
		reached, counted, err := call.client().Beckon.Attention(ctx, args.ResourceId, args.AnnotationId)
		if err != nil || !counted {
			return mcpAnswer{structured: map[string]any{}}, err
		}
		return mcpAnswer{structured: map[string]any{"reached": reached}}, nil
	}),
}
