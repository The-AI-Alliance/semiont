package registry

// What knows how a knowledge base is reached: it builds the session of one,
// and ends the credentials of one. A registry is given a factory, and so
// manages sessions over any transport without knowing which.

import (
	"context"
	"net/http"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
)

// SessionFactoryOptions is what a session is built from.
type SessionFactoryOptions struct {
	// Kb is the knowledge base the session is for.
	Kb api.KnowledgeBase
	// Storage is where its tokens are kept: the registry's own storage.
	Storage semiont.SessionStorage
	// Signals is where the session says it is over, for a host to show.
	Signals *semiont.SessionSignals
	// OnError is told each failure that makes the session unusable.
	OnError func(*semiont.SessionError)
}

// SessionFactory builds the sessions a registry activates.
type SessionFactory interface {
	// Session builds the session of a knowledge base, and the client it
	// uses, and starts it. end ends the session, then its client. A
	// knowledge base this factory cannot reach is refused with a
	// *semiont.SessionError of code session.construct-failed. ctx ends when
	// the registry is closed: the registry stops waiting then, and ends a
	// session handed back afterwards at once.
	Session(ctx context.Context, options SessionFactoryOptions) (session *semiont.Session, end func(), err error)
	// Revoke tells whoever issued a stored session that it has been
	// forgotten, so its refresh token is good for nothing. Best effort: the
	// sign-out has happened whether or not the issuer hears of it, and the
	// registry does not wait for it.
	Revoke(ctx context.Context, stored StoredSession)
}

// HttpSessionFactory builds the session of each knowledge base a registry
// activates, over its gateway. The session's caches, and the stream's place
// in each scope, are kept in the registry's storage, under the knowledge
// base's id, and its token is renewed at the issuer its stored session names.
type HttpSessionFactory struct {
	// HTTP is what every request of a gateway and an issuer is made with.
	HTTP   *http.Client
	Timing semiont.Timing
}

var _ SessionFactory = HttpSessionFactory{}

func (f HttpSessionFactory) Session(ctx context.Context, options SessionFactoryOptions) (*semiont.Session, func(), error) {
	return semiont.SessionFromKept(ctx, semiont.SessionFromKeptConfig{
		Kb:            api.KbTarget{Endpoint: options.Kb.Endpoint, Id: options.Kb.Id, Label: options.Kb.Label},
		Kept:          KeptIn(options.Storage, options.Kb.Id),
		HTTP:          f.HTTP,
		Timing:        f.Timing,
		AskWhoTokenIs: true,
		Channels:      bus.BridgedChannels,
		Storage:       options.Storage,
		OnAuthFailed:  options.Signals.NotifySessionEnded,
		OnError:       options.OnError,
	})
}

func (f HttpSessionFactory) Revoke(ctx context.Context, stored StoredSession) {
	if stored.RevocationEndpoint == "" {
		return
	}
	// Best effort, as the interface says: the sign-out stands either way.
	_ = semiont.Issuer{HTTP: f.HTTP, Timing: f.Timing}.Revoke(ctx, stored.RevocationEndpoint, stored.ClientID, stored.Refresh)
}
