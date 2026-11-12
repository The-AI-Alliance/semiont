package registry

// What a registry keeps of what it says before anyone reads its errors.
// Nothing from outside makes it say many of its own with nobody reading, so
// these say them themselves.

import (
	"context"
	"fmt"
	"slices"
	"testing"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
)

// noSessions is the factory of a registry with no knowledge bases, which asks
// it for none.
type noSessions struct{}

func (noSessions) Session(context.Context, SessionFactoryOptions) (*semiont.Session, func(), error) {
	panic("a registry with no knowledge bases asks for no session")
}

func (noSessions) Revoke(context.Context, StoredSession) {}

// unread is a registry with no knowledge bases, so it brings up no session.
func unread(t *testing.T) *SemiontBrowser {
	t.Helper()
	b, err := NewSemiontBrowser(SemiontBrowserConfig{Storage: semiont.NewMemoryStorage(), SessionFactory: noSessions{}})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func failure(n int) *semiont.SessionError {
	return &semiont.SessionError{Code: semiont.SessionErrorCodeConstructFailed, Message: fmt.Sprintf("failure %d", n), KbID: "kb-a"}
}

// Of what a registry says before anyone reads its errors, its first reader is
// given the latest ErrorsKeptForFirstReaderCount, in order.
func TestARegistryNobodyHasReadKeepsTheLatestOfWhatItSaysForItsFirstReader(t *testing.T) {
	b := unread(t)
	beyond := 5
	said := make([]*semiont.SessionError, semiont.DefaultTiming().ErrorsKeptForFirstReaderCount+beyond)
	for n := range said {
		said[n] = failure(n)
		b.failed(said[n])
	}
	errs := b.Errors(context.Background())
	if err := b.Close(); err != nil {
		t.Fatal(err)
	}

	var heard []*semiont.SessionError
	for err := range errs {
		heard = append(heard, err)
	}
	if !slices.Equal(heard, said[beyond:]) {
		t.Errorf("the first reader heard %d errors, want the latest %d said, in order", len(heard), len(said)-beyond)
	}
}

// A first reader who comes after the registry has closed hears nothing: what
// was kept for it was let go of at the close.
func TestAFirstReaderWhoComesAfterTheRegistryHasClosedHearsNothing(t *testing.T) {
	b := unread(t)
	b.failed(failure(0))
	if err := b.Close(); err != nil {
		t.Fatal(err)
	}

	var heard []*semiont.SessionError
	for err := range b.Errors(context.Background()) {
		heard = append(heard, err)
	}
	if len(heard) != 0 {
		t.Errorf("a first reader after the close heard %v, want nothing", heard)
	}
}
