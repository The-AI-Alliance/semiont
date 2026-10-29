package state_test

// The state units against specs/src/client/state-units.json.
//
// Each case of a unit this SDK has is run as the table states it: its units
// are built over a scripted transport, driven step by step, and held to what
// the case says they hold and said. A unit that the names table
// (specs/src/client/surface.json, `stateUnits`) says this SDK lacks has its
// cases left unrun. What the table may say is held by
// scripts/lint/check-state-unit-cases.mjs; what a case cannot say, the axioms,
// each unit's own test holds.
//
// Each case runs in a testing/synctest bubble of its own: a settle is
// synctest.Wait, and a pass moves the bubble's clock.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"iter"
	"maps"
	"os"
	"reflect"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
	"unicode"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/semionttest"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/state"
)

// sdk is this SDK, as the names table's `absent` names it.
const sdk = "go"

// ── The tables ──────────────────────────────────────────────────────────

type stateTable struct {
	Cases    []stateCase    `json:"cases"`
	Fixtures map[string]any `json:"fixtures"`
}

type stateCase struct {
	Unit      string                    `json:"unit"`
	Case      string                    `json:"case"`
	Transport caseTransport             `json:"transport"`
	Made      map[string]map[string]any `json:"made"`
	Listen    []string                  `json:"listen"`
	Steps     []any                     `json:"steps"`
}

type caseTransport struct {
	Answers string           `json:"answers"`
	Replies map[string][]any `json:"replies"`
	DelayMs any              `json:"delayMs"`
}

type namesTable struct {
	StateUnits []struct {
		Unit   string            `json:"unit"`
		Absent map[string]string `json:"absent"`
	} `json:"stateUnits"`
}

func readJSON[T any](t *testing.T, path string) T {
	t.Helper()
	text, err := os.ReadFile("../../../../specs/src/" + path)
	if err != nil {
		t.Fatal(err)
	}
	var read T
	if err := json.Unmarshal(text, &read); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	return read
}

// unitsThisSDKHas is each unit of the names table that does not say this SDK
// lacks it.
func unitsThisSDKHas(t *testing.T) map[string]bool {
	has := map[string]bool{}
	for _, row := range readJSON[namesTable](t, "client/surface.json").StateUnits {
		if _, absent := row.Absent[sdk]; !absent {
			has[row.Unit] = true
		}
	}
	return has
}

// casesToRun is every case of a unit this SDK has, and the table's fixtures.
func casesToRun(t *testing.T) ([]stateCase, map[string]any) {
	table := readJSON[stateTable](t, "client/state-units.json")
	has := unitsThisSDKHas(t)
	var run []stateCase
	for _, c := range table.Cases {
		if has[c.Unit] {
			run = append(run, c)
		}
	}
	if len(run) == 0 {
		t.Fatal("the table has no case of a unit this SDK has")
	}
	return run, table.Fixtures
}

// ── What a case states ──────────────────────────────────────────────────

// resolved is value with each {"$fixture": name} replaced by the table's
// fixture.
func resolved(fixtures map[string]any, value any) (any, error) {
	switch value := value.(type) {
	case []any:
		items := make([]any, len(value))
		for i, item := range value {
			resolvedItem, err := resolved(fixtures, item)
			if err != nil {
				return nil, err
			}
			items[i] = resolvedItem
		}
		return items, nil
	case map[string]any:
		if name, ok := value["$fixture"].(string); ok && len(value) == 1 {
			fixture, ok := fixtures[name]
			if !ok {
				return nil, fmt.Errorf("the table has no fixture %s", name)
			}
			return resolved(fixtures, fixture)
		}
		members := map[string]any{}
		for key, item := range value {
			resolvedItem, err := resolved(fixtures, item)
			if err != nil {
				return nil, err
			}
			members[key] = resolvedItem
		}
		return members, nil
	default:
		return value, nil
	}
}

// decoded is a stated value read as T, as the wire reads it.
func decoded[T any](value any) (T, error) {
	var read T
	text, err := json.Marshal(value)
	if err != nil {
		return read, err
	}
	err = json.Unmarshal(text, &read)
	return read, err
}

// durationOf is a duration as the table states it: milliseconds, or a
// timing of specs/src/client/timing.json, scaled by `times` and moved by
// `plusMs`.
func durationOf(value any) (time.Duration, error) {
	switch value := value.(type) {
	case float64:
		return time.Duration(value * float64(time.Millisecond)), nil
	case map[string]any:
		name, ok := value["timing"].(string)
		if !ok {
			return 0, fmt.Errorf("a duration names no timing: %v", value)
		}
		base, err := timingNamed(name)
		if err != nil {
			return 0, err
		}
		times, plus := 1.0, 0.0
		if stated, ok := value["times"].(float64); ok {
			times = stated
		}
		if stated, ok := value["plusMs"].(float64); ok {
			plus = stated
		}
		return time.Duration(float64(base)*times + plus*float64(time.Millisecond)), nil
	default:
		return 0, fmt.Errorf("a duration is milliseconds, or a timing: %v", value)
	}
}

// timingNamed is the timing table's row of that name, as this SDK's Timing
// holds it: "delegateSilenceMs" is Timing.DelegateSilence.
func timingNamed(name string) (time.Duration, error) {
	field := reflect.ValueOf(semiont.DefaultTiming()).FieldByName(goName(strings.TrimSuffix(name, "Ms")))
	if !field.IsValid() || field.Type() != reflect.TypeFor[time.Duration]() {
		return 0, fmt.Errorf("%s is no duration of this SDK's timing", name)
	}
	return time.Duration(field.Int()), nil
}

// goName is a name as the table spells it, as Go spells it.
func goName(name string) string {
	runes := []rune(name)
	runes[0] = unicode.ToUpper(runes[0])
	return string(runes)
}

// ── The transport ───────────────────────────────────────────────────────

// never answers nothing: the reply it makes is dropped on its way, and a
// step answers instead.
func never(bus.Channel, json.RawMessage) (json.RawMessage, error) { return nil, nil }

// jobs answers a job's creation and its status, and refuses the rest by
// name.
func jobs(operation bus.Channel, payload json.RawMessage) (json.RawMessage, error) {
	switch operation {
	case "job:create":
		return json.RawMessage(`{"jobId":"job-1"}`), nil
	case "job:status-requested":
		return json.RawMessage(`{"jobId":"job-1","type":"mark","status":"running","userId":"did:web:example.org:users:alice","created":"2026-10-01T00:00:00.000Z"}`), nil
	default:
		return semionttest.RefuseUnscriptedOperation(operation, payload)
	}
}

// transportOf is the transport a case states. Its stream carries what a
// client's does: the replies and the broadcasts, never the requests.
func transportOf(fixtures map[string]any, stated caseTransport) (*semionttest.FaultyTransport, error) {
	config := semionttest.FaultyConfig{Channels: bus.BridgedChannels}
	if stated.DelayMs != nil {
		delay, err := durationOf(stated.DelayMs)
		if err != nil {
			return nil, err
		}
		config.Schedule = []semionttest.FaultAction{semionttest.Delay{For: delay}}
	}
	switch stated.Answers {
	case "never":
		if stated.DelayMs != nil {
			return nil, errors.New("a transport that never answers holds no reply")
		}
		config.Schedule = []semionttest.FaultAction{semionttest.DropReply{}}
		config.MakeResponse = never
	case "refuses":
	case "jobs":
		config.MakeResponse = jobs
	default:
		return nil, fmt.Errorf("no transport answers %q", stated.Answers)
	}
	transport := semionttest.NewFaultyTransport(config)
	for operation, responses := range stated.Replies {
		for _, response := range responses {
			text, err := jsonOf(fixtures, response)
			if err != nil {
				return nil, err
			}
			transport.QueueReply(bus.Channel(operation), text)
		}
	}
	return transport, nil
}

// jsonOf is a stated value, its fixtures resolved, as JSON.
func jsonOf(fixtures map[string]any, value any) (json.RawMessage, error) {
	stated, err := resolved(fixtures, value)
	if err != nil {
		return nil, err
	}
	return json.Marshal(stated)
}

// ── The search a pipeline searches with ─────────────────────────────────

// searches is what a case's search pipeline searches with: it records each
// query it is asked, and gives each the answers a step gives it.
type searches struct {
	mu    sync.Mutex
	asked []asked
}

type asked struct {
	query   string
	answers chan searchAnswer
}

type searchAnswer struct {
	results []string
	known   bool
}

func (s *searches) search(ctx context.Context, query string) iter.Seq2[[]string, bool] {
	answers := make(chan searchAnswer, 16)
	s.mu.Lock()
	s.asked = append(s.asked, asked{query: query, answers: answers})
	s.mu.Unlock()
	return func(yield func([]string, bool) bool) {
		for {
			select {
			case <-ctx.Done():
				return
			case answer := <-answers:
				if !yield(answer.results, answer.known) {
					return
				}
			}
		}
	}
}

// answer gives the nth query an answer. One that was abandoned has nobody to
// give it to.
func (s *searches) answer(nth int, answer searchAnswer) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if nth >= len(s.asked) {
		return fmt.Errorf("query #%d was not asked", nth)
	}
	s.asked[nth].answers <- answer
	return nil
}

func (s *searches) queries() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	queries := []string{}
	for _, one := range s.asked {
		queries = append(queries, one.query)
	}
	return queries
}

// ── How this SDK makes each unit, and calls its methods ─────────────────

// run is one case being played.
type run struct {
	fixtures  map[string]any
	client    *semiont.Client
	transport *semionttest.FaultyTransport
	searches  *searches
	kind      string
	units     map[string]semiont.StateUnit

	mu    sync.Mutex
	heard []semiont.Frame
	// told is how much of what was heard has been checked.
	told int
}

// makers is how this SDK makes each unit it has, from the client and what the
// case makes it from.
var makers = map[string]func(r *run, made map[string]any) (semiont.StateUnit, error){
	"match": func(r *run, _ map[string]any) (semiont.StateUnit, error) {
		return state.NewMatchStateUnit(r.client), nil
	},
	"beckon": func(r *run, made map[string]any) (semiont.StateUnit, error) {
		resource, err := decoded[api.ResourceId](made["resourceId"])
		if err != nil {
			return nil, err
		}
		return state.NewBeckonStateUnit(r.client, resource), nil
	},
	"hoverDwell": func(r *run, made map[string]any) (semiont.StateUnit, error) {
		delay, err := durationOf(made["delayMs"])
		if err != nil {
			return nil, err
		}
		return state.NewHoverDwell(r.client.Beckon.Hover, delay), nil
	},
	"gather": func(r *run, made map[string]any) (semiont.StateUnit, error) {
		resource, err := decoded[api.ResourceId](made["resourceId"])
		if err != nil {
			return nil, err
		}
		return state.NewGatherStateUnit(r.client, resource), nil
	},
	"search": func(r *run, made map[string]any) (semiont.StateUnit, error) {
		debounce := semiont.DefaultTiming().SearchDebounce
		if stated, ok := made["debounceMs"]; ok {
			var err error
			if debounce, err = durationOf(stated); err != nil {
				return nil, err
			}
		}
		initial := ""
		if stated, ok := made["initialQuery"].(string); ok {
			initial = stated
		}
		return state.NewSearchPipeline(r.searches.search, debounce, initial), nil
	},
	"yield": func(r *run, made map[string]any) (semiont.StateUnit, error) {
		locale, ok := made["locale"].(string)
		if !ok {
			return nil, errors.New("a yield unit is made from its locale")
		}
		return state.NewYieldStateUnit(r.client, locale), nil
	},
	"mark": func(r *run, made map[string]any) (semiont.StateUnit, error) {
		resource, err := decoded[api.ResourceId](made["resourceId"])
		if err != nil {
			return nil, err
		}
		return state.NewMarkStateUnit(r.client, resource), nil
	},
	"sessionSignals": func(*run, map[string]any) (semiont.StateUnit, error) { return semiont.NewSessionSignals(), nil },
}

// invoker is a unit's method as a case calls it: the arguments it takes, by
// the names the table gives them, and the call.
type invoker struct {
	takes []string
	call  func(unit semiont.StateUnit, args map[string]any) error
}

// takes is the argument named name, read as T.
func takes[T any](args map[string]any, name string) (T, error) {
	stated, ok := args[name]
	if !ok {
		var none T
		return none, fmt.Errorf("the call states no %s", name)
	}
	return decoded[T](stated)
}

// invokers is each method a case calls, by its unit and its name.
var invokers = map[string]invoker{
	"mark.requestDelegate": {[]string{"params"}, func(unit semiont.StateUnit, args map[string]any) error {
		params, err := takes[api.MarkJobParams](args, "params")
		if err == nil {
			unit.(*state.MarkStateUnit).RequestDelegate(params)
		}
		return err
	}},
	"mark.cancelPending": {nil, func(unit semiont.StateUnit, _ map[string]any) error {
		unit.(*state.MarkStateUnit).CancelPending()
		return nil
	}},
	"mark.dismissProgress": {nil, func(unit semiont.StateUnit, _ map[string]any) error {
		unit.(*state.MarkStateUnit).DismissProgress()
		return nil
	}},
	"yield.generate": {[]string{"params", "stallDeadlineMs"}, func(unit semiont.StateUnit, args map[string]any) error {
		params, err := takes[api.GenerationJobParams](args, "params")
		if err != nil {
			return err
		}
		var stall time.Duration
		if stated, ok := args["stallDeadlineMs"]; ok {
			if stall, err = durationOf(stated); err != nil {
				return err
			}
		}
		unit.(*state.YieldStateUnit).Generate(params, stall)
		return nil
	}},
	"yield.dismissProgress": {nil, func(unit semiont.StateUnit, _ map[string]any) error {
		unit.(*state.YieldStateUnit).DismissProgress()
		return nil
	}},
	"gather.gatherAnnotation": {[]string{"annotationId", "contextWindow", "includeSourceContext", "includeTargetContext"}, func(unit semiont.StateUnit, args map[string]any) error {
		annotation, err := takes[api.AnnotationId](args, "annotationId")
		if err != nil {
			return err
		}
		// What the call states beside the annotation is the gather's options, by their wire names.
		stated := map[string]any{}
		for name, value := range args {
			if name != "annotationId" {
				stated[name] = value
			}
		}
		options, err := decoded[api.GatherAnnotationOptions](stated)
		if err != nil {
			return err
		}
		unit.(*state.GatherStateUnit).GatherAnnotation(annotation, options)
		return nil
	}},
	"gather.gatherResource": {[]string{"resourceId"}, func(unit semiont.StateUnit, args map[string]any) error {
		resource, err := takes[api.ResourceId](args, "resourceId")
		if err == nil {
			unit.(*state.GatherStateUnit).GatherResource(resource, semiont.GatherResourceDefaults())
		}
		return err
	}},
	"beckon.focus": {[]string{"annotationId"}, func(unit semiont.StateUnit, args map[string]any) error {
		annotation, err := takes[api.AnnotationId](args, "annotationId")
		if err == nil {
			unit.(*state.BeckonStateUnit).Focus(annotation)
		}
		return err
	}},
	"hoverDwell.enter": {[]string{"annotationId"}, func(unit semiont.StateUnit, args map[string]any) error {
		annotation, err := takes[api.AnnotationId](args, "annotationId")
		if err == nil {
			unit.(*state.HoverDwell).Enter(annotation)
		}
		return err
	}},
	"hoverDwell.leave": {nil, func(unit semiont.StateUnit, _ map[string]any) error {
		unit.(*state.HoverDwell).Leave()
		return nil
	}},
	"search.setQuery": {[]string{"value"}, func(unit semiont.StateUnit, args map[string]any) error {
		value, err := takes[string](args, "value")
		if err == nil {
			unit.(*state.SearchPipeline[string]).SetQuery(value)
		}
		return err
	}},
	"sessionSignals.notifySessionEnded": {[]string{"reason"}, func(unit semiont.StateUnit, args map[string]any) error {
		reason, err := takes[semiont.SessionEndReason](args, "reason")
		if err == nil {
			unit.(*semiont.SessionSignals).NotifySessionEnded(reason)
		}
		return err
	}},
	"sessionSignals.notifyPermissionDenied": {[]string{"detail"}, func(unit semiont.StateUnit, args map[string]any) error {
		detail, err := takes[*string](args, "detail")
		if err == nil {
			unit.(*semiont.SessionSignals).NotifyPermissionDenied(detail)
		}
		return err
	}},
	"sessionSignals.notifyKbIdentityConflict": {[]string{"conflict"}, func(unit semiont.StateUnit, args map[string]any) error {
		conflict, err := takes[semiont.KbIdentityConflict](args, "conflict")
		if err == nil {
			unit.(*semiont.SessionSignals).NotifyKbIdentityConflict(conflict)
		}
		return err
	}},
	"sessionSignals.acknowledgeSessionEnded": {nil, func(unit semiont.StateUnit, _ map[string]any) error {
		unit.(*semiont.SessionSignals).AcknowledgeSessionEnded()
		return nil
	}},
	"sessionSignals.acknowledgePermissionDenied": {nil, func(unit semiont.StateUnit, _ map[string]any) error {
		unit.(*semiont.SessionSignals).AcknowledgePermissionDenied()
		return nil
	}},
	"sessionSignals.acknowledgeKbIdentityConflict": {nil, func(unit semiont.StateUnit, _ map[string]any) error {
		unit.(*semiont.SessionSignals).AcknowledgeKbIdentityConflict()
		return nil
	}},
}

// ── What a unit holds, as the wire writes it ────────────────────────────

// watchedOf is the state a unit's member holds, read by the member's name.
func watchedOf(unit semiont.StateUnit, member string) (reflect.Value, error) {
	method := reflect.ValueOf(unit).MethodByName(goName(member))
	if !method.IsValid() || method.Type().NumIn() != 0 || method.Type().NumOut() != 1 {
		return reflect.Value{}, fmt.Errorf("%T has no state %s", unit, member)
	}
	watched := method.Call(nil)[0]
	if !watched.MethodByName("Value").IsValid() || !watched.MethodByName("Changes").IsValid() {
		return reflect.Value{}, fmt.Errorf("%T's %s is no Watched", unit, member)
	}
	return watched, nil
}

// valueOf is what a state holds now.
func valueOf(watched reflect.Value) any {
	return watched.MethodByName("Value").Call(nil)[0].Interface()
}

// none reports whether a held value holds nothing: nil, or the zero value of
// an id or a motivation.
func none(held any) bool {
	if held == nil {
		return true
	}
	value := reflect.ValueOf(held)
	switch value.Kind() {
	case reflect.Pointer, reflect.Interface, reflect.Map, reflect.Slice:
		if value.IsNil() {
			return true
		}
	}
	if motivation, ok := held.(api.Motivation); ok {
		return motivation == ""
	}
	if id, ok := held.(interface{ IsZero() bool }); ok {
		return id.IsZero()
	}
	return false
}

// writtenError is an error as a case states one: its code and its message.
func writtenError(err error) map[string]any {
	written := map[string]any{"message": err.Error()}
	var coded semiont.Error
	if errors.As(err, &coded) {
		written["code"] = coded.ErrorCode()
	}
	return written
}

// written is what a state holds, as the wire writes it. An error is its code
// and its message.
func written(held any) (any, error) {
	if none(held) {
		return nil, nil
	}
	if err, ok := held.(error); ok {
		return writtenError(err), nil
	}
	if motivation, ok := held.(api.Motivation); ok {
		return string(motivation), nil
	}
	text, err := json.Marshal(held)
	if err != nil {
		return nil, err
	}
	var value any
	err = json.Unmarshal(text, &value)
	return value, err
}

// matches reports whether actual is what expected states: exactly, but where
// $has asks only for some members.
func matches(expected, actual any) bool {
	switch expected := expected.(type) {
	case map[string]any:
		object, ok := actual.(map[string]any)
		if !ok {
			return false
		}
		if has, ok := expected["$has"].(map[string]any); ok && len(expected) == 1 {
			for key, value := range has {
				if got, present := object[key]; !present || !matches(value, got) {
					return false
				}
			}
			return true
		}
		if len(expected) != len(object) {
			return false
		}
		for key, value := range expected {
			if got, present := object[key]; !present || !matches(value, got) {
				return false
			}
		}
		return true
	case []any:
		items, ok := actual.([]any)
		if !ok || len(items) != len(expected) {
			return false
		}
		for i := range expected {
			if !matches(expected[i], items[i]) {
				return false
			}
		}
		return true
	default:
		return expected == actual
	}
}

// holds reports whether a state holds what expected states. An error is
// compared on what the case states of it.
func holds(expected, held any) (bool, error) {
	if err, ok := held.(error); ok && !none(held) {
		stated, ok := expected.(map[string]any)
		if !ok {
			return false, nil
		}
		got := writtenError(err)
		for key, value := range stated {
			if got[key] != value {
				return false, nil
			}
		}
		return true, nil
	}
	value, err := written(held)
	if err != nil {
		return false, err
	}
	return matches(expected, value), nil
}

// hasEnded reports whether a reader of watched is given what it holds and
// then ends.
func hasEnded(watched reflect.Value) bool {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	changes := watched.MethodByName("Changes").Call([]reflect.Value{reflect.ValueOf(ctx)})[0]
	var given atomic.Int32
	yield := reflect.MakeFunc(changes.Type().In(0), func([]reflect.Value) []reflect.Value {
		given.Add(1)
		return []reflect.Value{reflect.ValueOf(true)}
	})
	done := make(chan struct{})
	go func() {
		defer close(done)
		changes.Call([]reflect.Value{yield})
	}()
	synctest.Wait()
	select {
	case <-done:
		return given.Load() == 1
	default:
		cancel()
		<-done
		return false
	}
}

// busEnded reports whether a bus has ended: a reader taken of it now ends at
// once.
func busEnded(b *semiont.EventBus) bool {
	ctx, cancel := context.WithCancel(context.Background())
	frames := b.FramesAmong(ctx)
	ended := make(chan struct{})
	go func() {
		defer close(ended)
		for range frames {
		}
	}()
	synctest.Wait()
	select {
	case <-ended:
		cancel()
		return true
	default:
		cancel()
		<-ended
		return false
	}
}

// ── A case, played ──────────────────────────────────────────────────────

// play plays a case, inside the bubble its test runs in, and says what it
// found broken.
func play(c stateCase, fixtures map[string]any) (failure error) {
	transport, err := transportOf(fixtures, c.Transport)
	if err != nil {
		return err
	}
	made := semionttest.NewTestClient(semionttest.TestClientConfig{Transport: transport, Timing: semiont.DefaultTiming()})
	r := &run{fixtures: fixtures, client: made.Client, transport: transport, searches: &searches{}, kind: c.Unit, units: map[string]semiont.StateUnit{}}
	listening, stopListening := context.WithCancel(context.Background())
	defer func() {
		for _, unit := range r.units {
			unit.Close()
		}
		stopListening()
		made.Client.Close()
		transport.Close()
		synctest.Wait()
	}()
	maker, ok := makers[c.Unit]
	if !ok {
		return fmt.Errorf("this SDK makes no %s unit", c.Unit)
	}
	for _, name := range slices.Sorted(maps.Keys(c.Made)) {
		given, err := resolved(fixtures, any(c.Made[name]))
		if err != nil {
			return err
		}
		unit, err := maker(r, given.(map[string]any))
		if err != nil {
			return fmt.Errorf("made.%s: %w", name, err)
		}
		r.units[name] = unit
	}
	if len(c.Listen) > 0 {
		channels := make([]bus.Channel, len(c.Listen))
		for i, channel := range c.Listen {
			channels[i] = bus.Channel(channel)
		}
		// Taken now, before anything runs, so what is said from the moment the units are made is heard.
		frames := r.client.Bus.FramesAmong(listening, channels...)
		go func() {
			for frame := range frames {
				r.mu.Lock()
				r.heard = append(r.heard, frame)
				r.mu.Unlock()
			}
		}()
	}
	for at, step := range c.Steps {
		if err := r.perform(step); err != nil {
			stated, _ := json.Marshal(step)
			return fmt.Errorf("steps[%d] %s: %w", at, stated, err)
		}
	}
	return nil
}

// requestID is the correlation id the nth request sent on channel carried.
func (r *run) requestID(channel string, nth int) (string, error) {
	var sent []semionttest.RequestLogEntry
	for _, entry := range r.transport.RequestLog() {
		if entry.Channel == bus.Channel(channel) {
			sent = append(sent, entry)
		}
	}
	if nth >= len(sent) {
		return "", fmt.Errorf("request #%d on %s was not sent", nth, channel)
	}
	return sent[nth].CorrelationID, nil
}

func (r *run) unit(name any) (semiont.StateUnit, error) {
	unit, ok := r.units[fmt.Sprint(name)]
	if !ok {
		return nil, fmt.Errorf("the case made no unit %v", name)
	}
	return unit, nil
}

// frame is a frame a step states.
func (r *run) frame(channel any, payload any, correlationID string) (semiont.Frame, error) {
	text, err := jsonOf(r.fixtures, payload)
	if err != nil {
		return semiont.Frame{}, err
	}
	return semiont.Frame{Channel: bus.Channel(fmt.Sprint(channel)), Envelope: semiont.Envelope{CorrelationID: correlationID}, Payload: text}, nil
}

// perform performs one step.
func (r *run) perform(step any) error {
	if step == "settle" {
		synctest.Wait()
		return nil
	}
	s, ok := step.(map[string]any)
	if !ok {
		return errors.New("no step this runner performs")
	}
	correlation, _ := s["correlationId"].(string)
	switch {
	case s["say"] != nil:
		frame, err := r.frame(s["say"], s["payload"], correlation)
		if err != nil {
			return err
		}
		r.client.Bus.Deliver(frame)
	case s["deliver"] != nil:
		frame, err := r.frame(s["deliver"], s["payload"], correlation)
		if err != nil {
			return err
		}
		r.transport.Deliver(frame)
	case s["answer"] != nil:
		nth, err := decoded[int](s["nth"])
		if err != nil {
			return err
		}
		id, err := r.requestID(fmt.Sprint(s["answer"]), nth)
		if err != nil {
			return err
		}
		frame, err := r.frame(s["reply"], s["payload"], id)
		if err != nil {
			return err
		}
		r.transport.Deliver(frame)
	case s["queueReply"] != nil:
		text, err := jsonOf(r.fixtures, s["response"])
		if err != nil {
			return err
		}
		r.transport.QueueReply(bus.Channel(fmt.Sprint(s["queueReply"])), text)
	case s["invoke"] != nil:
		return r.invoke(s)
	case s["pass"] != nil:
		passing, err := durationOf(s["pass"])
		if err != nil {
			return err
		}
		// What is ready runs at the time it became ready, before the clock moves; what falls due runs to its end.
		synctest.Wait()
		time.Sleep(passing)
		synctest.Wait()
	case s["dispose"] != nil:
		unit, err := r.unit(s["dispose"])
		if err != nil {
			return err
		}
		unit.Close()
	case s["answerSearch"] != nil:
		nth, err := decoded[int](s["answerSearch"])
		if err != nil {
			return err
		}
		if s["results"] == nil {
			return r.searches.answer(nth, searchAnswer{})
		}
		results, err := decoded[[]string](s["results"])
		if err != nil {
			return err
		}
		return r.searches.answer(nth, searchAnswer{results: results, known: true})
	case s["searched"] != nil:
		wanted, err := decoded[[]string](s["searched"])
		if err != nil {
			return err
		}
		if asked := r.searches.queries(); !slices.Equal(asked, wanted) {
			return fmt.Errorf("the search was asked %q", asked)
		}
	case s["expect"] != nil:
		return r.expect(s["expect"])
	case s["sent"] != nil:
		return r.sent(s)
	case s["nothingSent"] != nil:
		if sent := r.transport.RequestLog(); len(sent) != 0 {
			return fmt.Errorf("requests were sent: %v", sent)
		}
	case s["heard"] != nil:
		return r.heardSince(s["heard"])
	case s["ended"] != nil:
		return r.ended(s["ended"])
	case s["busDestroyed"] != nil:
		if ended := busEnded(r.client.Bus); ended != s["busDestroyed"] {
			return fmt.Errorf("the client's bus has ended: %v", ended)
		}
	default:
		return errors.New("no step this runner performs")
	}
	return nil
}

func (r *run) invoke(s map[string]any) error {
	member := fmt.Sprint(s["invoke"])
	call, ok := invokers[r.kind+"."+member]
	if !ok {
		return fmt.Errorf("this runner calls no %s.%s", r.kind, member)
	}
	unit, err := r.unit(s["of"])
	if err != nil {
		return err
	}
	stated, err := resolved(r.fixtures, s["args"])
	if err != nil {
		return err
	}
	args, ok := stated.(map[string]any)
	if !ok {
		return errors.New("a call states its arguments by name")
	}
	for name := range args {
		if !slices.Contains(call.takes, name) {
			return fmt.Errorf("%s.%s takes no %s", r.kind, member, name)
		}
	}
	return call.call(unit, args)
}

func (r *run) expect(stated any) error {
	expected, ok := stated.(map[string]any)
	if !ok {
		return errors.New("expect states each unit's members")
	}
	for _, name := range slices.Sorted(maps.Keys(expected)) {
		unit, err := r.unit(name)
		if err != nil {
			return err
		}
		members, ok := expected[name].(map[string]any)
		if !ok {
			return fmt.Errorf("expect.%s states no members", name)
		}
		for _, member := range slices.Sorted(maps.Keys(members)) {
			watched, err := watchedOf(unit, member)
			if err != nil {
				return err
			}
			want, err := resolved(r.fixtures, members[member])
			if err != nil {
				return err
			}
			held := valueOf(watched)
			ok, err := holds(want, held)
			if err != nil {
				return err
			}
			if !ok {
				got, _ := written(held)
				return fmt.Errorf("%s.%s holds %v, not %v", name, member, got, want)
			}
		}
	}
	return nil
}

func (r *run) sent(s map[string]any) error {
	channel := fmt.Sprint(s["sent"])
	sent := []any{}
	for _, entry := range r.transport.RequestLog() {
		if entry.Channel != bus.Channel(channel) {
			continue
		}
		var payload any
		if err := json.Unmarshal(entry.Payload, &payload); err != nil {
			return err
		}
		sent = append(sent, payload)
	}
	if count, ok := s["count"]; ok {
		if float64(len(sent)) != count {
			return fmt.Errorf("%d requests were sent on %s, not %v", len(sent), channel, count)
		}
		return nil
	}
	want, err := resolved(r.fixtures, s["payloads"])
	if err != nil {
		return err
	}
	if !matches(want, sent) {
		return fmt.Errorf("sent on %s: %v", channel, sent)
	}
	return nil
}

func (r *run) heardSince(stated any) error {
	synctest.Wait()
	r.mu.Lock()
	frames := slices.Clone(r.heard[r.told:])
	r.told = len(r.heard)
	r.mu.Unlock()
	wanted, ok := stated.([]any)
	if !ok {
		return errors.New("heard states a list of frames")
	}
	got := make([]string, len(frames))
	for i, frame := range frames {
		got[i] = fmt.Sprintf("%s %s %q", frame.Channel, frame.Payload, frame.CorrelationID)
	}
	if len(wanted) != len(frames) {
		return fmt.Errorf("heard %v", got)
	}
	for i, frame := range frames {
		want, ok := wanted[i].(map[string]any)
		if !ok {
			return errors.New("a heard frame is stated as an object")
		}
		expectedID := ""
		switch correlation := want["correlationId"].(type) {
		case string:
			expectedID = correlation
		case map[string]any:
			nth, err := decoded[int](correlation["nth"])
			if err != nil {
				return err
			}
			if expectedID, err = r.requestID(fmt.Sprint(correlation["sent"]), nth); err != nil {
				return err
			}
		}
		payload, err := resolved(r.fixtures, want["payload"])
		if err != nil {
			return err
		}
		var heard any
		if err := json.Unmarshal(frame.Payload, &heard); err != nil {
			return err
		}
		if string(frame.Channel) != want["channel"] || !matches(payload, heard) || frame.CorrelationID != expectedID {
			return fmt.Errorf("heard %v", got)
		}
	}
	return nil
}

func (r *run) ended(stated any) error {
	units, ok := stated.(map[string]any)
	if !ok {
		return errors.New("ended states each unit's members")
	}
	for _, name := range slices.Sorted(maps.Keys(units)) {
		unit, err := r.unit(name)
		if err != nil {
			return err
		}
		members, err := decoded[[]string](units[name])
		if err != nil {
			return err
		}
		for _, member := range members {
			watched, err := watchedOf(unit, member)
			if err != nil {
				return err
			}
			if !hasEnded(watched) {
				return fmt.Errorf("%s.%s has not ended", name, member)
			}
		}
	}
	return nil
}

// ── The tests ───────────────────────────────────────────────────────────

func TestThisSDKMakesEachUnitItHasCasesOfAndNoOther(t *testing.T) {
	cases, _ := casesToRun(t)
	of := map[string]bool{}
	for _, c := range cases {
		of[c.Unit] = true
	}
	// A unit the table states no case of (the cache, whose behaviour its own tables hold) needs no maker here.
	if made := slices.Sorted(maps.Keys(makers)); !slices.Equal(made, slices.Sorted(maps.Keys(of))) {
		t.Fatalf("this runner makes %v; the cases are of %v", made, slices.Sorted(maps.Keys(of)))
	}
}

func TestEveryCaseIsOfAUnitTheNamesTableHas(t *testing.T) {
	named := map[string]bool{}
	for _, row := range readJSON[namesTable](t, "client/surface.json").StateUnits {
		named[row.Unit] = true
	}
	for _, c := range readJSON[stateTable](t, "client/state-units.json").Cases {
		if !named[c.Unit] {
			t.Errorf("%s: %s is of no unit the names table has", c.Unit, c.Case)
		}
	}
}

func TestAUnitDoesWhatItsCaseSays(t *testing.T) {
	cases, fixtures := casesToRun(t)
	for _, c := range cases {
		t.Run(c.Unit+": "+c.Case, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				if err := play(c, fixtures); err != nil {
					t.Fatal(err)
				}
			})
		})
	}
}

func TestTheRunnerFailsACaseWhoseCheckIsWrong(t *testing.T) {
	cases, fixtures := casesToRun(t)
	index := slices.IndexFunc(cases, func(c stateCase) bool { return c.Unit == "match" })
	if index < 0 {
		t.Fatal("the table has no match case")
	}
	told := cases[index]
	told.Steps = slices.Clone(told.Steps)
	altered := false
	for i, step := range told.Steps {
		if s, ok := step.(map[string]any); ok && s["heard"] != nil {
			told.Steps[i] = map[string]any{"heard": []any{}}
			altered = true
		}
	}
	if !altered {
		t.Fatal("the match case checks nothing it heard")
	}
	var failure error
	synctest.Test(t, func(t *testing.T) { failure = play(told, fixtures) })
	if failure == nil || !strings.Contains(failure.Error(), "heard") {
		t.Fatalf("the runner passed a case whose check is wrong: %v", failure)
	}
}
