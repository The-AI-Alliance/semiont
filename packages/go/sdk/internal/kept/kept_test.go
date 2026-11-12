package kept_test

import (
	"fmt"
	"slices"
	"testing"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/internal/kept"
)

// The first listener is told, of what was reported before it listened, the
// latest ErrorsKeptForFirstReaderCount, in order, and then what follows; a
// later listener is told only what follows it.
func TestTheFirstListenerIsToldTheLatestReportedBeforeItAndALaterOneOnlyWhatFollows(t *testing.T) {
	most := semiont.DefaultTiming().ErrorsKeptForFirstReaderCount
	telling := kept.NewTelling[string](most)
	beyond := 5
	reported := make([]string, most+beyond)
	for n := range reported {
		reported[n] = telling.Report(fmt.Sprintf("failure %d", n))
	}

	var first, later []string
	stopFirst := telling.Listen(func(item string) { first = append(first, item) })
	stopLater := telling.Listen(func(item string) { later = append(later, item) })
	telling.Report("after both")
	stopFirst()
	stopLater()
	telling.Report("after both stopped")

	if want := append(slices.Clone(reported[beyond:]), "after both"); !slices.Equal(first, want) {
		t.Errorf("the first listener was told %d, want the latest %d reported before it, in order, and what followed", len(first), most)
	}
	if want := []string{"after both"}; !slices.Equal(later, want) {
		t.Errorf("a later listener was told %v, want %v", later, want)
	}
}

// A first listener who comes after the close is told nothing: what was kept
// for it was let go of at the close.
func TestAFirstListenerWhoComesAfterTheCloseIsToldNothing(t *testing.T) {
	telling := kept.NewTelling[string](semiont.DefaultTiming().ErrorsKeptForFirstReaderCount)
	telling.Report("HTTP 503")
	telling.Close()
	telling.Report("after the close")

	var told []string
	stop := telling.Listen(func(item string) { told = append(told, item) })
	stop()

	if len(told) != 0 {
		t.Errorf("a first listener after the close was told %v, want nothing", told)
	}
}
