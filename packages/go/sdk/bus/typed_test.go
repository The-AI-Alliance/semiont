package bus

import (
	"encoding/json"
	"os"
	"slices"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// stored is a stored event of type kind, carrying payload.
func stored(t *testing.T, kind string, payload string) api.StoredEventResponse {
	t.Helper()
	var event api.StoredEventResponse
	text := `{"id":"0e2f8c0a-4a34-4a8e-9b47-0d6d5a3f8a11","type":"` + kind + `","timestamp":"2026-10-01T12:00:00.000Z",` +
		`"userId":"did:web:example.org:users:alice","resourceId":"res-1","version":1,"metadata":{"sequenceNumber":3},"payload":` + payload + `}`
	if err := json.Unmarshal([]byte(text), &event); err != nil {
		t.Fatal(err)
	}
	return event
}

func TestAChannelOfTheRecordGivesTheEventsOwnPayload(t *testing.T) {
	tagged, err := MarkEntityTagAdded.Event(stored(t, "mark:entity-tag-added", `{"entityType":"Person"}`))
	if err != nil || tagged != (api.EntityTagChangedPayload{EntityType: "Person"}) {
		t.Errorf("a tag added is %+v, %v", tagged, err)
	}
	// A frame of a channel that carries more than the stored event.
	var enriched api.EnrichedResourceEvent
	if err := json.Unmarshal([]byte(`{"id":"e-1","type":"mark:body-updated","timestamp":"2026-10-01T12:00:00.000Z","userId":"did:web:example.org:users:alice","version":1,"metadata":{"sequenceNumber":3},"payload":{"annotationId":"a-1","operations":[]}}`), &enriched); err != nil {
		t.Fatal(err)
	}
	updated, err := MarkBodyUpdated.Event(enriched)
	if err != nil || updated.AnnotationId.String() != "a-1" {
		t.Errorf("a body updated is %+v, %v", updated, err)
	}
	// And an event of the whole knowledge base, which no resource's scope carries.
	named, err := FrameEntityTypeAdded.Event(stored(t, "frame:entity-type-added", `{"entityType":"Person"}`))
	if err != nil || named != (api.EntityTypeAddedPayload{EntityType: "Person"}) {
		t.Errorf("an entity type added is %+v, %v", named, err)
	}
}

func TestAChannelOfTheRecordRefusesAStoredEventOfAnotherType(t *testing.T) {
	// A tag's adding and its removal carry the same payload: read by its payload alone, one would be taken for the other.
	untagged := stored(t, "mark:entity-tag-removed", `{"entityType":"Person"}`)
	_, err := MarkEntityTagAdded.Event(untagged)
	if err == nil || err.Error() != "mark:entity-tag-removed 0e2f8c0a-4a34-4a8e-9b47-0d6d5a3f8a11 is not a mark:entity-tag-added event" {
		t.Errorf("a tag removed, read as one added: %v", err)
	}
	if removed, err := MarkEntityTagRemoved.Event(untagged); err != nil || removed.EntityType != "Person" {
		t.Errorf("a tag removed is %+v, %v", removed, err)
	}
	if _, err := FrameTagSchemaAdded.Event(stored(t, "frame:entity-type-added", `{"entityType":"Person"}`)); err == nil {
		t.Error("an entity type added was read as a tag schema added")
	}
}

func TestTheEventsOfTheRecordAreTheRegistrysInItsOrder(t *testing.T) {
	text, err := os.ReadFile("../../../../specs/src/bus/registry.json")
	if err != nil {
		t.Fatal(err)
	}
	var registry struct {
		Channels []struct {
			Channel Channel `json:"channel"`
			Event   any     `json:"event"`
		} `json:"channels"`
	}
	if err := json.Unmarshal(text, &registry); err != nil {
		t.Fatal(err)
	}
	var ofTheRecord []Channel
	for _, stated := range registry.Channels {
		if stated.Event != nil {
			ofTheRecord = append(ofTheRecord, stated.Channel)
		}
	}
	if len(ofTheRecord) == 0 {
		t.Fatal("the registry names no event of the record: this reads nothing")
	}
	if !slices.Equal(PersistedEventTypes, ofTheRecord) {
		t.Errorf("the events of the record are %v, and the registry's are %v", PersistedEventTypes, ofTheRecord)
	}
}

func TestReplyChannelsForNamesEachOperationsRepliesOnce(t *testing.T) {
	got := ReplyChannelsFor(MarkCommit.Request().Channel(), BrowseAnnotationRequested.Request().Channel(), MarkCommit.Request().Channel(), MarkAdded.Channel())
	want := []Channel{"mark:commit-ok", "mark:commit-failed", "browse:annotation-result", "browse:annotation-failed"}
	if !slices.Equal(got, want) {
		t.Errorf("the replies are %v", got)
	}
	if none := ReplyChannelsFor(MarkAdded.Channel()); len(none) != 0 {
		t.Errorf("a channel that is no request answers %v", none)
	}
}
