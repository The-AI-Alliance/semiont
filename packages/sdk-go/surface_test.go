package semiont_test

// The client's surface against specs/src/client/surface.json.
//
// Every method the table lists is called as each of its cases states, and
// what the call did first is held to the row. A row with no call here fails,
// and so does a call here with no row: the table and this SDK list the same
// methods.
//
// What a method does first is one of: a request of a bus operation, a frame
// sent over the wire, a frame published on the client's own bus, a call of
// the content transport, a call of the gateway, or reading a channel of the
// client's own bus. A call that waits is run on a goroutine of its own, and
// what it returns is not this test's to judge: a case holds what the call
// did, not what it was answered.
//
// Signatures are read by scripts/lint/check-client-surface.mjs.

import (
	"context"
	"encoding/json"
	"fmt"
	"iter"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"sort"
	"sync"
	"testing"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bustest"
)

// sdk is this runner's SDK, as the table's `absent` names it.
const sdk = "go"

type surfaceCase struct {
	Why   string                     `json:"why"`
	Args  map[string]json.RawMessage `json:"args"`
	Sends json.RawMessage            `json:"sends"`
	// Answers is what the row's operation is answered with: absent (empty)
	// for none scripted, `null` for a reply that carries no response.
	Answers       json.RawMessage              `json:"answers"`
	Then          []map[string]json.RawMessage `json:"then"`
	CorrelationID *string                      `json:"correlationId"`
}

type surfaceRow struct {
	Method string                     `json:"method"`
	Shape  string                     `json:"shape"`
	Via    map[string]string          `json:"via"`
	Cases  []surfaceCase              `json:"cases"`
	Absent map[string]json.RawMessage `json:"absent"`
}

type surfaceTable struct {
	Fixtures   map[string]json.RawMessage `json:"fixtures"`
	Namespaces []struct {
		Namespace string       `json:"namespace"`
		Methods   []surfaceRow `json:"methods"`
	} `json:"namespaces"`
}

func readSurface(t *testing.T) surfaceTable {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "specs", "src", "client", "surface.json"))
	if err != nil {
		t.Fatal(err)
	}
	var table surfaceTable
	if err := json.Unmarshal(b, &table); err != nil {
		t.Fatal(err)
	}
	return table
}

// resolved is value with each {"$fixture": name} replaced by the table's
// fixture of that name.
func resolved(t *testing.T, fixtures map[string]json.RawMessage, value json.RawMessage) json.RawMessage {
	t.Helper()
	var decoded any
	if err := json.Unmarshal(value, &decoded); err != nil {
		t.Fatal(err)
	}
	var replace func(any) any
	replace = func(v any) any {
		switch v := v.(type) {
		case map[string]any:
			if name, ok := v["$fixture"].(string); ok && len(v) == 1 {
				fixture, found := fixtures[name]
				if !found {
					t.Fatalf("the table has no fixture %q", name)
				}
				var f any
				if err := json.Unmarshal(fixture, &f); err != nil {
					t.Fatal(err)
				}
				return f
			}
			out := map[string]any{}
			for k, item := range v {
				out[k] = replace(item)
			}
			return out
		case []any:
			out := make([]any, len(v))
			for i, item := range v {
				out[i] = replace(item)
			}
			return out
		}
		return v
	}
	out, err := json.Marshal(replace(decoded))
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// normal is value as plain JSON values: every number the float it is, however
// it was written, so 200 and 200.0 are one JSON number.
func normal(t *testing.T, value any) any {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(encoded, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// args is what a case gives a method, read by name.
type args struct {
	t      *testing.T
	method string
	given  map[string]json.RawMessage
}

func (a args) has(name string) bool {
	raw, ok := a.given[name]
	return ok && string(raw) != "null"
}

func (a args) into(name string, target any) {
	a.t.Helper()
	raw, ok := a.given[name]
	if !ok {
		a.t.Fatalf("%s: the case states no %s", a.method, name)
	}
	if err := json.Unmarshal(raw, target); err != nil {
		a.t.Fatalf("%s: %s: %v", a.method, name, err)
	}
}

func (a args) text(name string) string {
	var s string
	a.into(name, &s)
	return s
}

func (a args) texts(name string) []string {
	var s []string
	a.into(name, &s)
	return s
}

func (a args) rid(name string) api.ResourceId {
	a.t.Helper()
	id, err := api.ParseResourceId(a.text(name))
	if err != nil {
		a.t.Fatal(err)
	}
	return id
}

func (a args) aid(name string) api.AnnotationId {
	a.t.Helper()
	id, err := api.ParseAnnotationId(a.text(name))
	if err != nil {
		a.t.Fatal(err)
	}
	return id
}

func (a args) jid(name string) api.JobId {
	a.t.Helper()
	id, err := api.ParseJobId(a.text(name))
	if err != nil {
		a.t.Fatal(err)
	}
	return id
}

// stated is the object under name, refusing a member this SDK has no
// argument for: a member left unsent would pass unseen.
func (a args) stated(name string, takes ...string) map[string]json.RawMessage {
	a.t.Helper()
	stated := map[string]json.RawMessage{}
	if a.has(name) {
		a.into(name, &stated)
	}
	for member := range stated {
		if !slices.Contains(takes, member) {
			a.t.Fatalf("%s: the case states %s.%s, which this SDK has no argument for", a.method, name, member)
		}
	}
	return stated
}

func decodeInto[T any](a args, raw json.RawMessage) T {
	a.t.Helper()
	var value T
	if err := json.Unmarshal(raw, &value); err != nil {
		a.t.Fatalf("%s: %v", a.method, err)
	}
	return value
}

// filters is the filters a list or a search is given.
func (a args) filters() semiont.ResourceFilters {
	stated := a.stated("filters", "archived", "entityType", "limit")
	var filters semiont.ResourceFilters
	if raw, ok := stated["limit"]; ok {
		filters.Limit = decodeInto[int](a, raw)
	}
	if raw, ok := stated["archived"]; ok {
		archived := decodeInto[bool](a, raw)
		filters.Archived = &archived
	}
	if raw, ok := stated["entityType"]; ok {
		entityType := decodeInto[string](a, raw)
		filters.EntityType = &entityType
	}
	return filters
}

// call is one method called as a case states: what it does is the test's
// to hold; what it returns, nobody's.
type call func(ctx context.Context, c *semiont.Client, a args)

func fresh[T any](ctx context.Context, q *semiont.Cached[T]) { _, _ = q.Fresh(ctx) }

var calls = map[string]call{
	"frame.addEntityType": func(ctx context.Context, c *semiont.Client, a args) {
		_ = c.Frame.AddEntityType(ctx, a.text("type"))
	},
	"frame.addEntityTypes": func(ctx context.Context, c *semiont.Client, a args) {
		_ = c.Frame.AddEntityTypes(ctx, a.texts("types"))
	},
	"frame.addTagSchema": func(ctx context.Context, c *semiont.Client, a args) {
		_ = c.Frame.AddTagSchema(ctx, decodeInto[api.TagSchema](a, a.given["schema"]))
	},
	"browse.resource": func(ctx context.Context, c *semiont.Client, a args) {
		fresh(ctx, c.Browse.Resource(a.rid("resourceId")))
	},
	"browse.resources": func(ctx context.Context, c *semiont.Client, a args) {
		fresh(ctx, c.Browse.Resources(a.filters()))
	},
	"browse.annotations": func(ctx context.Context, c *semiont.Client, a args) {
		fresh(ctx, c.Browse.Annotations(a.rid("resourceId")))
	},
	"browse.annotation": func(ctx context.Context, c *semiont.Client, a args) {
		fresh(ctx, c.Browse.Annotation(a.rid("resourceId"), a.aid("annotationId")))
	},
	"browse.entityTypes": func(ctx context.Context, c *semiont.Client, a args) { fresh(ctx, c.Browse.EntityTypes()) },
	"browse.tagSchemas":  func(ctx context.Context, c *semiont.Client, a args) { fresh(ctx, c.Browse.TagSchemas()) },
	"browse.agents":      func(ctx context.Context, c *semiont.Client, a args) { fresh(ctx, c.Browse.Agents()) },
	"browse.events": func(ctx context.Context, c *semiont.Client, a args) {
		fresh(ctx, c.Browse.Events(a.rid("resourceId")))
	},
	"browse.resourceContent": func(ctx context.Context, c *semiont.Client, a args) {
		_, _ = c.Browse.ResourceContent(ctx, a.rid("resourceId"))
	},
	"browse.resourceGraph": func(ctx context.Context, c *semiont.Client, a args) {
		_, _ = c.Browse.ResourceGraph(ctx, a.rid("resourceId"))
	},
	"browse.resourceAnchoredText": func(ctx context.Context, c *semiont.Client, a args) {
		_, _ = c.Browse.ResourceAnchoredText(ctx, a.rid("resourceId"))
	},
	"browse.resourceRepresentation": func(ctx context.Context, c *semiont.Client, a args) {
		_, _ = c.Browse.ResourceRepresentation(ctx, a.rid("resourceId"))
	},
	"browse.resourceRepresentationStream": func(ctx context.Context, c *semiont.Client, a args) {
		_, _ = c.Browse.ResourceRepresentationStream(ctx, a.rid("resourceId"))
	},
	"browse.resourceEvents": func(ctx context.Context, c *semiont.Client, a args) {
		_, _ = c.Browse.ResourceEvents(ctx, a.rid("resourceId"))
	},
	"browse.annotationHistory": func(ctx context.Context, c *semiont.Client, a args) {
		_, _ = c.Browse.AnnotationHistory(ctx, a.rid("resourceId"), a.aid("annotationId"))
	},
	"browse.files": func(ctx context.Context, c *semiont.Client, a args) {
		var dirPath string
		var order api.BrowseDirectoryRequestSort
		if a.has("dirPath") {
			dirPath = a.text("dirPath")
		}
		if a.has("sort") {
			order = api.BrowseDirectoryRequestSort(a.text("sort"))
		}
		_, _ = c.Browse.Files(ctx, dirPath, order)
	},
	"browse.kb":             func(ctx context.Context, c *semiont.Client, a args) { _, _ = c.Browse.Kb(ctx) },
	"browse.click":          func(_ context.Context, c *semiont.Client, a args) { c.Browse.Click(a.aid("annotationId")) },
	"browse.openResource":   func(_ context.Context, c *semiont.Client, a args) { c.Browse.OpenResource(a.rid("resourceId")) },
	"browse.resourceViewed": func(_ context.Context, c *semiont.Client, a args) { c.Browse.ResourceViewed(a.rid("resourceId")) },
	"mark.annotation": func(ctx context.Context, c *semiont.Client, a args) {
		_, _ = c.Mark.Annotation(ctx, decodeInto[api.CreateAnnotationRequest](a, a.given["input"]))
	},
	"mark.delete": func(ctx context.Context, c *semiont.Client, a args) {
		_ = c.Mark.Delete(ctx, a.rid("resourceId"), a.aid("annotationId"))
	},
	"mark.archive":   func(ctx context.Context, c *semiont.Client, a args) { _ = c.Mark.Archive(ctx, a.rid("resourceId")) },
	"mark.unarchive": func(ctx context.Context, c *semiont.Client, a args) { _ = c.Mark.Unarchive(ctx, a.rid("resourceId")) },
	"mark.updateEntityTypes": func(ctx context.Context, c *semiont.Client, a args) {
		_ = c.Mark.UpdateEntityTypes(ctx, a.rid("resourceId"), a.texts("current"), a.texts("updated"))
	},
	"mark.delegate": func(ctx context.Context, c *semiont.Client, a args) {
		_, _ = c.Mark.Delegate(a.rid("resourceId"), decodeInto[api.MarkJobParams](a, a.given["params"])).Wait(ctx)
	},
	"mark.request": func(_ context.Context, c *semiont.Client, a args) {
		c.Mark.Request(a.rid("source"), decodeInto[api.AnnotationSelector](a, a.given["selector"]), api.Motivation(a.text("motivation")))
	},
	"mark.submit": func(_ context.Context, c *semiont.Client, a args) {
		c.Mark.Submit(decodeInto[api.MarkSubmitEvent](a, a.given["input"]))
	},
	"mark.reportDeleteError": func(_ context.Context, c *semiont.Client, a args) {
		c.Mark.ReportDeleteError(decodeInto[api.ResourceErrorEvent](a, a.given["input"]))
	},
	"bind.body": func(ctx context.Context, c *semiont.Client, a args) {
		_ = c.Bind.Body(ctx, a.rid("resourceId"), a.aid("annotationId"), decodeInto[[]api.BindBodyOperation](a, a.given["operations"]))
	},
	"bind.initiate": func(_ context.Context, c *semiont.Client, a args) {
		c.Bind.Initiate(decodeInto[api.BindInitiateCommand](a, a.given["input"]))
	},
	"bind.reportBodyError": func(_ context.Context, c *semiont.Client, a args) {
		c.Bind.ReportBodyError(decodeInto[api.ResourceErrorEvent](a, a.given["input"]))
	},
	"gather.annotation": func(ctx context.Context, c *semiont.Client, a args) {
		var window int
		if raw, ok := a.stated("options", "contextWindow")["contextWindow"]; ok {
			window = decodeInto[int](a, raw)
		}
		_, _ = c.Gather.Annotation(a.rid("resourceId"), a.aid("annotationId"), window).Wait(ctx)
	},
	"gather.resource": func(ctx context.Context, c *semiont.Client, a args) {
		options := semiont.GatherResourceDefaults()
		stated := a.stated("options", "depth", "maxResources", "includeContent", "includeSummary", "excludeEntityTypes")
		encoded, err := json.Marshal(stated)
		if err != nil {
			a.t.Fatal(err)
		}
		options = decodeOnto(a, encoded, options)
		_, _ = c.Gather.Resource(ctx, a.rid("resourceId"), options)
	},
	"gather.referencedBy": func(ctx context.Context, c *semiont.Client, a args) {
		fresh(ctx, c.Gather.ReferencedBy(a.rid("resourceId")))
	},
	"match.search": func(ctx context.Context, c *semiont.Client, a args) {
		stated := a.stated("options", "limit", "useSemanticScoring")
		var options semiont.MatchSearchOptions
		if raw, ok := stated["limit"]; ok {
			options.Limit = decodeInto[int](a, raw)
		}
		if raw, ok := stated["useSemanticScoring"]; ok {
			semantic := decodeInto[bool](a, raw)
			options.UseSemanticScoring = &semantic
		}
		gathered := decodeInto[api.GatheredContext](a, a.given["context"])
		_, _ = c.Match.Search(a.rid("resourceId"), a.aid("referenceId"), gathered, options).Wait(ctx)
	},
	"match.requestSearch": func(_ context.Context, c *semiont.Client, a args) {
		c.Match.RequestSearch(decodeInto[api.MatchSearchRequest](a, a.given["input"]), a.text("correlationId"))
	},
	"match.resources": func(ctx context.Context, c *semiont.Client, a args) {
		fresh(ctx, c.Match.Resources(a.text("search"), a.filters()))
	},
	"yield.resource": func(ctx context.Context, c *semiont.Client, a args) {
		var data struct {
			Name       string `json:"name"`
			Content    string `json:"content"`
			Format     string `json:"format"`
			StorageURI string `json:"storageUri"`
		}
		a.into("data", &data)
		_, _ = c.Yield.Resource(ctx, semiont.PutBinaryRequest{Name: data.Name, Bytes: []byte(data.Content), Format: data.Format, StorageURI: data.StorageURI}).Wait(ctx)
	},
	"yield.delegate": func(ctx context.Context, c *semiont.Client, a args) {
		var within time.Duration
		if a.has("stallDeadlineMs") {
			within = time.Duration(decodeInto[int](a, a.given["stallDeadlineMs"])) * time.Millisecond
		}
		_, _ = c.Yield.Delegate(decodeInto[api.GenerationJobParams](a, a.given["params"]), within).Wait(ctx)
	},
	"yield.cloneToken": func(ctx context.Context, c *semiont.Client, a args) {
		_, _ = c.Yield.CloneToken(ctx, a.rid("resourceId"))
	},
	"yield.fromToken": func(ctx context.Context, c *semiont.Client, a args) {
		_, _ = c.Yield.FromToken(ctx, a.text("token"))
	},
	"yield.createFromToken": func(ctx context.Context, c *semiont.Client, a args) {
		stated := a.stated("options", "token", "name", "content")
		_, _ = c.Yield.CreateFromToken(ctx, semiont.CreateFromTokenOptions{
			Token:   decodeInto[string](a, stated["token"]),
			Name:    decodeInto[string](a, stated["name"]),
			Content: decodeInto[string](a, stated["content"]),
		})
	},
	"yield.clone": func(_ context.Context, c *semiont.Client, a args) { c.Yield.Clone() },
	"beckon.attention": func(ctx context.Context, c *semiont.Client, a args) {
		_, _, _ = c.Beckon.Attention(ctx, a.rid("resourceId"), a.aid("annotationId"))
	},
	"beckon.click": func(ctx context.Context, c *semiont.Client, a args) {
		_, _, _ = c.Beckon.Click(ctx, a.aid("annotationId"))
	},
	"beckon.openResource": func(ctx context.Context, c *semiont.Client, a args) {
		_, _, _ = c.Beckon.OpenResource(ctx, a.rid("resourceId"))
	},
	"beckon.sparkleAll": func(ctx context.Context, c *semiont.Client, a args) {
		_, _, _ = c.Beckon.SparkleAll(ctx, a.aid("annotationId"))
	},
	"beckon.hover": func(_ context.Context, c *semiont.Client, a args) {
		if !a.has("annotationId") {
			c.Beckon.Hover(nil)
			return
		}
		hovered := a.aid("annotationId")
		c.Beckon.Hover(&hovered)
	},
	"beckon.sparkle": func(_ context.Context, c *semiont.Client, a args) { c.Beckon.Sparkle(a.aid("annotationId")) },
	"job.status": func(ctx context.Context, c *semiont.Client, a args) {
		_, _ = c.Job.Status(ctx, a.jid("jobId"))
	},
	"job.pollUntilComplete": func(ctx context.Context, c *semiont.Client, a args) {
		_, _ = c.Job.PollUntilComplete(ctx, a.jid("jobId"), 10*time.Millisecond, 50*time.Millisecond, nil)
	},
	"job.cancel": func(ctx context.Context, c *semiont.Client, a args) {
		_, _ = c.Job.Cancel(ctx, a.jid("jobId"))
	},
	// The first thing a worker's claims hand out: claiming begins when they are first ranged over.
	"job.claim": func(ctx context.Context, c *semiont.Client, a args) {
		stated := a.stated("options", "accepts")
		claims := c.Job.Claim(decodeInto[[]api.JobFilter](a, stated["accepts"]))
		defer claims.Close()
		for range claims.All() {
			return
		}
	},
	"auth.me": func(ctx context.Context, c *semiont.Client, a args) { _, _ = c.Auth.Me(ctx) },
	"auth.mediaToken": func(ctx context.Context, c *semiont.Client, a args) {
		_, _ = c.Auth.MediaToken(ctx, a.rid("resourceId"))
	},
	"auth.protectedResourceMetadata": func(ctx context.Context, c *semiont.Client, a args) {
		_, _ = c.Auth.ProtectedResourceMetadata(ctx)
	},
	"system.healthCheck": func(ctx context.Context, c *semiont.Client, a args) { _, _ = c.System.HealthCheck(ctx) },
	"system.status":      func(ctx context.Context, c *semiont.Client, a args) { _, _ = c.System.Status(ctx) },
}

// decodeOnto is value with what raw states written over it.
func decodeOnto[T any](a args, raw json.RawMessage, value T) T {
	a.t.Helper()
	if err := json.Unmarshal(raw, &value); err != nil {
		a.t.Fatalf("%s: %v", a.method, err)
	}
	return value
}

// firstPayload is the payload of the first event events gives.
func firstPayload[P any](events iter.Seq2[semiont.Delivered[P], error]) (P, error) {
	for event, err := range events {
		return event.Payload, err
	}
	var none P
	return none, fmt.Errorf("the events ended with none")
}

// events is every method that gives the events of a channel: what the next
// one carried. The reader is taken when the method is called, before the
// frame is published.
var events = map[string]func(c *semiont.Client) func() (any, error){
	"job.queued": func(c *semiont.Client) func() (any, error) {
		e := c.Job.Queued()
		return func() (any, error) { return firstPayload(e) }
	},
	"job.progress": func(c *semiont.Client) func() (any, error) {
		e := c.Job.Progress()
		return func() (any, error) { return firstPayload(e) }
	},
	"job.complete": func(c *semiont.Client) func() (any, error) {
		e := c.Job.Complete()
		return func() (any, error) { return firstPayload(e) }
	},
	"job.fail": func(c *semiont.Client) func() (any, error) {
		e := c.Job.Fail()
		return func() (any, error) { return firstPayload(e) }
	},
}

// surfaceWorld is a client over doubles nothing is scripted to answer but what a
// case states, which record what was asked of each.
type surfaceWorld struct {
	transport *bustest.Fake
	content   *bustest.RecordingContent
	gateway   *bustest.RecordingGateway
	client    *semiont.Client
	ctx       context.Context
	cancel    context.CancelFunc
	calls     sync.WaitGroup
}

func newSurfaceWorld() *surfaceWorld {
	w := &surfaceWorld{transport: bustest.NewFake(), content: &bustest.RecordingContent{}, gateway: &bustest.RecordingGateway{}}
	w.client = semiont.NewClient(semiont.ClientConfig{Transport: w.transport, Content: w.content, Gateway: w.gateway, Timing: semiont.DefaultTiming()})
	w.ctx, w.cancel = context.WithCancel(context.Background())
	return w
}

// start runs a call on a goroutine of its own.
func (w *surfaceWorld) start(work func(ctx context.Context)) {
	w.calls.Add(1)
	go func() {
		defer w.calls.Done()
		work(w.ctx)
	}()
}

// over ends the client and every call still waiting.
func (w *surfaceWorld) over() {
	w.cancel()
	w.client.Close()
	w.transport.Close()
	w.calls.Wait()
}

// eventually waits, a second at most, for seen to give something.
func eventually[T any](t *testing.T, what string, seen func() (T, bool)) T {
	t.Helper()
	for range 200 {
		if found, ok := seen(); ok {
			return found
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("%s did not happen", what)
	panic("unreachable")
}

// within is what next gives, a second at most.
func within[T any](t *testing.T, what string, next func() T) T {
	t.Helper()
	got := make(chan T, 1)
	go func() { got <- next() }()
	select {
	case value := <-got:
		return value
	case <-time.After(time.Second):
		t.Fatalf("%s did not happen", what)
		panic("unreachable")
	}
}

// step is what one step of a case goes through: the kind, and what it names.
func step(t *testing.T, via map[string]string) (kind, named string) {
	t.Helper()
	if len(via) != 1 {
		t.Fatalf("a step goes through exactly one thing, and this one names %v", via)
	}
	for kind, named := range via {
		return kind, named
	}
	panic("unreachable")
}

// heldTo holds one step of a case to what was done: the kind's at-th call,
// and what it was given.
func heldTo(t *testing.T, w *surfaceWorld, kind, named string, at int, sends any, why string) {
	t.Helper()
	switch kind {
	case "request":
		sent := eventually(t, why+": a request on "+named, func() (bustest.Requested, bool) {
			_, requests := w.transport.Sent()
			if len(requests) > at {
				return requests[at], true
			}
			return bustest.Requested{}, false
		})
		if string(sent.Channel) != named {
			t.Fatalf("%s: requested on %s, the row says %s", why, sent.Channel, named)
		}
		if !reflect.DeepEqual(normal(t, sent.Payload), sends) {
			t.Fatalf("%s: what was sent\n got: %v\nwant: %v", why, normal(t, sent.Payload), sends)
		}
		if !sent.Scope.IsZero() {
			t.Fatalf("%s: it is sent globally, and went on %s's scope", why, sent.Scope)
		}
	case "emit":
		sent := eventually(t, why+": a frame on "+named, func() (bustest.Emitted, bool) {
			emits, _ := w.transport.Sent()
			if len(emits) > at {
				return emits[at], true
			}
			return bustest.Emitted{}, false
		})
		if string(sent.Channel) != named {
			t.Fatalf("%s: emitted on %s, the row says %s", why, sent.Channel, named)
		}
		if !reflect.DeepEqual(normal(t, sent.Payload), sends) {
			t.Fatalf("%s: what was sent\n got: %v\nwant: %v", why, normal(t, sent.Payload), sends)
		}
		if !sent.Scope.IsZero() {
			t.Fatalf("%s: it is sent globally, and went on %s's scope", why, sent.Scope)
		}
	case "content":
		made := eventually(t, why+": a call of the content transport", func() (bustest.ContentCall, bool) {
			calls := w.content.Calls()
			if len(calls) > at {
				return calls[at], true
			}
			return bustest.ContentCall{}, false
		})
		given := map[string]any{"resourceId": made.Resource.String()}
		if made.Put != nil {
			given = map[string]any{"name": made.Put.Name, "content": string(made.Put.Bytes), "format": made.Put.Format, "storageUri": made.Put.StorageURI}
			if made.Put.CloneToken != "" {
				given["cloneToken"] = made.Put.CloneToken
			}
		}
		if made.Operation != named {
			t.Fatalf("%s: called %s of the content transport, the row says %s", why, made.Operation, named)
		}
		if !reflect.DeepEqual(normal(t, given), sends) {
			t.Fatalf("%s: what it was given\n got: %v\nwant: %v", why, normal(t, given), sends)
		}
	case "gateway":
		made := eventually(t, why+": a call of the gateway", func() (bustest.GatewayCall, bool) {
			calls := w.gateway.Calls()
			if len(calls) > at {
				return calls[at], true
			}
			return bustest.GatewayCall{}, false
		})
		given := map[string]any{}
		if !made.Resource.IsZero() {
			given["resourceId"] = made.Resource.String()
		}
		if made.Operation != named {
			t.Fatalf("%s: called %s of the gateway, the row says %s", why, made.Operation, named)
		}
		if !reflect.DeepEqual(normal(t, given), sends) {
			t.Fatalf("%s: what it was given\n got: %v\nwant: %v", why, normal(t, given), sends)
		}
	default:
		t.Fatalf("%s: a step through %s is not one this runner holds", why, kind)
	}
}

// rowCase is one case of one row this SDK has.
type rowCase struct {
	name string
	row  surfaceRow
	c    surfaceCase
}

func surfaceCases(t *testing.T, table surfaceTable) []rowCase {
	var found []rowCase
	for _, namespace := range table.Namespaces {
		for _, row := range namespace.Methods {
			if _, absent := row.Absent[sdk]; absent {
				continue
			}
			for _, c := range row.Cases {
				found = append(found, rowCase{name: namespace.Namespace + "." + row.Method, row: row, c: c})
			}
		}
	}
	return found
}

func TestAMethodDoesWhatItsRowSays(t *testing.T) {
	table := readSurface(t)
	for _, rc := range surfaceCases(t, table) {
		why := rc.c.Why
		if why == "" {
			why = "as stated"
		}
		t.Run(rc.name+" ("+why+")", func(t *testing.T) {
			t.Parallel()
			why := rc.name + " (" + why + ")"
			kind, channel := step(t, rc.row.Via)
			given := map[string]json.RawMessage{}
			for name, raw := range rc.c.Args {
				given[name] = resolved(t, table.Fixtures, raw)
			}
			a := args{t: t, method: rc.name, given: given}
			var sends any
			if err := json.Unmarshal(resolved(t, table.Fixtures, rc.c.Sends), &sends); err != nil {
				t.Fatal(err)
			}

			w := newSurfaceWorld()
			defer w.over()
			if len(rc.c.Answers) > 0 {
				reply := json.RawMessage(`{}`)
				if string(rc.c.Answers) != "null" {
					reply = json.RawMessage(fmt.Sprintf(`{"response":%s}`, resolved(t, table.Fixtures, rc.c.Answers)))
				}
				w.transport.Replies[bus.Channel(channel)] = reply
			}

			switch kind {
			case "local":
				run, ok := calls[rc.name]
				if !ok {
					t.Fatalf("this runner has no call of %s", rc.name)
				}
				published := w.client.Bus.FramesOn(bus.Channel(channel), api.ResourceId{})
				w.start(func(ctx context.Context) { run(ctx, w.client, a) })
				frame := within(t, why+": a frame published on "+channel, func() semiont.Frame {
					for frame := range published {
						return frame
					}
					return semiont.Frame{}
				})
				if !reflect.DeepEqual(normal(t, frame.Payload), sends) {
					t.Fatalf("%s: what was published\n got: %v\nwant: %v", why, normal(t, frame.Payload), sends)
				}
				var correlationID string
				if rc.c.CorrelationID != nil {
					correlationID = *rc.c.CorrelationID
				}
				if frame.CorrelationID != correlationID {
					t.Fatalf("%s: the key on its envelope is %q, the case says %q", why, frame.CorrelationID, correlationID)
				}
				time.Sleep(20 * time.Millisecond)
				if emits, requests := w.transport.Sent(); len(emits)+len(requests) > 0 {
					t.Fatalf("%s: a signal never reaches the wire, and %d frames did", why, len(emits)+len(requests))
				}
			case "observes":
				hear, ok := events[rc.name]
				if !ok {
					t.Fatalf("this runner has no reading of %s", rc.name)
				}
				next := hear(w.client)
				payload, err := json.Marshal(sends)
				if err != nil {
					t.Fatal(err)
				}
				w.client.Bus.Deliver(semiont.Frame{Channel: bus.Channel(channel), Payload: payload})
				type heard struct {
					payload any
					err     error
				}
				got := within(t, why+": an event of "+channel, func() heard {
					payload, err := next()
					return heard{payload, err}
				})
				if got.err != nil {
					t.Fatalf("%s: %v", why, got.err)
				}
				if !reflect.DeepEqual(normal(t, got.payload), sends) {
					t.Fatalf("%s: what was heard\n got: %v\nwant: %v", why, normal(t, got.payload), sends)
				}
			default:
				run, ok := calls[rc.name]
				if !ok {
					t.Fatalf("this runner has no call of %s", rc.name)
				}
				w.start(func(ctx context.Context) { run(ctx, w.client, a) })
				made := map[string]int{}
				heldTo(t, w, kind, channel, made[kind], sends, why)
				made[kind]++
				for _, further := range rc.c.Then {
					var furtherSends any
					if err := json.Unmarshal(resolved(t, table.Fixtures, further["sends"]), &furtherSends); err != nil {
						t.Fatal(err)
					}
					via := map[string]string{}
					for name, raw := range further {
						if name != "sends" {
							var named string
							if err := json.Unmarshal(raw, &named); err != nil {
								t.Fatal(err)
							}
							via[name] = named
						}
					}
					furtherKind, furtherNamed := step(t, via)
					heldTo(t, w, furtherKind, furtherNamed, made[furtherKind], furtherSends, why)
					made[furtherKind]++
				}
			}
		})
	}
}

func TestTheTableAndThisSDKListTheSameMethods(t *testing.T) {
	table := readSurface(t)
	var rows []string
	for _, rc := range surfaceCases(t, table) {
		if !slices.Contains(rows, rc.name) {
			rows = append(rows, rc.name)
		}
	}
	var held []string
	for name := range calls {
		held = append(held, name)
	}
	for name := range events {
		held = append(held, name)
	}
	sort.Strings(rows)
	sort.Strings(held)
	if !slices.Equal(rows, held) {
		t.Fatalf("the table's methods and this runner's differ\ntable:  %v\nrunner: %v", rows, held)
	}
}
