package semiont

// health.go — the backend's liveness surface, stated as an interface.
//
// It exists for the same reason `bus.Transport` does: a caller should be able
// to ask "is the backend up?" without owning how that question travels. The
// launcher previously answered it with a bare `http.Client` and a hand-written
// `/api/health` path — the one application request it still made to the
// backend without going through this SDK.
//
// The TypeScript side declares the same operation on `IBackendOperations`
// (packages/core/src/transport.ts), NOT on `ITransport`: health is a backend
// operation, not a bus primitive, and it is grouped there under "System"
// alongside `getStatus`. This file is its Go counterpart, and it stays out of
// package `bus` for exactly that reason.
//
// The route and the response shape come from the GENERATED client, so they
// track openapi.json rather than a string in this file.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
)

// Health is what a caller needs to know whether the backend is serving.
type Health interface {
	// HealthCheck asks the backend to report itself.
	//
	// A nil error means it ANSWERED with a success status. The returned
	// report may still be nil in that case: a 2xx whose body does not parse
	// is a live service behind a schema this client does not recognise, and
	// calling that "down" would take a backend offline over a field rename.
	// Liveness is the status code; the body is detail.
	//
	// There is no bool: it would collapse "answered, unhealthy" into
	// "unreachable", and a supervisor deciding whether to wait, warn, or
	// abort needs those apart. Callers that genuinely only want liveness
	// compare the error against nil.
	//
	// Cancellation and timeouts belong to ctx — this method imposes none of
	// its own, so a probe with a budget sets a deadline and a boot-time wait
	// can use a longer one.
	HealthCheck(ctx context.Context) (*HealthResponse, error)
}

// HealthClient is the HTTP implementation, over the generated client.
type HealthClient struct {
	c *ClientWithResponses
}

// Asserted at compile time so a signature change on either side is a build
// failure rather than a runtime surprise.
var _ Health = (*HealthClient)(nil)

// NewHealthClient builds a Health against a backend ORIGIN — "http://host:port",
// never a path. The route is the generated client's to know.
//
// opts pass through to the generated constructor, so a caller can inject its
// own HTTP doer; without one, cancel through ctx.
func NewHealthClient(base string, opts ...ClientOption) (*HealthClient, error) {
	c, err := NewClientWithResponses(base, opts...)
	if err != nil {
		return nil, err
	}
	return &HealthClient{c: c}, nil
}

func (h *HealthClient) HealthCheck(ctx context.Context) (*HealthResponse, error) {
	// The RAW call, not GetApiHealthWithResponse: that wrapper decodes before
	// it reports, so a 2xx with an unrecognised body comes back as an error
	// and a live backend reads as down. Status first, body second — which is
	// the order a liveness check has to ask them in.
	resp, err := h.c.GetApiHealth(ctx)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, fmt.Errorf("backend health: %s", resp.Status)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		// Headers arrived, the body did not. The service answered, so this is
		// not a health failure — report it alive with no detail.
		return nil, nil
	}
	var out HealthResponse
	if json.Unmarshal(body, &out) != nil {
		return nil, nil
	}
	return &out, nil
}
