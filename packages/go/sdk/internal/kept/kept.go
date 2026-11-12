// Package kept is what a stream keeps for a reader who has not come yet: the
// latest errorsKeptForFirstReaderCount (protocol/specs/src/client/timing.json)
// of what it said, the oldest dropped beyond them.
package kept

// Latest is the last n of items; those before them are cleared, so that
// nothing is held by them.
func Latest[T any](items []T, n int) []T {
	beyond := len(items) - n
	if beyond <= 0 {
		return items
	}
	clear(items[:beyond])
	return items[beyond:]
}
