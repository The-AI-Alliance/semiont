package semiont

import (
	"encoding/json"
	"fmt"
	"slices"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

func numbered(channel bus.Channel, n int) Frame {
	return Frame{Channel: channel, Payload: json.RawMessage(fmt.Sprintf(`{"n":%d}`, n))}
}

// A job's progress and its completion are two channels; a follower reading
// them must read the progress first, as it was delivered.
func TestOneListenerOfSeveralChannelsHearsThemInTheOrderDelivered(t *testing.T) {
	hub := NewFrameHub()
	frames := hub.Frames("job:report-progress", "job:complete")
	for n, channel := range []bus.Channel{"job:report-progress", "job:complete", "job:report-progress", "job:fail", "job:complete"} {
		hub.Deliver(numbered(channel, n))
	}
	hub.Close()
	var got []string
	for frame := range frames {
		got = append(got, string(frame.Payload))
	}
	want := []string{`{"n":0}`, `{"n":1}`, `{"n":2}`, `{"n":4}`}
	if !slices.Equal(got, want) {
		t.Fatalf("heard %v, want %v: the frames of its channels, in the order delivered, and no other", got, want)
	}
}

func TestALoopThatStopsLetsGoOfEveryChannelItListenedTo(t *testing.T) {
	hub := NewFrameHub()
	frames := hub.Frames("job:report-progress", "job:complete")
	hub.Deliver(numbered("job:complete", 0))
	for range frames {
		break
	}
	for _, channel := range []bus.Channel{"job:report-progress", "job:complete"} {
		if listening := hub.channels[channel].give(numbered(channel, 1)); listening != 0 {
			t.Errorf("%s still has %d listener(s) after the loop stopped", channel, listening)
		}
	}
}
