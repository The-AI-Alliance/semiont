package semionttest

// A storage several contexts share, for tests of what one context does when
// another writes: each context is a handle on the same stored values, and
// hears what the others write, never what it wrote itself. That is how two
// windows on one browser storage, and two processes on one file, see each
// other.

import (
	"sync"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
)

type sharedValues struct {
	mu     sync.Mutex
	stored map[string]string
	// listeners is each listener, with the context it listens from.
	listeners     map[int]sharedListener
	contexts      int
	subscriptions int
}

type sharedListener struct {
	context  int
	onChange func(key, value string, has bool)
}

// SharedStorage is one context's handle on a storage several share: see the
// file's documentation.
type SharedStorage struct {
	shared  *sharedValues
	context int
}

var _ semiont.SessionStorage = (*SharedStorage)(nil)

// NewSharedStorage is a storage holding nothing, and its first context.
func NewSharedStorage() *SharedStorage {
	return &SharedStorage{shared: &sharedValues{stored: map[string]string{}, listeners: map[int]sharedListener{}}}
}

// Context is another context's handle on the same storage.
func (s *SharedStorage) Context() *SharedStorage {
	s.shared.mu.Lock()
	defer s.shared.mu.Unlock()
	s.shared.contexts++
	return &SharedStorage{shared: s.shared, context: s.shared.contexts}
}

// tell tells the other contexts' listeners of a change, with nothing locked.
func (s *SharedStorage) tell(key, value string, has bool) {
	s.shared.mu.Lock()
	var others []func(key, value string, has bool)
	for _, listener := range s.shared.listeners {
		if listener.context != s.context {
			others = append(others, listener.onChange)
		}
	}
	s.shared.mu.Unlock()
	for _, heard := range others {
		heard(key, value, has)
	}
}

func (s *SharedStorage) Get(key string) (string, bool) {
	s.shared.mu.Lock()
	defer s.shared.mu.Unlock()
	value, ok := s.shared.stored[key]
	return value, ok
}

func (s *SharedStorage) Set(key, value string) error {
	s.shared.mu.Lock()
	s.shared.stored[key] = value
	s.shared.mu.Unlock()
	s.tell(key, value, true)
	return nil
}

func (s *SharedStorage) Delete(key string) {
	s.shared.mu.Lock()
	delete(s.shared.stored, key)
	s.shared.mu.Unlock()
	s.tell(key, "", false)
}

func (s *SharedStorage) Update(key string, change func(stored string, has bool) (string, bool)) error {
	s.shared.mu.Lock()
	stored, has := s.shared.stored[key]
	next, keep := change(stored, has)
	if keep {
		s.shared.stored[key] = next
	} else {
		delete(s.shared.stored, key)
	}
	s.shared.mu.Unlock()
	s.tell(key, next, keep)
	return nil
}

func (s *SharedStorage) Subscribe(onChange func(key, value string, has bool)) (func(), bool) {
	s.shared.mu.Lock()
	s.shared.subscriptions++
	subscription := s.shared.subscriptions
	s.shared.listeners[subscription] = sharedListener{context: s.context, onChange: onChange}
	s.shared.mu.Unlock()
	return func() {
		s.shared.mu.Lock()
		defer s.shared.mu.Unlock()
		delete(s.shared.listeners, subscription)
	}, true
}
