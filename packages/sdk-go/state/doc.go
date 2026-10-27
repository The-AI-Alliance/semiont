// Package state is a client's state units: its long-running flows, held as
// state a consumer reads and watches (docs/builder/STATE-UNITS.md). None
// presumes a screen: a terminal, a daemon and an agent watching what a person
// does read them alike.
//
// Each is built over a client it is given and never closes. One that listens
// to the client's own bus takes its reader when it is made, so nothing said
// after it was made is missed, and it hears what is said in the order it was
// said. What it does in answer to a signal it does on a goroutine of its own,
// a moment later.
//
// Each is a semiont.StateUnit: Close ends it. What it had running is stopped,
// every state it holds ends, and nothing it is told afterwards does
// anything.
package state
