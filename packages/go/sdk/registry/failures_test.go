package registry

// What a registry keeps of what it says before anyone reads its errors, and
// what it gives a reader who falls behind. Nothing from outside makes it say
// many of its own while nobody reads, so these say them themselves.

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

// Each reader of a registry's errors hears everything said from when it
// reads, in order, however far behind it falls.
func TestEachReaderOfARegistrysErrorsHearsEverythingSaidFromWhenItReadsHoweverFarBehindItFalls(t *testing.T) {
	b := unread(t)
	first, later := b.Errors(context.Background()), b.Errors(context.Background())
	said := make([]*semiont.SessionError, semiont.DefaultTiming().ErrorsKeptForFirstReaderCount+5)
	for n := range said {
		said[n] = failure(n)
		b.failed(said[n])
	}
	if err := b.Close(); err != nil {
		t.Fatal(err)
	}

	if heard := slices.Collect(first); !slices.Equal(heard, said) {
		t.Errorf("the first reader heard %d errors, want all %d said after it read, in order", len(heard), len(said))
	}
	if heard := slices.Collect(later); !slices.Equal(heard, said) {
		t.Errorf("a later reader heard %d errors, want all %d said after it read, in order", len(heard), len(said))
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
