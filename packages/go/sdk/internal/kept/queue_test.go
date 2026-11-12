package kept_test

import (
	"slices"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/internal/kept"
)

// A queue's reader is given every item pushed, in order, however far behind
// it is, and then the queue's end; nothing pushed after the close is added.
func TestAQueuesReaderIsGivenEveryItemInOrderAndThenItsEnd(t *testing.T) {
	q := kept.NewQueue[int]()
	pushed := make([]int, 1000)
	for n := range pushed {
		pushed[n] = n
		q.Push(n)
	}
	q.Close()
	q.Push(len(pushed))

	left := 0
	if heard := slices.Collect(q.All(nil, func() { left++ })); !slices.Equal(heard, pushed) {
		t.Errorf("the reader was given %d items, want the %d pushed before the close, in order", len(heard), len(pushed))
	}
	if left != 1 {
		t.Errorf("leave was called %d times, want once", left)
	}
}

// A loop over a queue that stops lets it go, and so does a stop that closes
// while the reader waits.
func TestALoopOverAQueueEndsWhenItStopsOrItsStopCloses(t *testing.T) {
	q := kept.NewQueue[int]()
	q.Push(1)
	q.Push(2)
	left := 0
	for range q.All(nil, func() { left++ }) {
		break
	}
	if left != 1 {
		t.Errorf("a loop that stopped called leave %d times, want once", left)
	}

	stop := make(chan struct{})
	close(stop)
	if heard := slices.Collect(q.All(stop, func() {})); !slices.Equal(heard, []int{2}) {
		t.Errorf("a reader whose stop has closed was given %v, want what the queue held, [2], and then its end", heard)
	}
}

// Keeping the latest n drops the oldest the queue holds beyond them.
func TestKeepingTheLatestDropsTheOldestBeyondThem(t *testing.T) {
	q := kept.NewQueue[int]()
	for n := range 5 {
		q.Push(n)
	}
	q.KeepLatest(2)
	q.KeepLatest(3)
	q.Close()
	if heard := slices.Collect(q.All(nil, func() {})); !slices.Equal(heard, []int{3, 4}) {
		t.Errorf("the queue gave %v, want [3 4]", heard)
	}
}

// A reader that selects on Ready drains, each time, what the queue holds, and
// is told when it has closed; signalled once more, it is woken to drain the
// end again.
func TestAReaderThatSelectsOnReadyDrainsWhatTheQueueHolds(t *testing.T) {
	q := kept.NewQueue[int]()
	q.Push(1)
	q.Push(2)
	<-q.Ready()
	if items, closed := q.Drain(); !slices.Equal(items, []int{1, 2}) || closed {
		t.Errorf("the drain took %v, closed %v, want [1 2] and open", items, closed)
	}
	q.Close()
	<-q.Ready()
	if items, closed := q.Drain(); len(items) != 0 || !closed {
		t.Errorf("the drain after the close took %v, closed %v, want nothing and closed", items, closed)
	}
	q.Signal()
	select {
	case <-q.Ready():
	default:
		t.Error("a signal did not wake the reader")
	}
}

// A broadcast gives each item to every queue listening when it is given;
// one that left is given nothing more, and its queue has ended.
func TestABroadcastGivesEachItemToEveryQueueListening(t *testing.T) {
	b := kept.NewBroadcast[string]()
	stays, leaves := b.Listen(), b.Listen()
	if listening := b.Give("both"); listening != 2 {
		t.Errorf("the item was given to %d, want 2", listening)
	}
	b.Leave(leaves)
	if listening := b.Give("one"); listening != 1 {
		t.Errorf("the item was given to %d after one left, want 1", listening)
	}
	b.Close()

	if heard := slices.Collect(stays.All(nil, func() {})); !slices.Equal(heard, []string{"both", "one"}) {
		t.Errorf("the listener that stayed was given %v", heard)
	}
	if heard := slices.Collect(leaves.All(nil, func() {})); !slices.Equal(heard, []string{"both"}) {
		t.Errorf("the listener that left was given %v", heard)
	}
}

// A queue that joins a closed broadcast has ended.
func TestAQueueThatJoinsAClosedBroadcastHasEnded(t *testing.T) {
	b := kept.NewBroadcast[string]()
	b.Close()
	q := kept.NewQueue[string]()
	b.Join(q)
	b.Give("after the close")
	if heard := slices.Collect(q.All(nil, func() {})); len(heard) != 0 {
		t.Errorf("a queue that joined a closed broadcast was given %v, want only its end", heard)
	}
}
