package launcher

// control.go — `semiont control`: the launcher's control API, for Desktop.
//
// JSON-RPC 2.0, one message per line, requests on stdin and answers on
// stdout (protocol/contract/LAUNCHER-CONTROL.md). Every method is one of the
// launcher's commands, run by the same code the command runs, with the
// request's UI saying its lines as the request's progress. The methods, their
// schemas and the notifications are protocol/specs/src/control's, generated
// into control_types_gen.go and control_schemas_gen.go.
//
// stdout is the protocol's alone: the process's os.Stdout and os.Stderr are
// pipes while it serves, and what an operation prints to either is its
// request's output progress, or, between requests, a diagnostic on the real
// stderr. stdin is the protocol's too: an operation that would ask a person
// reads end of file (os.Stdin is the null device), and takes what the command
// line takes when nobody answers.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
)

const controlUsage = `Usage: semiont control

Serve the launcher's control API on stdin and stdout: JSON-RPC 2.0, one
message per line. It is for a program, Desktop, that drives the launcher the
way a person drives its commands; protocol/contract/LAUNCHER-CONTROL.md is its
contract. It serves until stdin ends, then waits for every request in flight
to end, and exits.
`

// JSON-RPC 2.0's own error codes, and the one this API gives an operation's
// failure, whose data names the reason.
const (
	rpcParseError     = -32700
	rpcInvalidRequest = -32600
	rpcMethodNotFound = -32601
	rpcInvalidParams  = -32602
	rpcInternalError  = -32603
	rpcOperationError = -32000
)

// controlMethod and controlNotification: a row of the tables
// control_schemas_gen.go generates from protocol/specs/src/control/methods.json.
type controlMethod struct {
	name, params, result string
	exclusive            bool
	sends                []string
}

type controlNotification struct {
	name, from, params string
}

// Control implements `semiont control`.
func Control(args []string) int {
	for _, a := range args {
		switch a {
		case "--help", "-h":
			fmt.Print(controlUsage)
			return 0
		default:
			NewUI(false).Fail("Unknown argument: %s", a)
			return 1
		}
	}
	schemas, err := compileControlSchemas()
	if err != nil {
		fmt.Fprintf(os.Stderr, "✗ The control API's schemas do not compile: %v\n", err)
		return 1
	}
	s, err := newControlServer(os.Stdout, os.Stderr, schemas)
	if err != nil {
		fmt.Fprintf(os.Stderr, "✗ %v\n", err)
		return 1
	}
	in := os.Stdin
	null, err := os.Open(os.DevNull)
	if err != nil {
		fmt.Fprintf(os.Stderr, "✗ %v\n", err)
		return 1
	}
	os.Stdin = null
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	return s.serve(ctx, in)
}

// controlServer serves one client.
type controlServer struct {
	protocol io.Writer // the real stdout
	diag     io.Writer // the real stderr
	schemas  *controlSchemas
	turns    turnstile
	// home: the directory the server was started in, where a request that
	// names no target is resolved. A start enters its root; each turn ends
	// back here.
	home string

	writeMu sync.Mutex

	mu       sync.Mutex
	inFlight map[string]*controlRequest
	current  *controlRequest // the exclusive request whose turn it is, which owns what is printed
	handlers sync.WaitGroup
	// handlerFor lets tests exercise request validation and response framing
	// without running commands that can mutate a machine or need a live stack.
	handlerFor func(string) controlHandler
	// drainOutput is the production output-marker barrier. Tests that exercise
	// request handlers without the captured stdout/stderr pipes can replace it.
	drainOutput func()

	// drained: what the output readers signal when they read a turn's end
	// marker, by marker.
	drainMu sync.Mutex
	drained map[string]chan struct{}
	marks   int
}

// controlRequest: one request in flight.
type controlRequest struct {
	id     json.RawMessage
	key    string
	method controlMethod
	params json.RawMessage
	ctx    context.Context
	cancel context.CancelFunc
	turn   *turn
	server *controlServer
	// answered: guarded by server.mu.
	answered bool
}

func newControlServer(protocol, diag *os.File, schemas *controlSchemas) (*controlServer, error) {
	home, err := os.Getwd()
	if err != nil {
		return nil, fmt.Errorf("cannot read the directory the control server is started in: %v", err)
	}
	s := &controlServer{protocol: protocol, diag: diag, schemas: schemas, home: home,
		inFlight: map[string]*controlRequest{}, drained: map[string]chan struct{}{}}
	for _, std := range []**os.File{&os.Stdout, &os.Stderr} {
		r, w, err := os.Pipe()
		if err != nil {
			return nil, fmt.Errorf("cannot capture what operations print: %v", err)
		}
		*std = w
		go s.carry(r)
	}
	return s, nil
}

// carry reads what operations print, a line at a time: the request whose
// turn it is gets each as output progress; between requests it is a
// diagnostic.
func (s *controlServer) carry(r io.Reader) {
	lines := bufio.NewReader(r)
	for {
		line, err := lines.ReadString('\n')
		line = strings.TrimRight(line, "\r\n")
		if mark, ok := strings.CutPrefix(line, controlTurnMark); ok {
			s.drainMu.Lock()
			if done := s.drained[mark]; done != nil {
				close(done)
				delete(s.drained, mark)
			}
			s.drainMu.Unlock()
		} else if line != "" || err == nil {
			s.mu.Lock()
			current := s.current
			s.mu.Unlock()
			if current != nil {
				current.progress("output", line)
			} else {
				fmt.Fprintln(s.diag, scrubSecrets(line))
			}
		}
		if err != nil {
			return
		}
	}
}

// controlTurnMark begins the line that marks the end of a turn's output in
// each captured stream.
const controlTurnMark = "\x00semiont-control-turn "

// drain waits until everything printed before it has been carried: a mark
// written to each captured stream comes out after all of it.
func (s *controlServer) drain() {
	if s.drainOutput != nil {
		s.drainOutput()
		return
	}
	var waits []chan struct{}
	for _, w := range []*os.File{os.Stdout, os.Stderr} {
		s.drainMu.Lock()
		s.marks++
		mark := strconv.Itoa(s.marks)
		done := make(chan struct{})
		s.drained[mark] = done
		s.drainMu.Unlock()
		fmt.Fprintln(w, controlTurnMark+mark)
		waits = append(waits, done)
	}
	for _, done := range waits {
		<-done
	}
}

// serve reads requests until in ends or ctx is done, then cancels each request
// in flight and waits for every one to end.
func (s *controlServer) serve(ctx context.Context, in io.Reader) int {
	lines := make(chan []byte)
	readErr := make(chan error, 1)
	go func() {
		r := bufio.NewReader(in)
		for {
			line, err := r.ReadBytes('\n')
			if len(bytes.TrimSpace(line)) > 0 {
				lines <- line
			}
			if err != nil {
				if errors.Is(err, io.EOF) {
					err = nil
				}
				readErr <- err
				return
			}
		}
	}()
	code := 0
loop:
	for {
		select {
		case line := <-lines:
			s.receive(line)
		case err := <-readErr:
			if err != nil {
				fmt.Fprintf(s.diag, "✗ reading the control stream: %v\n", err)
				code = 1
			}
			break loop
		case <-ctx.Done():
			break loop
		}
	}
	s.mu.Lock()
	for _, req := range s.inFlight {
		req.cancel()
	}
	s.mu.Unlock()
	s.handlers.Wait()
	return code
}

// rpcMessage: a JSON-RPC message as it is read. A member JSON-RPC does not
// define makes the message invalid.
type rpcMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  *string         `json:"method"`
	Params  json.RawMessage `json:"params"`
}

// receive reads one line: a request, which it answers or hands to a handler,
// or a notification from the client.
func (s *controlServer) receive(line []byte) {
	trimmed := bytes.TrimSpace(line)
	if trimmed[0] == '[' {
		s.reply(nil, nil, &rpcError{Code: rpcInvalidRequest, Message: "this API takes no batches: send each request on its own line"})
		return
	}
	var msg rpcMessage
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&msg); err != nil {
		var unknown *json.UnmarshalTypeError
		if errors.As(err, &unknown) || strings.HasPrefix(err.Error(), "json: unknown field") {
			s.reply(nil, nil, &rpcError{Code: rpcInvalidRequest, Message: "not a JSON-RPC request: " + err.Error()})
			return
		}
		s.reply(nil, nil, &rpcError{Code: rpcParseError, Message: "not JSON: " + err.Error()})
		return
	}
	if decoder.More() {
		s.reply(nil, nil, &rpcError{Code: rpcParseError, Message: "more than one JSON value on a line"})
		return
	}
	if msg.JSONRPC != "2.0" || msg.Method == nil || *msg.Method == "" {
		s.reply(nil, nil, &rpcError{Code: rpcInvalidRequest, Message: `a request states "jsonrpc": "2.0" and a method`})
		return
	}
	if msg.ID == nil {
		s.notified(*msg.Method, msg.Params)
		return
	}
	key, ok := requestKey(msg.ID)
	if !ok {
		s.reply(nil, nil, &rpcError{Code: rpcInvalidRequest, Message: "a request's id is a string or an integer"})
		return
	}
	method, known := controlMethodNamed(*msg.Method)
	if !known {
		s.reply(msg.ID, nil, &rpcError{Code: rpcMethodNotFound, Message: fmt.Sprintf("no method %q: see protocol/specs/src/control/methods.json", *msg.Method)})
		return
	}
	if failure := s.schemas.checkParams(method, msg.Params); failure != nil {
		s.reply(msg.ID, nil, failure.rpc())
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	req := &controlRequest{id: msg.ID, key: key, method: method, params: msg.Params, ctx: ctx, cancel: cancel, server: s}
	s.mu.Lock()
	if _, busy := s.inFlight[key]; busy {
		s.mu.Unlock()
		cancel()
		s.reply(msg.ID, nil, &rpcError{Code: rpcInvalidRequest, Message: "a request with this id is in flight"})
		return
	}
	s.inFlight[key] = req
	s.mu.Unlock()
	if method.exclusive {
		req.turn = s.turns.take()
	}
	s.handlers.Add(1)
	go s.run(req)
}

// requestKey: an id as this server tells ids apart, and whether it is one: a
// string, or an integer. JSON-RPC allows null and fractions; this API does
// not, so an id always names one request.
func requestKey(id json.RawMessage) (string, bool) {
	var str string
	if json.Unmarshal(id, &str) == nil {
		return "s:" + str, true
	}
	text := string(bytes.TrimSpace(id))
	if _, err := strconv.ParseInt(text, 10, 64); err == nil {
		return "n:" + text, true
	}
	return "", false
}

func controlMethodNamed(name string) (controlMethod, bool) {
	for _, m := range controlMethods {
		if m.name == name {
			return m, true
		}
	}
	return controlMethod{}, false
}

// notified handles a notification from the client: a cancellation. Any other
// is no notification of this API, and, as JSON-RPC has it, unanswered.
func (s *controlServer) notified(method string, params json.RawMessage) {
	if method != "notifications/cancelled" {
		fmt.Fprintf(s.diag, "control: ignored the notification %q, which the client does not send in this API\n", method)
		return
	}
	if failure := s.schemas.check(controlNotificationSchema(method), params); failure != nil {
		fmt.Fprintf(s.diag, "control: ignored a cancellation whose params are not Cancelled's: %s\n", failure.message)
		return
	}
	var cancelled ControlCancelled
	if err := json.Unmarshal(params, &cancelled); err != nil {
		fmt.Fprintf(s.diag, "control: ignored a cancellation: %v\n", err)
		return
	}
	key, ok := requestKey(cancelled.RequestId)
	if !ok {
		return
	}
	s.mu.Lock()
	req := s.inFlight[key]
	s.mu.Unlock()
	if req != nil {
		req.cancel()
	}
}

func controlNotificationSchema(name string) string {
	for _, n := range controlNotifications {
		if n.name == name {
			return n.params
		}
	}
	panic("no notification " + name + " in protocol/specs/src/control/methods.json")
}

// run handles req in its turn, and answers it: with what its operation
// returns, or, cancelled first, with control.cancelled. An operation that
// cannot stop when cancelled goes on to its end holding its turn, and its
// answer is not sent.
func (s *controlServer) run(req *controlRequest) {
	defer s.handlers.Done()
	if req.turn != nil {
		select {
		case <-req.turn.ready:
		case <-req.ctx.Done():
			s.turns.abandon(req.turn)
			s.answer(req, nil, cancelledFailure(req))
			return
		}
		s.mu.Lock()
		s.current = req
		s.mu.Unlock()
	}
	answered := make(chan struct{})
	go func() {
		defer close(answered)
		result, failure := req.operate()
		if req.turn != nil {
			// Its output, all of it carried, comes before its answer.
			s.drain()
		}
		s.answer(req, result, failure)
	}()
	select {
	case <-answered:
	case <-req.ctx.Done():
		s.answer(req, nil, cancelledFailure(req))
		<-answered
	}
	req.endTurn()
}

// endTurn ends req's turn, once everything it printed has been carried. The
// next exclusive request's turn begins.
func (req *controlRequest) endTurn() {
	if req.turn == nil {
		return
	}
	s := req.server
	if err := os.Chdir(s.home); err != nil {
		fmt.Fprintf(s.diag, "✗ control: cannot return to %s after %s: %v\n", s.home, req.method.name, err)
	}
	s.drain()
	s.mu.Lock()
	if s.current == req {
		s.current = nil
	}
	s.mu.Unlock()
	s.turns.give(req.turn)
	req.turn = nil
}

// cancelledFailure: what a cancelled request is answered with.
func cancelledFailure(req *controlRequest) *controlFailure {
	f := &controlFailure{code: controlCodeCancelled, message: "cancelled by the client"}
	if req.method.name == "stack.start" {
		mayStillRun := true
		f.mayStillRun = &mayStillRun
		f.message = "cancelled by the client: the launcher stopped waiting, and stopped nothing it started"
	}
	return f
}

// answer sends req's one answer, unless it has one.
func (s *controlServer) answer(req *controlRequest, result any, failure *controlFailure) {
	s.mu.Lock()
	if req.answered {
		s.mu.Unlock()
		return
	}
	req.answered = true
	delete(s.inFlight, req.key)
	s.mu.Unlock()
	req.cancel()
	if failure != nil {
		s.reply(req.id, nil, failure.rpc())
		return
	}
	text, err := json.Marshal(result)
	if err == nil {
		if fault := s.schemas.check(req.method.result, text); fault != nil {
			err = fmt.Errorf("its result does not hold to %s: %s", req.method.result, fault.message)
		}
	}
	if err != nil {
		fmt.Fprintf(s.diag, "✗ control: %s: %v\n", req.method.name, err)
		s.reply(req.id, nil, (&controlFailure{code: controlCodeFailed, message: "the launcher could not answer: " + err.Error(), rpcCode: rpcInternalError}).rpc())
		return
	}
	s.reply(req.id, json.RawMessage(text), nil)
}

// rpcError: a JSON-RPC error object.
type rpcError struct {
	Code    int               `json:"code"`
	Message string            `json:"message"`
	Data    *ControlErrorData `json:"data,omitempty"`
}

// reply writes a response: id null for a request whose id could not be read.
func (s *controlServer) reply(id json.RawMessage, result json.RawMessage, failure *rpcError) {
	if id == nil {
		id = json.RawMessage("null")
	}
	response := map[string]any{"jsonrpc": "2.0", "id": id}
	if failure != nil {
		failure.Message = scrubSecrets(failure.Message)
		if failure.Data != nil {
			data, _ := json.Marshal(failure.Data)
			if fault := s.schemas.check(controlErrorDataSchema, data); fault != nil {
				said := fmt.Sprintf("an error's data does not hold to %s: %s", controlErrorDataSchema, fault.message)
				fmt.Fprintf(s.diag, "✗ control: %s\n", said)
				failure = (&controlFailure{code: controlCodeFailed, message: "the launcher could not answer: " + said, rpcCode: rpcInternalError}).rpc()
			}
		}
		response["error"] = failure
	} else {
		response["result"] = result
	}
	s.write(response)
}

// notify sends a notification about req, held to its schema first.
func (s *controlServer) notify(req *controlRequest, method string, params any) {
	text, err := json.Marshal(params)
	if err == nil {
		if fault := s.schemas.check(controlNotificationSchema(method), text); fault != nil {
			err = errors.New(fault.message)
		}
	}
	if err != nil {
		fmt.Fprintf(s.diag, "✗ control: a %s of %s does not hold to its schema, and is not sent: %v\n", method, req.method.name, err)
		return
	}
	s.mu.Lock()
	answered := req.answered
	s.mu.Unlock()
	if answered {
		return
	}
	s.write(map[string]any{"jsonrpc": "2.0", "method": method, "params": json.RawMessage(text)})
}

// write sends one message, a line of its own.
func (s *controlServer) write(message any) {
	text, err := json.Marshal(message)
	if err != nil {
		fmt.Fprintf(s.diag, "✗ control: a message could not be written: %v\n", err)
		return
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if _, err := s.protocol.Write(append(text, '\n')); err != nil {
		fmt.Fprintf(s.diag, "✗ control: writing the control stream: %v\n", err)
	}
}

// progress sends one line of req's progress, as a person would read it,
// without colour and without a secret value the launcher knows.
func (req *controlRequest) progress(kind, text string) {
	req.server.notify(req, "notifications/progress", ControlProgress{RequestId: req.id, Kind: kind, Text: scrubSecrets(stripANSI(text))})
}

// ui: the UI req's operation speaks through, each line its progress.
func (req *controlRequest) ui() *UI {
	return &UI{said: req.progress, refused: &refusal{}}
}

// controlFailure: why an operation failed, as its error states it.
type controlFailure struct {
	code        string
	message     string
	retryable   bool
	choices     []ControlTarget
	fields      []ControlFieldFault
	supported   []string
	mayStillRun *bool
	rpcCode     int // 0: rpcOperationError
}

func (f *controlFailure) rpc() *rpcError {
	code := f.rpcCode
	if code == 0 {
		code = rpcOperationError
	}
	return &rpcError{Code: code, Message: f.message, Data: &ControlErrorData{
		Code: f.code, Retryable: f.retryable, Choices: f.choices, Fields: f.fields,
		Supported: f.supported, MayStillRun: f.mayStillRun,
	}}
}

// failed: the failure of an operation that refused through u, as its first
// refusal says it, under the code it named. A step whose refusals name no
// code (u.Fail) fails under stepCode, the code its method gives that step. An
// operation that failed without refusing at all printed why, if it said
// anything: its message says so.
func failed(u *UI, stepCode string) *controlFailure {
	f := &controlFailure{code: u.refused.code, message: u.refused.message, choices: u.refused.choices}
	if f.code == "" {
		f.code = stepCode
	}
	if f.message == "" {
		f.message = "the operation failed without refusing: its progress is everything it printed"
	}
	f.retryable = retryableCodes[f.code]
	return f
}

// retryableCodes: the failures the same request can get past, sent again
// once something outside it changes.
var retryableCodes = map[string]bool{
	controlCodeStackNotRunning: true, controlCodeStartInProgress: true, controlCodeRuntimeUnavailable: true,
	controlCodeDependencyUnavailable: true, controlCodeUnreachable: true, controlCodeUnreadableState: true,
	controlCodeStackRunning: true, controlCodeSignInFailed: true, controlCodeFailed: true,
}

// stripANSI removes terminal escapes (colour, bold) from a line.
func stripANSI(s string) string {
	if !strings.Contains(s, "\033[") {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\033' && i+1 < len(s) && s[i+1] == '[' {
			j := i + 2
			for j < len(s) && (s[j] < 0x40 || s[j] > 0x7e) {
				j++
			}
			i = j
			continue
		}
		b.WriteByte(s[i])
	}
	return b.String()
}
