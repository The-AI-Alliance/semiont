// Package protocol is what the Go SDK's conformance drivers share
// (tests/conformance/sdk/README.md, § The driver protocol): a driver is a
// process that reads one operation per line on stdin and writes what it did,
// and what it saw, one line at a time on stdout.
package protocol

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
)

// Arguments is an operation's arguments, by name.
type Arguments map[string]json.RawMessage

// Misuse is an operation the suite asked that the driver cannot act on: the
// suite's mistake, never the SDK's.
type Misuse struct{ Why string }

func (m *Misuse) Error() string { return m.Why }

// Misused is a Misuse saying why.
func Misused(format string, args ...any) error { return &Misuse{Why: fmt.Sprintf(format, args...)} }

var out struct {
	mu      sync.Mutex
	encoder *json.Encoder
}

func init() { out.encoder = json.NewEncoder(os.Stdout) }

// Say writes one line of the protocol.
func Say(line any) {
	out.mu.Lock()
	defer out.mu.Unlock()
	if err := out.encoder.Encode(line); err != nil {
		fmt.Fprintln(os.Stderr, err)
	}
}

// Failure is a failure as the protocol carries it: the SDK's code, a
// server's status, and a job failure's class, each where there is one.
func Failure(err semiont.Error) map[string]any {
	failure := map[string]any{"code": err.ErrorCode(), "detail": err.Error()}
	if status, ok := err.Status(); ok {
		failure["status"] = status
	}
	var job *semiont.JobError
	if errors.As(err, &job) && job.FailureClass != nil {
		failure["failureClass"] = *job.FailureClass
	}
	return failure
}

// Text is the argument name, a string.
func Text(args Arguments, name string) (string, error) {
	var text string
	if raw, ok := args[name]; !ok || json.Unmarshal(raw, &text) != nil {
		return "", Misused("%s must be a string", name)
	}
	return text, nil
}

// OptionalText is the argument name, a string when it is given; ok is false
// when it is not.
func OptionalText(args Arguments, name string) (text string, ok bool, err error) {
	if _, given := args[name]; !given {
		return "", false, nil
	}
	text, err = Text(args, name)
	return text, err == nil, err
}

// Texts is the argument name, a list of strings.
func Texts(args Arguments, name string) ([]string, error) {
	var texts []string
	if raw, ok := args[name]; !ok || json.Unmarshal(raw, &texts) != nil {
		return nil, Misused("%s must be a list of strings", name)
	}
	return texts, nil
}

// Count is the argument name, a whole number.
func Count(args Arguments, name string) (uint64, error) {
	var count uint64
	if raw, ok := args[name]; !ok || json.Unmarshal(raw, &count) != nil {
		return 0, Misused("%s must be a whole number", name)
	}
	return count, nil
}

// Object is the argument name, a JSON object, its numbers kept as written.
func Object(args Arguments, name string) (map[string]any, error) {
	raw, ok := args[name]
	if !ok {
		return nil, Misused("%s must be an object", name)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var object map[string]any
	if decoder.Decode(&object) != nil || object == nil {
		return nil, Misused("%s must be an object", name)
	}
	return object, nil
}

// Driver is what a driver can be asked, and how it does each.
type Driver interface {
	// Operations is the operations this driver has. Any other is answered
	// unsupported.
	Operations() []string
	// Run runs the operation op, which the suite numbered id. Its context is
	// cancelled when the suite abandons it.
	Run(ctx context.Context, id uint64, op string, args Arguments) (any, error)
	// Finish is the driver's input ended: dispose of what it holds, and wait
	// for whatever is left to say to have been said.
	Finish()
}

// running is the operations still running, each by the id the suite gave it:
// what an operation is abandoned through.
type running struct {
	mu      sync.Mutex
	cancels map[uint64]context.CancelFunc
	// abandoned is the operations the suite abandoned.
	abandoned map[uint64]bool
}

// Abandon abandons the operation id, as its caller would; false when none by
// that id is unsettled.
func (r *running) Abandon(id uint64) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	cancel, ok := r.cancels[id]
	if ok {
		r.abandoned[id] = true
		cancel()
	}
	return ok
}

// Abandoner abandons an operation by its id.
type Abandoner interface{ Abandon(id uint64) bool }

// Serve is driver, until stdin ends: it says it is ready, runs each operation
// as it arrives, and answers each once it ends. makeDriver is given what
// abandons an operation.
func Serve(makeDriver func(Abandoner) Driver) {
	ops := &running{cancels: map[uint64]context.CancelFunc{}, abandoned: map[uint64]bool{}}
	driver := makeDriver(ops)
	has := map[string]bool{}
	for _, op := range driver.Operations() {
		has[op] = true
	}
	Say(map[string]bool{"ready": true})

	var operations sync.WaitGroup
	in := bufio.NewScanner(os.Stdin)
	// An upload carries its bytes in its line, as base64.
	in.Buffer(make([]byte, 0, 1<<20), 256<<20)
	for in.Scan() {
		var line map[string]json.RawMessage
		if json.Unmarshal(in.Bytes(), &line) != nil {
			fmt.Fprintf(os.Stderr, "a line that is not an operation: %s\n", in.Bytes())
			continue
		}
		var id uint64
		var op string
		if json.Unmarshal(line["id"], &id) != nil || json.Unmarshal(line["op"], &op) != nil {
			fmt.Fprintf(os.Stderr, "an operation with no id or no op: %s\n", in.Bytes())
			continue
		}
		delete(line, "id")
		delete(line, "op")
		if !has[op] {
			// Said at once, before the next operation is read.
			Say(map[string]any{"id": id, "unsupported": true})
			continue
		}
		// Abandonable before the next line is read: an abandon that follows
		// it finds it.
		ctx, cancel := context.WithCancel(context.Background())
		ops.mu.Lock()
		ops.cancels[id] = cancel
		ops.mu.Unlock()
		operations.Add(1)
		go func() {
			defer operations.Done()
			value, err := driver.Run(ctx, id, op, Arguments(line))
			ops.mu.Lock()
			abandoned := ops.abandoned[id]
			delete(ops.cancels, id)
			delete(ops.abandoned, id)
			ops.mu.Unlock()
			cancel()
			answer(id, value, err, abandoned)
		}()
	}
	if err := in.Err(); err != nil {
		fmt.Fprintln(os.Stderr, err)
	}
	driver.Finish()
	operations.Wait()
}

// answer answers the operation id, once.
func answer(id uint64, value any, err error, abandoned bool) {
	var misuse *Misuse
	var failed semiont.Error
	switch {
	case err == nil:
		Say(map[string]any{"id": id, "ok": value})
	case abandoned && errors.Is(err, context.Canceled):
		// The suite abandoned it, and the SDK reported nothing else.
		Say(map[string]any{"id": id, "abandoned": true})
	case errors.As(err, &misuse):
		Say(map[string]any{"id": id, "misuse": misuse.Why})
	case errors.As(err, &failed):
		Say(map[string]any{"id": id, "error": Failure(failed)})
	default:
		Say(map[string]any{"id": id, "misuse": fmt.Sprintf("the SDK returned an error that is no failure of its vocabularies: %v", err)})
	}
}
