package semionttest

// A semiont.ContentTransport with no wire, for tests.
//
// It keeps what PutBinary receives and gives it back to a read, and records
// every call made of it. A read of a resource nobody stored fails as
// not-found, as a gateway's would, so a test that forgot to seed its content
// fails where it forgot rather than on bytes the double made up. A read of an
// anchored text nobody seeded fails the same way, though a gateway would
// answer `unknown`: an answer is a test's to give.

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"slices"
	"sync"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// ContentCall is one call made of the content transport: its operation, as
// the surface table names it (putBinary, getBinary, getBinaryStream,
// getResourceGraph, getAnnotations, getAnchoredText), and what it was given.
type ContentCall struct {
	Operation string
	// Resource is the resource a read names; the zero ResourceId for an
	// upload.
	Resource api.ResourceId
	// Put is what an upload was given; nil for a read.
	Put *semiont.PutBinaryRequest
}

// InMemoryContent is a content transport that keeps what it is given (see the
// file's documentation).
type InMemoryContent struct {
	mu          sync.Mutex
	stored      map[api.ResourceId]semiont.Content
	graphs      map[api.ResourceId]api.GetResourceResponse
	annotations map[api.ResourceId]api.GetAnnotationsResponse
	anchored    map[api.ResourceId]api.AnchoredTextAnswer
	calls       []ContentCall
}

var _ semiont.ContentTransport = (*InMemoryContent)(nil)

// NewInMemoryContent is an InMemoryContent holding nothing.
func NewInMemoryContent() *InMemoryContent {
	return &InMemoryContent{
		stored:      map[api.ResourceId]semiont.Content{},
		graphs:      map[api.ResourceId]api.GetResourceResponse{},
		annotations: map[api.ResourceId]api.GetAnnotationsResponse{},
		anchored:    map[api.ResourceId]api.AnchoredTextAnswer{},
	}
}

// Seed stores content as the bytes of resource.
func (c *InMemoryContent) Seed(resource api.ResourceId, content semiont.Content) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.stored[resource] = content
}

// SeedGraph stores graph as the description of resource.
func (c *InMemoryContent) SeedGraph(resource api.ResourceId, graph api.GetResourceResponse) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.graphs[resource] = graph
}

// SeedAnnotations stores annotations as the annotations of resource.
func (c *InMemoryContent) SeedAnnotations(resource api.ResourceId, annotations api.GetAnnotationsResponse) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.annotations[resource] = annotations
}

// SeedAnchoredText stores answer as what a read of resource's anchored text
// is answered.
func (c *InMemoryContent) SeedAnchoredText(resource api.ResourceId, answer api.AnchoredTextAnswer) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.anchored[resource] = answer
}

// Calls is every call made, in order.
func (c *InMemoryContent) Calls() []ContentCall {
	c.mu.Lock()
	defer c.mu.Unlock()
	return slices.Clone(c.calls)
}

func (c *InMemoryContent) record(call ContentCall) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls = append(c.calls, call)
}

// notFound is the refusal of a read of what nobody stored.
func notFound(what string, resource api.ResourceId) error {
	return &semiont.TransportError{Code: semiont.TransportErrorCodeNotFound, Message: fmt.Sprintf("InMemoryContent: no %s stored for %s", what, resource)}
}

// read is what is stored in held for resource, or not found as what.
func read[T any](c *InMemoryContent, held map[api.ResourceId]T, what string, resource api.ResourceId) (T, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	value, ok := held[resource]
	if !ok {
		var none T
		return none, notFound(what, resource)
	}
	return value, nil
}

// PutBinary stores the bytes under an id of this double's making,
// test-content-<n>.
func (c *InMemoryContent) PutBinary(_ context.Context, request semiont.PutBinaryRequest) *semiont.Upload {
	return semiont.NewUpload(func(report func(semiont.UploadProgress)) (api.CreateResourceResponse, error) {
		c.mu.Lock()
		resource, err := api.ParseResourceId(fmt.Sprintf("test-content-%d", len(c.stored)+1))
		if err != nil {
			c.mu.Unlock()
			return api.CreateResourceResponse{}, err
		}
		c.stored[resource] = semiont.Content{Bytes: request.Bytes, ContentType: request.Format}
		c.calls = append(c.calls, ContentCall{Operation: "putBinary", Put: &request})
		c.mu.Unlock()
		size := int64(len(request.Bytes))
		report(semiont.UploadProgress{BytesUploaded: size, TotalBytes: size})
		return api.CreateResourceResponse{ResourceId: resource}, nil
	})
}

func (c *InMemoryContent) GetBinary(_ context.Context, resource api.ResourceId) (semiont.Content, error) {
	c.record(ContentCall{Operation: "getBinary", Resource: resource})
	return read(c, c.stored, "content", resource)
}

func (c *InMemoryContent) GetBinaryStream(_ context.Context, resource api.ResourceId) (semiont.ContentStream, error) {
	c.record(ContentCall{Operation: "getBinaryStream", Resource: resource})
	content, err := read(c, c.stored, "content", resource)
	if err != nil {
		return semiont.ContentStream{}, err
	}
	return semiont.ContentStream{Bytes: io.NopCloser(bytes.NewReader(content.Bytes)), ContentType: content.ContentType}, nil
}

func (c *InMemoryContent) GetResourceGraph(_ context.Context, resource api.ResourceId) (api.GetResourceResponse, error) {
	c.record(ContentCall{Operation: "getResourceGraph", Resource: resource})
	return read(c, c.graphs, "description", resource)
}

func (c *InMemoryContent) GetAnnotations(_ context.Context, resource api.ResourceId) (api.GetAnnotationsResponse, error) {
	c.record(ContentCall{Operation: "getAnnotations", Resource: resource})
	return read(c, c.annotations, "annotations", resource)
}

func (c *InMemoryContent) GetAnchoredText(_ context.Context, resource api.ResourceId) (api.AnchoredTextAnswer, error) {
	c.record(ContentCall{Operation: "getAnchoredText", Resource: resource})
	return read(c, c.anchored, "anchored text", resource)
}
