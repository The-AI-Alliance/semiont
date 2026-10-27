package launcher

// transport.go — where a verb gets its client: the SDK's client over one
// transport per command, holding one stream to the stack's gateway, carrying
// the session's token and renewed by the session when the gateway refuses it.
//
// The transport is made in one place, behind a swappable function, so a verb
// can be observed in process: a test hands it a fake. This is the seam, not a
// factory: production has exactly one implementation, which is why it is a
// plain package-level func rather than a registry.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sync"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

// newTransport makes the transport a verb talks through. Tests replace it via
// UseTransport.
var newTransport = func(config semiont.HTTPTransportConfig) semiont.Transport {
	return semiont.NewHTTPTransport(config)
}

// UseTransport swaps the constructor and returns a restore func. Test-only by
// intent; it lives in the non-test file because the variable it closes over
// does, and Go has no narrower visibility that keeps them together.
func UseTransport(f func(config semiont.HTTPTransportConfig) semiont.Transport) (restore func()) {
	prev := newTransport
	newTransport = f
	return func() { newTransport = prev }
}

// replyChannels is every operation's result and failure channel: what a
// command's stream carries so that any request it makes can be answered. No
// broadcast is among them: a stream that carried the signals a verb emits
// would be counted among their audience, and `beckon` would report itself as
// the one subscriber it reached.
func replyChannels() []bus.Channel {
	channels := make([]bus.Channel, 0, 2*len(bus.Operations))
	for _, operation := range bus.Operations {
		channels = append(channels, operation.Result, operation.Failure)
	}
	return channels
}

// VerbClient is one command's client of its stack: the SDK's client over a
// transport to the stack's gateway, carrying the session's token and renewed
// by the session when the gateway refuses it. Its content and the gateway's
// own operations go over a second transport with the same token, which
// carries no channel and so opens no stream. A session that ends closes the
// client, so whatever the command waits on ends with it; the session's Close
// closes it.
type VerbClient struct {
	*semiont.Client
	sess   *Session
	bus    semiont.Transport
	direct *semiont.HTTPTransport
	// unhook lets go of the session's end, which closes the client.
	unhook func() bool

	reach       sync.Once
	unreachable error
}

// GatewayUnreached is a command whose stream's first connect failed: the
// gateway did not answer, or answered with a refusal that was not of the
// token. The command says so at once, where a request would wait out its
// deadline for a stream that may never open.
type GatewayUnreached struct{ Base string }

func (g *GatewayUnreached) Error() string {
	return fmt.Sprintf("the gateway at %s did not open the event stream", g.Base)
}

// Client is the command's client of its stack.
func (s *Session) Client() *VerbClient { return s.client }

// openClient opens the stack's client for one command. Its stream carries
// every operation's reply channels, and channels besides: the broadcasts a
// verb follows.
func (s *Session) openClient(channels []bus.Channel) *VerbClient {
	config := semiont.HTTPTransportConfig{
		BaseURL:   s.base,
		Token:     s.token,
		Refresher: s,
		HTTP:      &http.Client{Transport: launcherTransport},
		Timing:    semiont.DefaultTiming(),
	}
	direct := semiont.NewHTTPTransport(config)
	config.Channels = append(replyChannels(), channels...)
	transport := newTransport(config)
	client := semiont.NewClient(semiont.ClientConfig{
		Transport: transport,
		Content:   semiont.NewHTTPContentTransport(direct),
		Gateway:   direct,
		Timing:    semiont.DefaultTiming(),
	})
	return &VerbClient{Client: client, sess: s, bus: transport, direct: direct, unhook: context.AfterFunc(s.ended, client.Close)}
}

// Context ends when the gateway has refused the session's token for good,
// with the session's *SessionRejected as its cause. A verb asks under it.
func (c *VerbClient) Context() context.Context { return c.sess.ended }

// Reached waits, once, for the stream's first connect to settle: nil when it
// opens, a *GatewayUnreached when it fails. Only the first connect is judged
// here: a stream that has opened and drops is the transport's to reopen, and
// a request waits for it. A refused token, or a session that ended, is
// answered by what the verb does next. A verb calls it before its first
// request.
func (c *VerbClient) Reached() error {
	c.reach.Do(func() {
		for state := range c.bus.State().Changes(c.sess.ended) {
			switch state {
			case semiont.ConnectionStateOpen, semiont.ConnectionStateUnauthenticated, semiont.ConnectionStateClosed:
				return
			case semiont.ConnectionStateReconnecting, semiont.ConnectionStateDegraded:
				c.unreachable = &GatewayUnreached{Base: c.sess.base}
				return
			}
		}
	})
	return c.unreachable
}

// Refusal is err, returned by one of the client's calls, as a verb reports
// it: the session's rejection when the session is over, as it came
// otherwise.
func (c *VerbClient) Refusal(err error) error { return c.sess.refusal(err) }

// close ends the client, and then both its transports.
func (c *VerbClient) close() {
	c.unhook()
	c.Client.Close()
	c.bus.Close()
	c.direct.Close()
}

// refusal is an error of one of a client's calls as a verb reports it. A
// refused credential, and anything that failed once the session was over, are
// the session's rejection; anything else is as it came.
func (s *Session) refusal(err error) error {
	var refused *semiont.TransportError
	if errors.As(err, &refused) && refused.Code == semiont.TransportErrorCodeUnauthorized {
		// The transport asked the session for a token and sent the request
		// again with it, so this is the second refusal: unless the session has
		// already ended for its own reason, the gateway refused a token the
		// session had just renewed.
		s.end(&SessionRejected{cause: err})
		return context.Cause(s.ended)
	}
	if s.ended.Err() != nil {
		return context.Cause(s.ended)
	}
	return err
}
