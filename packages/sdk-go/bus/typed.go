package bus

// A channel typed by the payload it carries. Go has no method
// type parameters, so the bus typed by channel is the root package's generic
// functions over these values: semiont.Emit(ctx, w, bus.BeckonFocus, p) is
// refused another channel's payload at compile time. Which channel carries
// which payload is the registry's to say; channels_gen.go and
// operations_gen.go derive every value from it.

// Global is a channel delivered with no resource's scope: what is read with
// no resource named.
type Global[P any] interface {
	Channel() Channel
	global(P)
}

// Of is a channel a client reads and the gateway does not accept on
// /bus/emit: a reply, an announcement, a signal between a client's own parts.
type Of[P any] struct{ name Channel }

// Channel is the channel's name.
func (c Of[P]) Channel() Channel { return c.name }
func (Of[P]) global(P)           {}

// Emittable is a channel the gateway accepts on /bus/emit, and validates
// against its payload's schema there. It is read as well as emitted.
type Emittable[P any] struct{ name Channel }

// Channel is the channel's name.
func (c Emittable[P]) Channel() Channel { return c.name }
func (Emittable[P]) global(P)           {}

// Recorded is a channel of the record sent to every client: P is the stored
// event it carries, and E the type of that event's own payload.
type Recorded[P, E any] struct{ name Channel }

// Channel is the channel's name.
func (c Recorded[P, E]) Channel() Channel { return c.name }
func (Recorded[P, E]) global(P)           {}

// Scoped is a channel of the record a resource's scope carries: it reaches
// only a client that holds that scope, so it is read for one resource. P is
// the stored event it carries, and E the type of that event's own payload.
type Scoped[P, E any] struct{ name Channel }

// Channel is the channel's name.
func (c Scoped[P, E]) Channel() Channel { return c.name }

// Operation is a request and the two channels it is answered on: Q is what
// is sent, R what its result carries, and F what its failure carries.
type Operation[Q, R, F any] struct {
	request, result, failure Channel
}

// Request is the channel the request is sent on.
func (o Operation[Q, R, F]) Request() Emittable[Q] { return Emittable[Q]{o.request} }

// Result is the channel its result is answered on.
func (o Operation[Q, R, F]) Result() Of[R] { return Of[R]{o.result} }

// Failure is the channel its failure is answered on.
func (o Operation[Q, R, F]) Failure() Of[F] { return Of[F]{o.failure} }

// Empty is the payload of a channel that carries nothing.
type Empty struct{}

// Response is the payload of a reply that carries its answer under
// `response`.
type Response[T any] struct {
	Response T `json:"response"`
}
