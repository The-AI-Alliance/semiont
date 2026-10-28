package semiont

import (
	"reflect"
	"strings"
	"testing"
)

const sseStream = "event: bus-event\nid: e-beckon:focus:1\ndata: {\"channel\":\"beckon:focus\",\"payload\":{\"resourceId\":\"res-1\",\"annotationId\":\"naïve — 日本語 😀\"}}\n\nevent: ping\ndata:\n\nevent: bus-event\nid: p-res-1-2\ndata: {\"channel\":\"mark:added\",\"payload\":{},\"scope\":\"res-1\"}\n\n"

func wholeStream() []sseEvent {
	var p sseParser
	return p.feed([]byte(sseStream))
}

func TestAStreamReadAtOnceGivesItsEvents(t *testing.T) {
	events := wholeStream()
	if len(events) != 3 {
		t.Fatalf("%d events, want 3: %+v", len(events), events)
	}
	if events[0].event != "bus-event" || events[0].id != "e-beckon:focus:1" || !strings.Contains(events[0].data, "naïve — 日本語 😀") {
		t.Errorf("the first event is %+v", events[0])
	}
	if want := (sseEvent{event: "ping"}); events[1] != want {
		t.Errorf("the heartbeat is %+v, want %+v", events[1], want)
	}
	if events[2].id != "p-res-1-2" {
		t.Errorf("the third event's id is %q", events[2].id)
	}
}

// However the reads fall, the events are the same: every split point, and
// every size of read down to a byte, which splits lines, blank lines and
// characters.
func TestTheEventsDoNotDependOnWhereTheReadsFall(t *testing.T) {
	whole := wholeStream()
	b := []byte(sseStream)
	for split := 0; split <= len(b); split++ {
		var p sseParser
		events := append(p.feed(b[:split]), p.feed(b[split:])...)
		if !reflect.DeepEqual(events, whole) {
			t.Fatalf("split at %d: %+v", split, events)
		}
	}
	for size := 1; size <= 7; size++ {
		var p sseParser
		var events []sseEvent
		for at := 0; at < len(b); at += size {
			end := min(at+size, len(b))
			events = append(events, p.feed(b[at:end])...)
		}
		if !reflect.DeepEqual(events, whole) {
			t.Fatalf("reads of %d: %+v", size, events)
		}
	}
}

func TestACarriageReturnBeforeTheNewlineIsNotPartOfTheLine(t *testing.T) {
	var p sseParser
	events := p.feed([]byte("event: bus-event\r\ndata: {}\r\n\r\n"))
	want := []sseEvent{{event: "bus-event", data: "{}"}}
	if !reflect.DeepEqual(events, want) {
		t.Errorf("%+v, want %+v", events, want)
	}
}
