package semiont

// What a completed sign-in learns: who the knowledge base at the address
// says it is. It describes itself only to a caller that is signed in, so this
// is asked after the sign-in, and never assumed from the address a person
// typed or the row they clicked.

import (
	"context"
	"errors"
	"net/http"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
)

// ConnectionIdentity is who the knowledge base at an address says it is.
type ConnectionIdentity struct {
	Did         api.UserId
	Description api.KbDescription
}

// DescribeConnection asks the knowledge base at target what it is, with a
// token just issued. The failure is an *IdentityUnverifiableError: the
// knowledge base was not reached, or it answered that it cannot say what it
// is.
func DescribeConnection(ctx context.Context, target api.HttpEndpoint, access string, client *http.Client, timing Timing) (ConnectionIdentity, error) {
	baseURL, err := GatewayURL(target)
	if err != nil {
		return ConnectionIdentity{}, &IdentityUnverifiableError{Reason: IdentityUnverifiableReasonUnreachable, Detail: err.Error()}
	}
	// A client of this one operation: it hears its replies and nothing else.
	transport := NewHTTPTransport(HTTPTransportConfig{
		BaseURL:  baseURL,
		Token:    NewVariable(access),
		Channels: bus.ReplyChannelsFor(bus.BrowseKbRequested.Request().Channel()),
		HTTP:     client,
		Timing:   timing,
	})
	asking := NewClient(ClientConfig{Transport: transport, Content: NewHTTPContentTransport(transport), Gateway: transport, Timing: timing})
	description, err := asking.Browse.Kb(ctx)
	asking.Close()
	transport.Close()
	if err != nil {
		// A refusal is the knowledge base answering that it cannot say what
		// it is. Anything else is not having reached it.
		var refusal *BusRequestError
		if errors.As(err, &refusal) && refusal.Code == BusRequestErrorCodeRejected {
			return ConnectionIdentity{}, &IdentityUnverifiableError{Reason: IdentityUnverifiableReasonNotReported, Detail: refusal.Error()}
		}
		return ConnectionIdentity{}, &IdentityUnverifiableError{Reason: IdentityUnverifiableReasonUnreachable, Detail: err.Error()}
	}
	did, err := KbDid(description.Domain)
	if err != nil {
		// A domain no DID can hold says nothing of who this is.
		return ConnectionIdentity{}, &IdentityUnverifiableError{Reason: IdentityUnverifiableReasonNotReported, Detail: err.Error()}
	}
	return ConnectionIdentity{Did: did, Description: description}, nil
}
