package semiont

// Auth: the gateway's view of who is signed in.

import (
	"context"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
)

// AuthNamespace is the gateway's view of who is signed in.
type AuthNamespace struct {
	gateway GatewayOperations
}

// Me is who the gateway takes the client's token to be.
func (n *AuthNamespace) Me(ctx context.Context) (api.UserResponse, error) {
	return n.gateway.GetCurrentUser(ctx)
}

// MediaToken is a short-lived token a browser element can fetch a resource's
// bytes with.
func (n *AuthNamespace) MediaToken(ctx context.Context, resourceID api.ResourceId) (api.MediaTokenResponse, error) {
	return n.gateway.GetMediaToken(ctx, resourceID)
}

// ProtectedResourceMetadata is what the gateway says of itself as an OAuth
// protected resource: which issuers it trusts, among it.
func (n *AuthNamespace) ProtectedResourceMetadata(ctx context.Context) (api.ProtectedResourceMetadata, error) {
	return n.gateway.GetProtectedResourceMetadata(ctx)
}
