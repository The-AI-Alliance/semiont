package semiont

// The cache a client's live queries answer from, held to
// docs/protocol/CACHE-SEMANTICS.md clause by clause. Each test names the
// clause it holds. The service is one a test answers for, so every request
// waits until the test says how it ends.

import (
	"context"
	"errors"
	"iter"
	"reflect"
	"slices"
	"sync"
	"testing"
	"time"
)

const cacheKeyOne = "k"

// answering is a service a test answers for: each request waits until the
// test says how it is answered.
type answering struct {
	mu      sync.Mutex
	asked   []string
	waiting []chan replied
}

type replied struct {
	value int
	err   error
}

func (s *answering) fetch(ctx context.Context, key string) (int, error) {
	reply := make(chan replied, 1)
	s.mu.Lock()
	s.asked = append(s.asked, key)
	s.waiting = append(s.waiting, reply)
	s.mu.Unlock()
	select {
	case a := <-reply:
		return a.value, a.err
	case <-ctx.Done():
		return 0, ctx.Err()
	}
}

// askedNow is the key of each request so far, in the order they were made.
func (s *answering) askedNow() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.asked)
}

// count waits until n requests have been made.
func (s *answering) count(t *testing.T, n int) {
	t.Helper()
	eventually(t, "the requests made", func() bool { return len(s.askedNow()) >= n })
}

// askedJust is the requests made, which are to be want and stay so.
func (s *answering) askedJust(t *testing.T, want ...string) {
	t.Helper()
	eventually(t, "the requests made", func() bool { return len(s.askedNow()) >= len(want) })
	settledFor()
	if got := s.askedNow(); !slices.Equal(got, want) {
		t.Fatalf("asked %v, want %v", got, want)
	}
}

func (s *answering) reply(t *testing.T, request int, a replied) {
	t.Helper()
	s.count(t, request+1)
	s.mu.Lock()
	reply := s.waiting[request]
	s.mu.Unlock()
	reply <- a
}

func (s *answering) answer(t *testing.T, request, value int) {
	t.Helper()
	s.reply(t, request, replied{value: value})
}

func (s *answering) fail(t *testing.T, request int, why string) error {
	t.Helper()
	failure := &BusRequestError{Code: BusRequestErrorCodeTimeout, Message: why}
	s.reply(t, request, replied{err: failure})
	return failure
}

// workers runs a cache's fetches, as a client does: each is ended when the
// test closes it.
type workers struct {
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

func (w *workers) run(work func(ctx context.Context)) {
	w.wg.Add(1)
	go func() {
		defer w.wg.Done()
		work(w.ctx)
	}()
}

// idle waits until nothing it ran is still running.
func (w *workers) idle(t *testing.T) {
	t.Helper()
	ended := make(chan struct{})
	go func() {
		w.wg.Wait()
		close(ended)
	}()
	select {
	case <-ended:
	case <-time.After(2 * time.Second):
		t.Fatal("work the cache started is still running")
	}
}

func (w *workers) close(t *testing.T) {
	t.Helper()
	w.cancel()
	w.idle(t)
}

// keptBack is a persister that holds what it was given, and counts the saves.
type keptBack struct {
	mu    sync.Mutex
	kept  map[string]int
	saves []map[string]int
}

func (k *keptBack) Load() map[string]int { return k.kept }

func (k *keptBack) Save(entries map[string]int) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.saves = append(k.saves, entries)
	return nil
}

func (k *keptBack) saved() []map[string]int {
	k.mu.Lock()
	defer k.mu.Unlock()
	return slices.Clone(k.saves)
}

// cacheWorld is a cache over a service a test answers, with what runs its
// fetches. persister, when it is not nil, keeps its values, saved wait after
// they last changed.
func cacheWorld(t *testing.T, persister *keptBack, wait time.Duration) (*Cache[string, int], *answering, *workers) {
	t.Helper()
	service := &answering{}
	ctx, cancel := context.WithCancel(context.Background())
	runner := &workers{ctx: ctx, cancel: cancel}
	var kept CachePersister[string, int]
	if persister != nil {
		kept = persister
	}
	c := NewCache(service.fetch, runner.run, kept, wait)
	t.Cleanup(func() {
		c.Close()
		cancel()
		runner.wg.Wait()
	})
	return c, service, runner
}

// pulledState is what one pull of an observer gave.
type pulledState struct {
	state CacheState
	ok    bool
}

// observer is one observer of a key: its states, pulled one at a time.
type observer struct {
	next    func() (CacheState, bool)
	stop    func()
	cancel  context.CancelFunc
	pending chan pulledState
}

// watching is an observer of key. Its first pull is what asks.
func watching(t *testing.T, c *Cache[string, int], key string) *observer {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	next, stop := iter.Pull(c.Observe(ctx, key))
	o := &observer{next: next, stop: stop, cancel: cancel}
	t.Cleanup(o.close)
	return o
}

func (o *observer) pull() chan pulledState {
	if o.pending == nil {
		o.pending = make(chan pulledState, 1)
		pending := o.pending
		go func() {
			state, ok := o.next()
			pending <- pulledState{state, ok}
		}()
	}
	return o.pending
}

// now is the state the observer is given next, which is to be there
// already or soon.
func (o *observer) now(t *testing.T) CacheState {
	t.Helper()
	select {
	case got := <-o.pull():
		o.pending = nil
		if !got.ok {
			t.Fatal("the observer's states ended")
		}
		return got.state
	case <-time.After(2 * time.Second):
		t.Fatal("the observer was given no state")
		return nil
	}
}

// nothingMore says the observer is given nothing more now; what it is given
// later is the next now.
func (o *observer) nothingMore(t *testing.T) {
	t.Helper()
	select {
	case got := <-o.pull():
		o.pending = nil
		t.Fatalf("the observer was given %#v", got.state)
	case <-time.After(50 * time.Millisecond):
	}
}

// ended says the observer's states have ended.
func (o *observer) ended(t *testing.T) {
	t.Helper()
	select {
	case got := <-o.pull():
		o.pending = nil
		if got.ok {
			t.Fatalf("the observer was given %#v, after its end", got.state)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the observer's states did not end")
	}
}

func (o *observer) close() {
	o.cancel()
	if o.pending != nil {
		<-o.pending
		o.pending = nil
	}
	o.stop()
}

func isState(t *testing.T, got, want CacheState) {
	t.Helper()
	if got != want {
		t.Fatalf("the state is %#v, want %#v", got, want)
	}
}

// ready is an observer of the key, which the first request has replied value.
func ready(t *testing.T, c *Cache[string, int], service *answering, value int) *observer {
	t.Helper()
	o := watching(t, c, cacheKeyOne)
	isState(t, o.now(t), Pending{})
	service.answer(t, 0, value)
	isState(t, o.now(t), Ready[int]{Value: value})
	return o
}

// aRead is a one-shot read of key, run while the test goes on.
func aRead(ctx context.Context, c *Cache[string, int], key string) chan replied {
	read := make(chan replied, 1)
	go func() {
		value, err := c.Fetch(ctx, key)
		read <- replied{value, err}
	}()
	return read
}

// readEnded is what the read came to.
func readEnded(t *testing.T, read chan replied) replied {
	t.Helper()
	select {
	case got := <-read:
		return got
	case <-time.After(2 * time.Second):
		t.Fatal("the read did not end")
		return replied{}
	}
}

func TestB1TheFirstObserverOfAKeySeesItPendingCostsOneRequestAndSeesItsAnswer(t *testing.T) {
	c, service, _ := cacheWorld(t, nil, 0)
	if _, has := c.Get(cacheKeyOne); has || c.Known(cacheKeyOne) {
		t.Fatal("a key nobody asked for has a value or is known")
	}
	o := watching(t, c, cacheKeyOne)
	isState(t, o.now(t), Pending{})
	service.askedJust(t, cacheKeyOne)
	if !c.Known(cacheKeyOne) || !slices.Equal(c.Keys(), []string{cacheKeyOne}) {
		t.Fatal("the key being fetched is not known")
	}
	service.answer(t, 0, 7)
	isState(t, o.now(t), Ready[int]{Value: 7})
	if value, _ := c.Get(cacheKeyOne); value != 7 {
		t.Fatalf("the value is %d, want 7", value)
	}
	service.askedJust(t, cacheKeyOne)
}

func TestB2ALaterObserverIsGivenTheValueAndCostsNoRequest(t *testing.T) {
	c, service, _ := cacheWorld(t, nil, 0)
	ready(t, c, service, 7)
	isState(t, watching(t, c, cacheKeyOne).now(t), Ready[int]{Value: 7})
	service.askedJust(t, cacheKeyOne)
}

func TestB3ObserversThatArriveBeforeTheValueShareOneRequestAndSeeTheSameValue(t *testing.T) {
	c, service, _ := cacheWorld(t, nil, 0)
	one, other := watching(t, c, cacheKeyOne), watching(t, c, cacheKeyOne)
	isState(t, one.now(t), Pending{})
	isState(t, other.now(t), Pending{})
	service.askedJust(t, cacheKeyOne)
	// A one-shot read while it is in flight joins it too.
	read := aRead(context.Background(), c, cacheKeyOne)
	service.askedJust(t, cacheKeyOne)
	service.answer(t, 0, 7)
	isState(t, one.now(t), Ready[int]{Value: 7})
	isState(t, other.now(t), Ready[int]{Value: 7})
	if got := readEnded(t, read); got.err != nil || got.value != 7 {
		t.Fatalf("the read gave %d, %v", got.value, got.err)
	}
}

func TestB6ARefetchThatFailsAndFailsAgainLeavesTheValueItWasToReplace(t *testing.T) {
	c, service, _ := cacheWorld(t, nil, 0)
	o := ready(t, c, service, 1)
	c.Invalidate(cacheKeyOne)
	o.nothingMore(t)
	service.fail(t, 1, "the service is down")
	service.fail(t, 2, "the service is down")
	// The value stays, and the key is never failed: stale beats an error.
	service.askedJust(t, cacheKeyOne, cacheKeyOne, cacheKeyOne)
	if value, _ := c.Get(cacheKeyOne); value != 1 {
		t.Fatalf("the value is %d, want 1", value)
	}
	o.nothingMore(t)
	isState(t, watching(t, c, cacheKeyOne).now(t), Ready[int]{Value: 1})
}

func TestB7InvalidatingAsksAgainAndShowsTheValueUntilTheNewOneArrives(t *testing.T) {
	c, service, _ := cacheWorld(t, nil, 0)
	o := ready(t, c, service, 1)
	c.Invalidate(cacheKeyOne)
	o.nothingMore(t)
	service.askedJust(t, cacheKeyOne, cacheKeyOne)
	if value, _ := c.Get(cacheKeyOne); value != 1 {
		t.Fatalf("the value is %d, want 1", value)
	}
	service.answer(t, 1, 2)
	isState(t, o.now(t), Ready[int]{Value: 2})
}

func TestB8InvalidatingAKeyNobodyAskedForAsksForIt(t *testing.T) {
	c, service, _ := cacheWorld(t, nil, 0)
	c.Invalidate(cacheKeyOne)
	service.askedJust(t, cacheKeyOne)
	if !c.Known(cacheKeyOne) {
		t.Fatal("the key invalidated is not known")
	}
	service.answer(t, 0, 4)
	eventually(t, "the value written", func() bool { value, _ := c.Get(cacheKeyOne); return value == 4 })
	// And one whose only request failed twice is pending again when it is invalidated.
	other := watching(t, c, "other")
	isState(t, other.now(t), Pending{})
	service.fail(t, 1, "the first")
	failure := service.fail(t, 2, "the retry")
	isState(t, other.now(t), Failed{Err: failure})
	c.Invalidate("other")
	isState(t, other.now(t), Pending{})
	service.answer(t, 3, 9)
	isState(t, other.now(t), Ready[int]{Value: 9})
}

func TestB9InvalidatingWhileAFetchIsInFlightStartsAnotherAndTheLastAnswerIsTheValue(t *testing.T) {
	c, service, _ := cacheWorld(t, nil, 0)
	o := watching(t, c, cacheKeyOne)
	isState(t, o.now(t), Pending{})
	service.count(t, 1)
	c.Invalidate(cacheKeyOne)
	// Not joined: the one in flight may never be replied.
	service.askedJust(t, cacheKeyOne, cacheKeyOne)
	service.answer(t, 1, 5)
	isState(t, o.now(t), Ready[int]{Value: 5})
	// And when it is replied after all, it is as new as what was there.
	service.answer(t, 0, 3)
	isState(t, o.now(t), Ready[int]{Value: 3})
	// Nothing is in flight now: the next observer is given the value and asks nothing.
	isState(t, watching(t, c, cacheKeyOne).now(t), Ready[int]{Value: 3})
	service.askedJust(t, cacheKeyOne, cacheKeyOne)
}

func TestB9AFetchThatWasLetGoOfDoesNotTakeThePlaceOfTheOneAfterIt(t *testing.T) {
	c, service, _ := cacheWorld(t, nil, 0)
	watching(t, c, cacheKeyOne).now(t)
	service.count(t, 1)
	c.Invalidate(cacheKeyOne)
	service.count(t, 2)
	// The older ends first, while the newer is still in flight: a read now joins the newer.
	service.answer(t, 0, 3)
	eventually(t, "the older answer written", func() bool { value, _ := c.Get(cacheKeyOne); return value == 3 })
	read := aRead(context.Background(), c, cacheKeyOne)
	service.askedJust(t, cacheKeyOne, cacheKeyOne)
	service.answer(t, 1, 5)
	if got := readEnded(t, read); got.err != nil || got.value != 5 {
		t.Fatalf("the read gave %d, %v", got.value, got.err)
	}
}

func TestB10KeysAreIndependent(t *testing.T) {
	c, service, _ := cacheWorld(t, nil, 0)
	one, other := watching(t, c, "a"), watching(t, c, "b")
	isState(t, one.now(t), Pending{})
	service.count(t, 1)
	isState(t, other.now(t), Pending{})
	service.askedJust(t, "a", "b")
	service.answer(t, 1, 2)
	isState(t, other.now(t), Ready[int]{Value: 2})
	one.nothingMore(t)
	c.Invalidate("b")
	service.askedJust(t, "a", "b", "b")
	keys := c.Keys()
	slices.Sort(keys)
	if !slices.Equal(keys, []string{"a", "b"}) {
		t.Fatalf("the keys known are %v", keys)
	}
	c.InvalidateAll()
	service.count(t, 5)
	settledFor()
	again := service.askedNow()[3:]
	slices.Sort(again)
	if !slices.Equal(again, []string{"a", "b"}) {
		t.Fatalf("invalidating every key asked %v", again)
	}
}

func TestB14AFetchForAnObserverThatFailsIsMadeOnceMoreAndNoMore(t *testing.T) {
	c, service, _ := cacheWorld(t, nil, 0)
	o := watching(t, c, cacheKeyOne)
	isState(t, o.now(t), Pending{})
	service.fail(t, 0, "the first")
	o.nothingMore(t)
	service.askedJust(t, cacheKeyOne, cacheKeyOne)
	service.answer(t, 1, 7)
	isState(t, o.now(t), Ready[int]{Value: 7})
	service.askedJust(t, cacheKeyOne, cacheKeyOne)
}

func TestB14AOneShotReadIsNeverRetriedAndItsFailureIsItsCallersAlone(t *testing.T) {
	c, service, _ := cacheWorld(t, nil, 0)
	read := aRead(context.Background(), c, cacheKeyOne)
	failure := service.fail(t, 0, "the service is down")
	if got := readEnded(t, read); got.err != failure {
		t.Fatalf("the read failed with %v, want the service's failure", got.err)
	}
	service.askedJust(t, cacheKeyOne)
	// A failure writes nothing: the key is as it was, and its first observer asks.
	if _, has := c.Get(cacheKeyOne); has {
		t.Fatal("a failed read wrote a value")
	}
	isState(t, watching(t, c, cacheKeyOne).now(t), Pending{})
	service.askedJust(t, cacheKeyOne, cacheKeyOne)
}

func TestB14TheRetryJoinsAFetchAnotherCallerStartedMeanwhile(t *testing.T) {
	c, service, _ := cacheWorld(t, nil, 0)
	o := watching(t, c, cacheKeyOne)
	isState(t, o.now(t), Pending{})
	read := aRead(context.Background(), c, cacheKeyOne)
	service.askedJust(t, cacheKeyOne)
	failure := service.fail(t, 0, "the first")
	if got := readEnded(t, read); got.err != failure {
		t.Fatalf("the read failed with %v, want the service's failure", got.err)
	}
	// The observer's retry is one request, and a read made while it is in flight is the same one.
	again := aRead(context.Background(), c, cacheKeyOne)
	service.askedJust(t, cacheKeyOne, cacheKeyOne)
	service.answer(t, 1, 7)
	if got := readEnded(t, again); got.err != nil || got.value != 7 {
		t.Fatalf("the read gave %d, %v", got.value, got.err)
	}
	isState(t, o.now(t), Ready[int]{Value: 7})
}

func TestB15AKeyWithNoValueWhoseRetryFailsTooIsFailedForEveryObserverWhoLiveOn(t *testing.T) {
	c, service, _ := cacheWorld(t, nil, 0)
	one, other := watching(t, c, cacheKeyOne), watching(t, c, cacheKeyOne)
	isState(t, one.now(t), Pending{})
	isState(t, other.now(t), Pending{})
	service.fail(t, 0, "the first")
	failure := service.fail(t, 1, "the retry")
	// The retry's failure, not the first's.
	isState(t, one.now(t), Failed{Err: failure})
	isState(t, other.now(t), Failed{Err: failure})
	if _, has := c.Get(cacheKeyOne); has || !c.Known(cacheKeyOne) {
		t.Fatal("a failed key has a value, or is not known")
	}
	service.askedJust(t, cacheKeyOne, cacheKeyOne)

	// An observer arriving starts over, for everyone: all three are pending, and then ready.
	arriving := watching(t, c, cacheKeyOne)
	isState(t, arriving.now(t), Pending{})
	isState(t, one.now(t), Pending{})
	isState(t, other.now(t), Pending{})
	service.askedJust(t, cacheKeyOne, cacheKeyOne, cacheKeyOne)
	service.answer(t, 2, 7)
	for _, o := range []*observer{one, other, arriving} {
		isState(t, o.now(t), Ready[int]{Value: 7})
	}
}

func TestB15AFailedKeyIsMadeReadyByAValueHoweverItComesWithNoPendingBetween(t *testing.T) {
	failed := func(t *testing.T) (*Cache[string, int], *answering, *observer) {
		c, service, _ := cacheWorld(t, nil, 0)
		o := watching(t, c, cacheKeyOne)
		isState(t, o.now(t), Pending{})
		service.fail(t, 0, "the first")
		failure := service.fail(t, 1, "the retry")
		isState(t, o.now(t), Failed{Err: failure})
		return c, service, o
	}
	t.Run("a value that is known", func(t *testing.T) {
		c, service, o := failed(t)
		c.Set(cacheKeyOne, 3)
		isState(t, o.now(t), Ready[int]{Value: 3})
		service.askedJust(t, cacheKeyOne, cacheKeyOne)
	})
	t.Run("a one-shot read's answer", func(t *testing.T) {
		c, service, o := failed(t)
		read := aRead(context.Background(), c, cacheKeyOne)
		service.answer(t, 2, 4)
		if got := readEnded(t, read); got.err != nil || got.value != 4 {
			t.Fatalf("the read gave %d, %v", got.value, got.err)
		}
		isState(t, o.now(t), Ready[int]{Value: 4})
	})
}

func TestB13aARemovedKeyIsFailedAsItWasToldAtOnceAndNothingIsAskedFor(t *testing.T) {
	c, service, _ := cacheWorld(t, nil, 0)
	o := ready(t, c, service, 1)
	gone := &BusRequestError{Code: BusRequestErrorCodeNotFound, Message: "it was removed"}
	c.Remove(cacheKeyOne, gone)
	isState(t, o.now(t), Failed{Err: gone})
	if _, has := c.Get(cacheKeyOne); has || !c.Known(cacheKeyOne) {
		t.Fatal("a removed key has a value, or is not known")
	}
	service.askedJust(t, cacheKeyOne)
	// An observer arriving asks the service, which is who knows.
	isState(t, watching(t, c, cacheKeyOne).now(t), Pending{})
	service.askedJust(t, cacheKeyOne, cacheKeyOne)
	// A fetch in flight when the key is removed is let go of: a read after it does not join it.
	c.Remove(cacheKeyOne, gone)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	aRead(ctx, c, cacheKeyOne)
	service.askedJust(t, cacheKeyOne, cacheKeyOne, cacheKeyOne)
}

func TestAValueThatIsKnownIsWrittenAndNothingIsAskedFor(t *testing.T) {
	c, service, _ := cacheWorld(t, nil, 0)
	c.Set(cacheKeyOne, 3)
	if value, _ := c.Get(cacheKeyOne); value != 3 {
		t.Fatalf("the value is %d, want 3", value)
	}
	o := watching(t, c, cacheKeyOne)
	isState(t, o.now(t), Ready[int]{Value: 3})
	c.Set(cacheKeyOne, 4)
	isState(t, o.now(t), Ready[int]{Value: 4})
	service.askedJust(t)
}

func TestAnObserverThatFallsBehindIsGivenTheLatestStateNotEachItMissed(t *testing.T) {
	c, _, _ := cacheWorld(t, nil, 0)
	c.Set(cacheKeyOne, 1)
	o := watching(t, c, cacheKeyOne)
	isState(t, o.now(t), Ready[int]{Value: 1})
	c.Set(cacheKeyOne, 2)
	c.Set(cacheKeyOne, 3)
	isState(t, o.now(t), Ready[int]{Value: 3})
	o.nothingMore(t)
}

func TestB16DisposingEndsEveryObserverAndNothingIsAskedOrWrittenAfter(t *testing.T) {
	c, service, _ := cacheWorld(t, nil, 0)
	o := ready(t, c, service, 1)
	waiting := watching(t, c, "waiting")
	isState(t, waiting.now(t), Pending{})
	service.count(t, 2)
	c.Close()
	c.Close()
	o.ended(t)
	waiting.ended(t)

	// An observer arriving is given nothing, and costs nothing.
	watching(t, c, cacheKeyOne).ended(t)
	watching(t, c, "new").ended(t)
	var refused *BusRequestError
	if _, err := c.Fetch(context.Background(), cacheKeyOne); !errors.As(err, &refused) || refused.Code != BusRequestErrorCodeClosed {
		t.Fatalf("a read of a disposed cache failed with %v, want bus.closed", err)
	}
	c.Invalidate(cacheKeyOne)
	c.InvalidateAll()
	c.Set(cacheKeyOne, 9)
	c.Remove(cacheKeyOne, &BusRequestError{Code: BusRequestErrorCodeNotFound, Message: "gone"})
	service.askedJust(t, cacheKeyOne, "waiting")
	if _, has := c.Get(cacheKeyOne); has || c.Known(cacheKeyOne) || len(c.Keys()) != 0 {
		t.Fatal("a disposed cache holds something")
	}

	// What was in flight is replied into nothing.
	service.answer(t, 1, 5)
	settledFor()
	if _, has := c.Get("waiting"); has {
		t.Fatal("an answer after disposal was written")
	}
}

func TestB16ARetryThatStraddlesTheDisposalIsNeverMade(t *testing.T) {
	c, service, runner := cacheWorld(t, nil, 0)
	o := watching(t, c, cacheKeyOne)
	isState(t, o.now(t), Pending{})
	service.count(t, 1)
	c.Close()
	service.fail(t, 0, "the first")
	service.askedJust(t, cacheKeyOne)
	runner.idle(t)
}

func TestAReadWhoseFetchItsClientsClosingEndedFailsAsClosedAndOneThatIsAbandonedIsOnlyAbandoned(t *testing.T) {
	c, service, runner := cacheWorld(t, nil, 0)
	ctx, abandon := context.WithCancel(context.Background())
	abandoned := aRead(ctx, c, cacheKeyOne)
	read := aRead(context.Background(), c, cacheKeyOne)
	service.askedJust(t, cacheKeyOne)
	// Its caller stops waiting: the fetch goes on for the other.
	abandon()
	if got := readEnded(t, abandoned); !errors.Is(got.err, context.Canceled) {
		t.Fatalf("the abandoned read ended with %v, want its own cancellation", got.err)
	}
	select {
	case got := <-read:
		t.Fatalf("the read still waiting ended with %v", got.err)
	case <-time.After(50 * time.Millisecond):
	}
	service.askedJust(t, cacheKeyOne)
	runner.close(t)
	var refused *BusRequestError
	if got := readEnded(t, read); !errors.As(got.err, &refused) || refused.Code != BusRequestErrorCodeClosed {
		t.Fatalf("the read ended with %v, want bus.closed", got.err)
	}
}

func TestB17ACacheBeginsWithWhatWasKeptAndB18AsksForItAnewTheFirstTimeItIsObserved(t *testing.T) {
	c, service, _ := cacheWorld(t, &keptBack{kept: map[string]int{cacheKeyOne: 1, "unobserved": 2}}, time.Hour)
	if value, _ := c.Get(cacheKeyOne); value != 1 {
		t.Fatalf("the kept value is %d, want 1", value)
	}
	keys := c.Keys()
	slices.Sort(keys)
	if !slices.Equal(keys, []string{cacheKeyOne, "unobserved"}) {
		t.Fatalf("the keys known are %v", keys)
	}
	service.askedJust(t)

	// Shown at once, with no pending before it, and asked for again: nothing says it is still true.
	o := watching(t, c, cacheKeyOne)
	isState(t, o.now(t), Ready[int]{Value: 1})
	service.askedJust(t, cacheKeyOne)
	// Once: a second observer, while that is in flight and after, asks nothing.
	isState(t, watching(t, c, cacheKeyOne).now(t), Ready[int]{Value: 1})
	service.answer(t, 0, 5)
	isState(t, o.now(t), Ready[int]{Value: 5})
	isState(t, watching(t, c, cacheKeyOne).now(t), Ready[int]{Value: 5})
	service.askedJust(t, cacheKeyOne)
	// Only what is observed: the other kept key cost nothing.
	if value, _ := c.Get("unobserved"); value != 2 {
		t.Fatalf("the unobserved kept value is %d, want 2", value)
	}
}

func TestB18AKeptValueWhoseRevalidationFailsTwiceStaysAndIsNotAskedForAThirdTime(t *testing.T) {
	c, service, _ := cacheWorld(t, &keptBack{kept: map[string]int{cacheKeyOne: 1}}, time.Hour)
	o := watching(t, c, cacheKeyOne)
	isState(t, o.now(t), Ready[int]{Value: 1})
	service.fail(t, 0, "the first")
	service.fail(t, 1, "the retry")
	service.askedJust(t, cacheKeyOne, cacheKeyOne)
	if value, _ := c.Get(cacheKeyOne); value != 1 {
		t.Fatalf("the kept value is %d, want 1", value)
	}
	isState(t, watching(t, c, cacheKeyOne).now(t), Ready[int]{Value: 1})
	service.askedJust(t, cacheKeyOne, cacheKeyOne)
}

func TestB18AKeptValueIsNoLongerOneOnceAnythingHasAskedForItOrWrittenIt(t *testing.T) {
	for _, first := range []string{"a read", "an invalidation", "a value that is known", "its removal"} {
		t.Run(first, func(t *testing.T) {
			c, service, _ := cacheWorld(t, &keptBack{kept: map[string]int{cacheKeyOne: 1}}, time.Hour)
			asked := 1
			switch first {
			case "a read":
				read := aRead(context.Background(), c, cacheKeyOne)
				service.answer(t, 0, 2)
				if got := readEnded(t, read); got.err != nil || got.value != 2 {
					t.Fatalf("the read gave %d, %v", got.value, got.err)
				}
			case "an invalidation":
				c.Invalidate(cacheKeyOne)
				service.answer(t, 0, 2)
				eventually(t, "the value written", func() bool { value, _ := c.Get(cacheKeyOne); return value == 2 })
			case "a value that is known":
				c.Set(cacheKeyOne, 2)
				asked = 0
			default:
				c.Remove(cacheKeyOne, &BusRequestError{Code: BusRequestErrorCodeNotFound, Message: "gone"})
				asked = 0
			}
			settledFor()
			if got := len(service.askedNow()); got != asked {
				t.Fatalf("%d requests before the observer, want %d", got, asked)
			}
			watching(t, c, cacheKeyOne).now(t)
			// The removed key is asked for by its first observer, as any failed key is: not because it was kept.
			if first == "its removal" {
				asked = 1
			}
			settledFor()
			if got := len(service.askedNow()); got != asked {
				t.Fatalf("%d requests after the observer, want %d", got, asked)
			}
		})
	}
}

func TestB17ValuesAreSavedOnceTheyHaveStoppedChangingAndOnlyValues(t *testing.T) {
	const wait = 200 * time.Millisecond
	persister := &keptBack{}
	c, service, _ := cacheWorld(t, persister, wait)
	if c.PersistencePending() {
		t.Fatal("a cache that has done nothing owes something")
	}
	failing := watching(t, c, "failing")
	isState(t, failing.now(t), Pending{})
	// Fetching, it has not kept what it knows.
	if !c.PersistencePending() {
		t.Fatal("a cache fetching owes nothing")
	}
	service.fail(t, 0, "the first")
	failure := service.fail(t, 1, "the retry")
	isState(t, failing.now(t), Failed{Err: failure})
	eventually(t, "nothing in flight", func() bool { return !c.PersistencePending() })

	c.Set("a", 1)
	if !c.PersistencePending() {
		t.Fatal("a cache with a new value owes nothing")
	}
	time.Sleep(wait / 2)
	c.Set("b", 2)
	// The wait begins again with each change: a burst is one save.
	time.Sleep(wait / 2)
	if saves := persister.saved(); len(saves) != 0 || !c.PersistencePending() {
		t.Fatalf("saved %v before the values stopped changing", saves)
	}
	eventually(t, "the save", func() bool { return len(persister.saved()) == 1 })
	// A failure is not a value, and is not kept.
	if saves := persister.saved(); !reflect.DeepEqual(saves[0], map[string]int{"a": 1, "b": 2}) {
		t.Fatalf("saved %v", saves[0])
	}
	eventually(t, "nothing owed", func() bool { return !c.PersistencePending() })

	// A removal is a change too, and what is gone is no longer kept.
	c.Remove("a", &BusRequestError{Code: BusRequestErrorCodeNotFound, Message: "gone"})
	if !c.PersistencePending() {
		t.Fatal("a removal owes nothing")
	}
	eventually(t, "the save of the removal", func() bool { return len(persister.saved()) == 2 })
	if saves := persister.saved(); !reflect.DeepEqual(saves[1], map[string]int{"b": 2}) {
		t.Fatalf("saved %v", saves[1])
	}
	// And a fetched value is saved as a known one is.
	fetched := watching(t, c, "c")
	isState(t, fetched.now(t), Pending{})
	service.answer(t, 2, 3)
	isState(t, fetched.now(t), Ready[int]{Value: 3})
	eventually(t, "the save of the fetched value", func() bool { return len(persister.saved()) == 3 })
	if saves := persister.saved(); !reflect.DeepEqual(saves[2], map[string]int{"b": 2, "c": 3}) {
		t.Fatalf("saved %v", saves[2])
	}
}

func TestB17DisposingMakesASaveThatWasOwedAtOnceAndNoneIsMadeAfter(t *testing.T) {
	persister := &keptBack{}
	c, _, _ := cacheWorld(t, persister, time.Hour)
	c.Set("a", 1)
	c.Close()
	if saves := persister.saved(); len(saves) != 1 || !reflect.DeepEqual(saves[0], map[string]int{"a": 1}) {
		t.Fatalf("disposing saved %v, want the owed save", saves)
	}
	c.Set("b", 2)
	settledFor()
	if saves := persister.saved(); len(saves) != 1 {
		t.Fatalf("saved %v after disposal", saves)
	}

	// With nothing owed, disposing saves nothing.
	idle := &keptBack{kept: map[string]int{"a": 1}}
	resting, _, _ := cacheWorld(t, idle, time.Hour)
	resting.Close()
	if saves := idle.saved(); len(saves) != 0 {
		t.Fatalf("a cache owing nothing saved %v when disposed", saves)
	}
}

func TestACacheThatKeepsNothingOwesNothing(t *testing.T) {
	c, _, _ := cacheWorld(t, nil, 0)
	watching(t, c, cacheKeyOne).now(t)
	c.Set("a", 1)
	if c.PersistencePending() {
		t.Fatal("a cache that keeps nothing owes something")
	}
}
