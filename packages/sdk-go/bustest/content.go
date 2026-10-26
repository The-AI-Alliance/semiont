package bustest

// RecordingContent and RecordingGateway: a content transport and a gateway
// that keep nothing and record every call, in order, as the surface table
// names it.

import (
	"context"
	"fmt"
	"sync"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
)

// ContentCall is one call of a content transport: its operation, as the
// surface table names it (putBinary, getBinary, getBinaryStream,
// getResourceGraph, getAnnotations, getAnchoredText), and what it was given.
type ContentCall struct {
	Operation string
	// Resource is the resource a read names; the zero ResourceId for an
	// upload.
	Resource api.ResourceId
	// Put is what an upload was given; nil for a read.
	Put *semiont.PutBinaryRequest
}

// RecordingContent is a content transport that keeps nothing: every read is
// refused as not found, and every upload as refused, once recorded.
type RecordingContent struct {
	mu    sync.Mutex
	calls []ContentCall
}

var _ semiont.ContentTransport = (*RecordingContent)(nil)

// Calls is every call so far, in order.
func (c *RecordingContent) Calls() []ContentCall {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]ContentCall(nil), c.calls...)
}

func (c *RecordingContent) record(call ContentCall) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls = append(c.calls, call)
}

// nothing is the refusal of a read of what is kept nowhere.
func nothing(operation string, resource api.ResourceId) error {
	return &semiont.TransportError{Code: semiont.TransportErrorCodeNotFound, Message: fmt.Sprintf("bustest.RecordingContent keeps nothing: %s of %s", operation, resource)}
}

func (c *RecordingContent) PutBinary(_ context.Context, request semiont.PutBinaryRequest) *semiont.Upload {
	c.record(ContentCall{Operation: "putBinary", Put: &request})
	return semiont.NewUpload(func(func(semiont.UploadProgress)) (api.CreateResourceResponse, error) {
		return api.CreateResourceResponse{}, &semiont.TransportError{Code: semiont.TransportErrorCodeError, Message: "bustest.RecordingContent keeps nothing: putBinary"}
	})
}

func (c *RecordingContent) GetBinary(_ context.Context, resource api.ResourceId) (semiont.Content, error) {
	c.record(ContentCall{Operation: "getBinary", Resource: resource})
	return semiont.Content{}, nothing("getBinary", resource)
}

func (c *RecordingContent) GetBinaryStream(_ context.Context, resource api.ResourceId) (semiont.ContentStream, error) {
	c.record(ContentCall{Operation: "getBinaryStream", Resource: resource})
	return semiont.ContentStream{}, nothing("getBinaryStream", resource)
}

func (c *RecordingContent) GetResourceGraph(_ context.Context, resource api.ResourceId) (api.GetResourceResponse, error) {
	c.record(ContentCall{Operation: "getResourceGraph", Resource: resource})
	return api.GetResourceResponse{}, nothing("getResourceGraph", resource)
}

func (c *RecordingContent) GetAnnotations(_ context.Context, resource api.ResourceId) (api.GetAnnotationsResponse, error) {
	c.record(ContentCall{Operation: "getAnnotations", Resource: resource})
	return api.GetAnnotationsResponse{}, nothing("getAnnotations", resource)
}

func (c *RecordingContent) GetAnchoredText(_ context.Context, resource api.ResourceId) (api.AnchoredTextAnswer, error) {
	c.record(ContentCall{Operation: "getAnchoredText", Resource: resource})
	return api.AnchoredTextAnswer{}, nothing("getAnchoredText", resource)
}

// GatewayCall is one call of a gateway's own operations: its operation, as
// the surface table names it (getCurrentUser, getMediaToken,
// getProtectedResourceMetadata, healthCheck, getStatus), and the resource it
// names, if any.
type GatewayCall struct {
	Operation string
	Resource  api.ResourceId
}

// RecordingGateway is a gateway that answers nothing: every call is refused
// as unavailable, once recorded.
type RecordingGateway struct {
	mu    sync.Mutex
	calls []GatewayCall
}

var _ semiont.GatewayOperations = (*RecordingGateway)(nil)

// Calls is every call so far, in order.
func (g *RecordingGateway) Calls() []GatewayCall {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]GatewayCall(nil), g.calls...)
}

func (g *RecordingGateway) refuse(call GatewayCall) error {
	g.mu.Lock()
	g.calls = append(g.calls, call)
	g.mu.Unlock()
	return &semiont.TransportError{Code: semiont.TransportErrorCodeUnavailable, Message: fmt.Sprintf("bustest.RecordingGateway answers nothing: %s", call.Operation)}
}

func (g *RecordingGateway) GetCurrentUser(context.Context) (api.UserResponse, error) {
	return api.UserResponse{}, g.refuse(GatewayCall{Operation: "getCurrentUser"})
}

func (g *RecordingGateway) GetMediaToken(_ context.Context, resource api.ResourceId) (api.MediaTokenResponse, error) {
	return api.MediaTokenResponse{}, g.refuse(GatewayCall{Operation: "getMediaToken", Resource: resource})
}

func (g *RecordingGateway) GetProtectedResourceMetadata(context.Context) (api.ProtectedResourceMetadata, error) {
	return api.ProtectedResourceMetadata{}, g.refuse(GatewayCall{Operation: "getProtectedResourceMetadata"})
}

func (g *RecordingGateway) HealthCheck(context.Context) (api.HealthResponse, bool, error) {
	return api.HealthResponse{}, false, g.refuse(GatewayCall{Operation: "healthCheck"})
}

func (g *RecordingGateway) GetStatus(context.Context) (api.StatusResponse, error) {
	return api.StatusResponse{}, g.refuse(GatewayCall{Operation: "getStatus"})
}
