package semiont

// System: what the knowledge base says about itself.

import (
	"context"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
)

// SystemNamespace is what the knowledge base says about itself.
type SystemNamespace struct {
	gateway GatewayOperations
}

// HealthCheck is whether the gateway is up: its report of itself. A report
// this client does not read is a failure saying so, as any answer it does
// not read is.
func (n *SystemNamespace) HealthCheck(ctx context.Context) (api.HealthResponse, error) {
	report, ok, err := n.gateway.HealthCheck(ctx)
	if err != nil {
		return api.HealthResponse{}, err
	}
	if !ok {
		return api.HealthResponse{}, transportErrorWithoutResponse("the gateway answered its health check with a report this client does not read", TransportErrorCodeError)
	}
	return report, nil
}

// Status is the gateway's status: its version, and what it is connected to.
func (n *SystemNamespace) Status(ctx context.Context) (api.StatusResponse, error) {
	return n.gateway.GetStatus(ctx)
}
