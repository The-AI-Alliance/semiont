package semiont

// The stream's framing (docs/protocol/TRANSPORT-HTTP.md § Wire framing and
// client parser obligations): text/event-stream, each event an `event` line,
// an `id` line and one `data` line, ended by a blank line.
//
// The parser holds its state across reads. One event can span many reads of
// the connection, and a read can end anywhere: inside a line, between a line
// and its blank line, inside a character. So it keeps bytes until a line is
// whole and decodes a line only then.

import (
	"bytes"
	"strings"
)

// sseEvent is one event of the stream. hasID tells an event with an empty
// `id:` from one with none.
type sseEvent struct {
	event string
	id    string
	hasID bool
	data  string
}

type sseParser struct {
	// line holds the bytes of the line not yet ended.
	line    []byte
	event   string
	id      string
	hasID   bool
	data    strings.Builder
	hasData bool
}

// feed takes the next bytes read and gives the events they complete.
func (p *sseParser) feed(read []byte) []sseEvent {
	var events []sseEvent
	for {
		end := bytes.IndexByte(read, '\n')
		if end < 0 {
			p.line = append(p.line, read...)
			return events
		}
		p.line = append(p.line, read[:end]...)
		read = read[end+1:]
		line := string(p.line)
		p.line = p.line[:0]
		if event, ok := p.lineEnded(line); ok {
			events = append(events, event)
		}
	}
}

func (p *sseParser) lineEnded(line string) (sseEvent, bool) {
	line = strings.TrimSuffix(line, "\r")
	if line == "" {
		event := sseEvent{event: p.event, id: p.id, hasID: p.hasID, data: p.data.String()}
		p.event, p.id, p.hasID, p.hasData = "", "", false, false
		p.data.Reset()
		return event, event.event != "" || event.data != "" || event.hasID
	}
	field, value, _ := strings.Cut(line, ":")
	value = strings.TrimPrefix(value, " ")
	switch field {
	case "event":
		p.event = value
	case "id":
		p.id, p.hasID = value, true
	case "data":
		if p.hasData {
			p.data.WriteByte('\n')
		}
		p.data.WriteString(value)
		p.hasData = true
	}
	return sseEvent{}, false
}
