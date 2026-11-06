package semiont_test

// A list a schema requires is Go's slice, and a slice Go holds as nil is the
// empty list: a generated type writes it as [], never as null, so the
// payload a caller publishes is one a typed reader of it takes.

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/internal/required"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/semionttest"
)

func TestARequiredListLeftNilIsPublishedOnTheClientsOwnBusAsTheEmptyList(t *testing.T) {
	resource, err := api.ParseResourceId("res-1")
	if err != nil {
		t.Fatal(err)
	}
	b := semiont.NewEventBus()
	channel := bus.MarkUpdateEntityTypes.Request()
	read := semiont.Published(context.Background(), b, channel)
	if err := semiont.Publish(b, channel, api.MarkUpdateEntityTypesCommand{ResourceId: resource}, semiont.Envelope{}); err != nil {
		t.Fatal(err)
	}
	b.Close()
	want := api.MarkUpdateEntityTypesCommand{CurrentEntityTypes: []string{}, ResourceId: resource, UpdatedEntityTypes: []string{}}
	for delivered, err := range read {
		if err != nil {
			t.Fatalf("the reader was given %v", err)
		}
		if !reflect.DeepEqual(delivered.Payload, want) {
			t.Fatalf("the reader was given %+v, want %+v", delivered.Payload, want)
		}
		return
	}
	t.Fatal("the reader was given nothing")
}

func TestARequiredListLeftNilIsEmittedAsTheEmptyList(t *testing.T) {
	resource, err := api.ParseResourceId("res-1")
	if err != nil {
		t.Fatal(err)
	}
	annotation, err := api.ParseAnnotationId("ann-1")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w := semiont.NewWire(semionttest.NewFaultyTransport(semionttest.FaultyConfig{}))
	read, err := semiont.Frames(ctx, w, bus.BindInitiate)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := semiont.Emit(ctx, w, bus.BindInitiate, api.BindInitiateCommand{AnnotationId: annotation, ResourceId: resource, DefaultTitle: "A title"}, semiont.Envelope{}); err != nil {
		t.Fatal(err)
	}
	want := api.BindInitiateCommand{AnnotationId: annotation, ResourceId: resource, DefaultTitle: "A title", EntityTypes: []string{}}
	for delivered, err := range read {
		if err != nil {
			t.Fatalf("the reader was given %v", err)
		}
		if !reflect.DeepEqual(delivered.Payload, want) {
			t.Fatalf("the reader was given %+v, want %+v", delivered.Payload, want)
		}
		return
	}
	t.Fatal("the reader was given nothing")
}

// listCase is a value of a generated type that holds a required list as
// nil, made afresh each time it is asked for.
type listCase struct {
	where string
	of    reflect.Type
	made  func() (any, error)
}

func listCaseOf[T any](where, stated string) listCase {
	return listCase{where: where, of: reflect.TypeFor[T](), made: func() (any, error) {
		var value T
		err := json.Unmarshal([]byte(stated), &value)
		return value, err
	}}
}

// Wherever a generated type holds a required list, among its own members or
// within the objects its members hold, it is written as the empty list, and
// the caller's value is left as it was.
func TestEveryRequiredListLeftNilIsWrittenAsTheEmptyList(t *testing.T) {
	cases := []listCase{
		listCaseOf[api.KnowledgeGraph]("a list among the value's own members", `{}`),
		listCaseOf[api.MarkCommitOk]("a list within an object a member holds", `{}`),
		listCaseOf[api.GatheredContext]("a list within an object an optional member holds",
			`{"focus":{"kind":"resource","resource":{"@context":"https://schema.org","@id":"res-1","name":"A resource","representations":[]}},"graph":{"nodes":[],"edges":[]},"metadata":{},"semanticContext":{}}`),
		listCaseOf[api.AnchoredTextExtractedEntry]("a list within each object a list holds",
			`{"v":3,"stamp":"a stamp","text":"","method":"pdf-text-layer","lines":[{"p":1,"y":0,"h":0},{"p":2,"y":0,"h":0}]}`),
	}
	for _, c := range cases {
		value, err := c.made()
		if err != nil {
			t.Fatalf("%s: %v", c.where, err)
		}
		before, err := c.made()
		if err != nil {
			t.Fatalf("%s: %v", c.where, err)
		}
		written, err := json.Marshal(value)
		if err != nil {
			t.Fatalf("%s: %v", c.where, err)
		}
		if fault, faulty := required.FaultOf(written, c.of); faulty {
			t.Errorf("%s: %s is written as %s, and a reader of it finds that %s", c.where, c.of.Name(), written, fault)
		}
		if !reflect.DeepEqual(value, before) {
			t.Errorf("%s: writing %s changed it to %+v", c.where, c.of.Name(), value)
		}
	}
}
