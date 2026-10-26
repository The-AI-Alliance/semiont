package semiont

// A live query.

import "context"

// Cached is a live query. Building it touches nothing; its one-shot read
// (Fresh) asks the service now.
type Cached[T any] struct {
	fetch func(ctx context.Context) (T, error)
}

// Fresh asks the service now, and gives what it answers.
func (q *Cached[T]) Fresh(ctx context.Context) (T, error) {
	return q.fetch(ctx)
}
