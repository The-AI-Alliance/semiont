package semiont

// Yield: creating resources, by upload, by a generation delegated as a job,
// and by cloning.

import (
	"context"
	"encoding/json"
	"math"
	"time"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/mediatypes"
)

// generationStallDeadline is how long a followed generation may say nothing
// before its follower gives up on it: a floor, and a wait that grows with
// the length asked for. A generation says nothing while its model writes, so
// the silence it is allowed depends on how much it was asked to write.
func generationStallDeadline(timing Timing, maxTokens *float64) time.Duration {
	tokens := float64(timing.GenerationStallAssumedTokensCount)
	if maxTokens != nil {
		tokens = math.Max(*maxTokens, 0)
	}
	// Rounded to the millisecond, as every SDK states the wait.
	grown := time.Duration(math.Round(float64(timing.GenerationStallPerToken.Milliseconds())*tokens)) * time.Millisecond
	return max(timing.GenerationStallFloor, grown)
}

// CreateFromTokenOptions is a clone to create: the token its source was
// shared under, the clone's name and its text, and whether the source is
// archived once the clone exists (nil: it is not).
type CreateFromTokenOptions struct {
	Token           string
	Name            string
	Content         string
	ArchiveOriginal *bool
}

// YieldNamespace is creating resources.
type YieldNamespace struct {
	links   *links
	content ContentTransport
}

// Resource uploads bytes as a new resource: the upload's progress, and the
// resource created.
func (n *YieldNamespace) Resource(ctx context.Context, data PutBinaryRequest) *Upload {
	return n.content.PutBinary(ctx, data)
}

// Delegate delegates the making of a resource from a gathered context, as a
// yield job: its progress and its completion. The context's focus says what
// the job is about, so the job names no resource. A follower that hears
// nothing for stallDeadline asks for that job to be cancelled and ends as
// stalled; when stallDeadline is zero, for a deadline that grows with
// params.MaxTokens from the client's timing.
func (n *YieldNamespace) Delegate(params api.GenerationJobParams, stallDeadline time.Duration) *Delegation[api.YieldJobCompleteCommand] {
	about, err := focusOf(params.Context)
	if err != nil {
		return refused[api.YieldJobCompleteCommand](n.links, err)
	}
	within := stallDeadline
	if within == 0 {
		within = generationStallDeadline(n.links.timing, params.MaxTokens)
	}
	var create api.JobCreateCommand
	if err := create.FromYieldJobCreateCommand(api.YieldJobCreateCommand{JobType: api.YieldJobCreateCommandJobTypeYield, Params: params}); err != nil {
		return refused[api.YieldJobCompleteCommand](n.links, err)
	}
	return follow[api.YieldJobCompleteCommand](n.links, create, api.JobTypeYield, about, &within)
}

// focusOf is the resource a gathered context is about: the resource it was
// gathered for, or the one holding the annotation it was gathered for.
func focusOf(gathered api.GatheredContext) (api.ResourceId, error) {
	focus, err := gathered.Focus.MarshalJSON()
	if err != nil {
		return api.ResourceId{}, err
	}
	var named struct {
		Kind           string                  `json:"kind"`
		Resource       *api.ResourceDescriptor `json:"resource"`
		SourceResource *api.ResourceDescriptor `json:"sourceResource"`
	}
	if err := json.Unmarshal(focus, &named); err != nil {
		return api.ResourceId{}, err
	}
	switch {
	case named.Kind == string(api.GatheredContextFocus1KindResource) && named.Resource != nil:
		return named.Resource.Id, nil
	case named.Kind == string(api.GatheredContextFocus0KindAnnotation) && named.SourceResource != nil:
		return named.SourceResource.Id, nil
	}
	return api.ResourceId{}, transportErrorWithoutResponse("a gathered context whose focus names no resource", TransportErrorCodeError)
}

// CloneToken is a token another resource can be created from: a clone of
// this one.
func (n *YieldNamespace) CloneToken(ctx context.Context, resourceID api.ResourceId) (api.CloneResourceWithTokenResponse, error) {
	answer, err := ask(ctx, n.links, bus.YieldCloneTokenRequested, api.YieldCloneTokenRequest{ResourceId: resourceID})
	return answer.Response, err
}

// FromToken is the resource a clone token was made from.
func (n *YieldNamespace) FromToken(ctx context.Context, token string) (api.ResourceDescriptor, error) {
	answer, err := ask(ctx, n.links, bus.YieldCloneResourceRequested, api.YieldCloneResourceRequest{Token: token})
	return answer.Response.SourceResource, err
}

// CreateFromToken creates a resource as a clone of the one options.Token was
// made from. The source is read first. The clone's content then goes by the
// upload path, in the format its source's allows (mediatypes.CloneFormat)
// and under a name made from its own.
func (n *YieldNamespace) CreateFromToken(ctx context.Context, options CreateFromTokenOptions) (api.CreateResourceResponse, error) {
	source, err := n.FromToken(ctx, options.Token)
	if err != nil {
		return api.CreateResourceResponse{}, err
	}
	primary, ok, err := PrimaryMediaType(source)
	if err != nil {
		return api.CreateResourceResponse{}, err
	}
	format := mediatypes.CloneFormat("")
	if ok {
		format = mediatypes.CloneFormat(primary)
	}
	return n.content.PutBinary(ctx, PutBinaryRequest{
		Name:            options.Name,
		Bytes:           []byte(options.Content),
		Format:          format.MediaType,
		StorageURI:      mediatypes.StorageURI(options.Name, format),
		CloneToken:      options.Token,
		ArchiveOriginal: options.ArchiveOriginal,
	}).Wait(ctx)
}

// Clone signals that a clone of the open resource is wanted.
func (n *YieldNamespace) Clone() {
	signal(n.links, bus.YieldClone, bus.Empty{}, Envelope{})
}
