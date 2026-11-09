package launcher

// control_turns.go — the order exclusive control requests run in: the order
// they arrived, one at a time. A start, a stop and a status read the same
// record and the same directory, so a status sent after a start reads what
// the start left.

import "sync"

// turnstile gives turns in the order they were taken.
type turnstile struct {
	mu     sync.Mutex
	queue  []*turn
	holder *turn
}

// turn: one request's place in the line. ready is closed when it is its
// turn.
type turn struct {
	ready chan struct{}
}

// take joins the line: the turn is ready at once when nobody holds one.
func (t *turnstile) take() *turn {
	t.mu.Lock()
	defer t.mu.Unlock()
	mine := &turn{ready: make(chan struct{})}
	if t.holder == nil && len(t.queue) == 0 {
		t.holder = mine
		close(mine.ready)
		return mine
	}
	t.queue = append(t.queue, mine)
	return mine
}

// give ends mine, the turn being held, and readies the next.
func (t *turnstile) give(mine *turn) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.holder != mine {
		panic("a control request gave up a turn it did not hold")
	}
	t.holder = nil
	t.next()
}

// abandon leaves the line before mine's turn came, or gives it up if it came
// meanwhile.
func (t *turnstile) abandon(mine *turn) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.holder == mine {
		t.holder = nil
		t.next()
		return
	}
	for i, queued := range t.queue {
		if queued == mine {
			t.queue = append(t.queue[:i], t.queue[i+1:]...)
			return
		}
	}
}

func (t *turnstile) next() {
	if len(t.queue) == 0 {
		return
	}
	t.holder = t.queue[0]
	t.queue = t.queue[1:]
	close(t.holder.ready)
}
