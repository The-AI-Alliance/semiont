package semionttest

// A semiont.GatewayOperations for tests that answers only what it was told
// to.
//
// An operation nobody scripted is refused, naming it: a double that answered
// it with a value of its own making would hand its caller a success nobody
// decided on. Every call is recorded, answered or not.

import (
	"context"
	"fmt"
	"slices"
	"sync"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
)

// GatewayCall is one call of the gateway's own operations: its operation, as
// the surface table names it (getCurrentUser, getMediaToken,
// getProtectedResourceMetadata, healthCheck, getStatus), and the resource it
// was called for, if any.
type GatewayCall struct {
	Operation string
	Resource  api.ResourceId
}

// StubGateway is a gateway that answers only what it was told to (see the
// file's documentation). Its zero value has been told nothing.
type StubGateway struct {
	mu                        sync.Mutex
	currentUser               *api.UserResponse
	mediaToken                *api.MediaTokenResponse
	protectedResourceMetadata *api.ProtectedResourceMetadata
	health                    *api.HealthResponse
	status                    *api.StatusResponse
	calls                     []GatewayCall
}

var _ semiont.GatewayOperations = (*StubGateway)(nil)

// ── What a test says ────────────────────────────────────────────────────

// CurrentUser is what GetCurrentUser answers.
func (g *StubGateway) CurrentUser(answer api.UserResponse) {
	g.script(func() { g.currentUser = &answer })
}

// MediaToken is what GetMediaToken answers, of any resource.
func (g *StubGateway) MediaToken(answer api.MediaTokenResponse) {
	g.script(func() { g.mediaToken = &answer })
}

// ProtectedResourceMetadata is what GetProtectedResourceMetadata answers.
func (g *StubGateway) ProtectedResourceMetadata(answer api.ProtectedResourceMetadata) {
	g.script(func() { g.protectedResourceMetadata = &answer })
}

// Health is what HealthCheck answers.
func (g *StubGateway) Health(answer api.HealthResponse) { g.script(func() { g.health = &answer }) }

// Status is what GetStatus answers.
func (g *StubGateway) Status(answer api.StatusResponse) { g.script(func() { g.status = &answer }) }

func (g *StubGateway) script(say func()) {
	g.mu.Lock()
	defer g.mu.Unlock()
	say()
}

// Calls is every operation called, in order.
func (g *StubGateway) Calls() []GatewayCall {
	g.mu.Lock()
	defer g.mu.Unlock()
	return slices.Clone(g.calls)
}

// answered records a call and gives what was scripted for it, refusing one
// nobody scripted.
func answered[T any](g *StubGateway, call GatewayCall, scripted func() *T) (T, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.calls = append(g.calls, call)
	answer := scripted()
	if answer == nil {
		var none T
		return none, &semiont.TransportError{Code: semiont.TransportErrorCodeError, Message: fmt.Sprintf("StubGateway: not scripted: %s", call.Operation)}
	}
	return *answer, nil
}

// ── The gateway's own operations ────────────────────────────────────────

func (g *StubGateway) GetCurrentUser(context.Context) (api.UserResponse, error) {
	return answered(g, GatewayCall{Operation: "getCurrentUser"}, func() *api.UserResponse { return g.currentUser })
}

func (g *StubGateway) GetMediaToken(_ context.Context, resource api.ResourceId) (api.MediaTokenResponse, error) {
	return answered(g, GatewayCall{Operation: "getMediaToken", Resource: resource}, func() *api.MediaTokenResponse { return g.mediaToken })
}

func (g *StubGateway) GetProtectedResourceMetadata(context.Context) (api.ProtectedResourceMetadata, error) {
	return answered(g, GatewayCall{Operation: "getProtectedResourceMetadata"}, func() *api.ProtectedResourceMetadata { return g.protectedResourceMetadata })
}

func (g *StubGateway) HealthCheck(context.Context) (api.HealthResponse, bool, error) {
	report, err := answered(g, GatewayCall{Operation: "healthCheck"}, func() *api.HealthResponse { return g.health })
	return report, err == nil, err
}

func (g *StubGateway) GetStatus(context.Context) (api.StatusResponse, error) {
	return answered(g, GatewayCall{Operation: "getStatus"}, func() *api.StatusResponse { return g.status })
}
