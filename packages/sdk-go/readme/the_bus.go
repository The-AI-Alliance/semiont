package readme

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

// Read asks for a resource on the bus, then hears what is added to it.
func Read(ctx context.Context, origin, token string, resource api.ResourceId) error {
	timing := semiont.DefaultTiming()
	transport := semiont.NewHTTPTransport(semiont.HTTPTransportConfig{
		BaseURL: origin, Token: semiont.NewVariable(token), Channels: bus.BridgedChannels, HTTP: http.DefaultClient, Timing: timing,
	})
	defer transport.Close()
	wire := semiont.NewWire(transport)

	reply, err := semiont.Request(ctx, wire, bus.BrowseResourceRequested, api.BrowseResourceRequest{ResourceId: resource}, timing.BusRequestTimeout)
	var refused *semiont.BusRequestError
	if errors.As(err, &refused) {
		fmt.Println(refused.Code) // "bus.not-found", "bus.timeout", …: a closed vocabulary
		return nil
	}
	if err != nil {
		return err
	}
	fmt.Println(reply.Response.Resource.Name)

	// A resource's channel is read for the resource: the read holds its scope, and lets go when the loop stops.
	added, err := semiont.FramesOf(wire, bus.MarkAdded, resource)
	if err != nil {
		return err
	}
	for frame, err := range added {
		if err != nil {
			return err
		}
		fmt.Println(frame.Scope, frame.Payload.Type)
		return nil
	}
	return ctx.Err()
}
