package semiont

// The bus log: with SEMIONT_BUS_LOG set, a line on standard error for each
// frame a transport sends or receives, each read of content and each upload.
//
//	[bus EMIT] mark:create-request scope=res-1 cid=a89a670a trace=8f3ca4ed {"resourceId":"res-1"}
//
// Every Semiont SDK writes it, in one form, so that the lines of several
// processes read as one timeline (docs/protocol/EVENT-BUS.md § Wire format). A
// line is what was sent or asked for, written when it is: the frame's
// channel, or `content` for a read or an upload; the resource's scope, the
// first eight characters of the correlation id, and the first eight of the id
// of the trace the line was written in, each where there is one; and the
// payload, as JSON. It goes to standard error, as Rust's does: a program's
// standard output is its own, and a line there would be read as one of its
// answers.
//
// Set is any value that is not empty. The variable is read once, when the
// first line would be written.
//
// No line holds a credential. The value of a member whose whole name is one a
// credential goes by is not written, wherever in a payload it is: [withheld]
// is written in its place, as every bus log writes it
// (specs/src/bus/log-cases.json).

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"

	"go.opentelemetry.io/otel/trace"
)

// withheld is what a line says in place of a credential.
const withheld = "[withheld]"

// credentials is the names of the members whose value is one: the list
// specs/src/bus/log-cases.json states for every bus log, which this package's
// tests hold this one to.
var credentials = map[string]bool{
	"token":          true,
	"cloneToken":     true,
	"accessToken":    true,
	"access_token":   true,
	"refreshToken":   true,
	"refresh_token":  true,
	"apiKey":         true,
	"api_key":        true,
	"clientSecret":   true,
	"client_secret":  true,
	"secret":         true,
	"password":       true,
	"authorization":  true,
	"Authorization":  true,
	"x-api-key":      true,
	"x-goog-api-key": true,
}

// busLogged is whether the bus log is written: what the process's
// environment said when this was first asked.
var busLogged = sync.OnceValue(func() bool { return os.Getenv("SEMIONT_BUS_LOG") != "" })

// busOp is what a line says was done: a frame sent or received, an upload or
// a read of content, or a frame delivered on a connection a handoff retired.
type busOp string

const (
	busEmit   busOp = "EMIT"
	busRecv   busOp = "RECV"
	busPut    busOp = "PUT"
	busGet    busOp = "GET"
	busLinger busOp = "LINGER"
)

// withheldFrom is a decoded payload as a line shows it: as it is, less the value of
// each credential.
func withheldFrom(value any) any {
	switch value := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(value))
		for name, member := range value {
			if credentials[name] {
				out[name] = withheld
			} else {
				out[name] = withheldFrom(member)
			}
		}
		return out
	case []any:
		out := make([]any, len(value))
		for i, item := range value {
			out[i] = withheldFrom(item)
		}
		return out
	}
	return value
}

// shownText is a payload as a line writes it: as JSON, less the value of each
// credential.
func shownText(payload any) (string, error) {
	written, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	decoder := json.NewDecoder(bytes.NewReader(written))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return "", err
	}
	var text bytes.Buffer
	encoder := json.NewEncoder(&text)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(withheldFrom(value)); err != nil {
		return "", err
	}
	return strings.TrimSuffix(text.String(), "\n"), nil
}

// busLine is the line of one frame sent or received, or of one read or upload
// of content, written in ctx's trace.
func busLine(ctx context.Context, op busOp, channel string, payload any, envelope Envelope) string {
	var line strings.Builder
	fmt.Fprintf(&line, "[bus %s] %s", op, channel)
	if !envelope.Scope.IsZero() {
		fmt.Fprintf(&line, " scope=%s", envelope.Scope)
	}
	if id := envelope.CorrelationID; id != "" {
		fmt.Fprintf(&line, " cid=%s", id[:min(8, len(id))])
	}
	if within := trace.SpanContextFromContext(ctx); within.HasTraceID() {
		fmt.Fprintf(&line, " trace=%s", within.TraceID().String()[:8])
	}
	text, err := shownText(payload)
	if err != nil {
		text = fmt.Sprintf("(a payload that is not JSON: %v)", err)
	}
	line.WriteByte(' ')
	line.WriteString(text)
	return line.String()
}

// busLog writes the line of one frame sent or received, or of one read or
// upload of content, when the bus log is written.
func busLog(ctx context.Context, op busOp, channel string, payload any, envelope Envelope) {
	if busLogged() {
		fmt.Fprintln(os.Stderr, busLine(ctx, op, channel, payload, envelope))
	}
}

// busNote writes a line about a channel that is no frame:
// [bus <op>] <channel> <note>.
func busNote(op busOp, channel string, note string) {
	if busLogged() {
		fmt.Fprintf(os.Stderr, "[bus %s] %s %s\n", op, channel, note)
	}
}
