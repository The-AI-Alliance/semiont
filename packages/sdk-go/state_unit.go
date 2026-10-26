package semiont

// StateUnit is a long-running flow, held as state a consumer reads and
// watches (docs/builder/STATE-UNITS.md), the pattern every Semiont SDK keeps.
// A unit's consumers read it and never write it: what it holds it hands out
// as Watched values. It is moved by its methods and by what it hears on the
// client's own bus, and it ends by Close.
//
// Each of this module's units says it is one where it is declared,
//
//	var _ StateUnit = (*MarkStateUnit)(nil)
//
// so the compiler holds it to the interface and a census can find it in the
// source.
type StateUnit interface {
	// Close ends the unit. Closing it again does nothing more. When it
	// returns, every state the unit holds has ended, everything it had
	// running has been stopped, and nothing it is told afterwards does
	// anything. What the unit was given, such as the client it was built
	// over, is not its to end.
	Close()
}
