package kept_test

import (
	"fmt"
	"slices"
	"testing"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/internal/kept"
)

// The first reader of a stream is given, of what was reported before it read,
// the latest ErrorsKeptForFirstReaderCount, in order, and then everything
// that follows, however far behind it falls; a later reader is given
// everything reported from when it reads.
func TestTheFirstReaderIsGivenTheLatestReportedBeforeItAndEveryReaderEverythingThatFollows(t *testing.T) {
	most := semiont.DefaultTiming().ErrorsKeptForFirstReaderCount
	stream := kept.NewStream[string](most)
	beyond := 5
	before := make([]string, most+beyond)
	for n := range before {
		before[n] = stream.Report(fmt.Sprintf("before %d", n))
	}

	first, later := stream.Reported(nil), stream.Reported(nil)
	after := make([]string, most+beyond)
	for n := range after {
		after[n] = stream.Report(fmt.Sprintf("after %d", n))
	}
	stream.Close()
	stream.Report("after the close")

	if heard, want := slices.Collect(first), append(slices.Clone(before[beyond:]), after...); !slices.Equal(heard, want) {
		t.Errorf("the first reader was given %d, want the latest %d reported before it, in order, and all %d after", len(heard), most, len(after))
	}
	if heard := slices.Collect(later); !slices.Equal(heard, after) {
		t.Errorf("a later reader was given %d, want all %d reported after it read, in order", len(heard), len(after))
	}
}

// A reader whose stop closes while it waits is let go of: it is given
// nothing more.
func TestAReaderWhoseStopClosesWhileItWaitsIsLetGoOf(t *testing.T) {
	stream := kept.NewStream[string](semiont.DefaultTiming().ErrorsKeptForFirstReaderCount)
	defer stream.Close()
	stop := make(chan struct{})
	reading := stream.Reported(stop)
	close(stop)

	if heard := slices.Collect(reading); len(heard) != 0 {
		t.Errorf("a reader whose stop closed while it waited was given %v, want nothing", heard)
	}
	stream.Report("after the stop")
	if heard := slices.Collect(reading); len(heard) != 0 {
		t.Errorf("a reader let go of was given %v, want nothing", heard)
	}
}

// A first reader who comes after the close is given nothing: what was kept
// for it was let go of at the close.
func TestAFirstReaderWhoComesAfterTheStreamClosedIsGivenNothing(t *testing.T) {
	stream := kept.NewStream[string](semiont.DefaultTiming().ErrorsKeptForFirstReaderCount)
	stream.Report("HTTP 503")
	stream.Close()

	if heard := slices.Collect(stream.Reported(nil)); len(heard) != 0 {
		t.Errorf("a first reader after the close was given %v, want nothing", heard)
	}
}
