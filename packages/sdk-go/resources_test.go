package semiont_test

// What text a resource's bytes are, and what the readers of a resource's
// description answer, held to the tables every SDK runs:
// specs/src/text/decode-cases.json (written by hand: what is said of a content
// type, of a media type whose text is not its bytes, of a label, of a
// byte-order mark and of malformed UTF-8 and UTF-16),
// specs/src/text/encoding-cases.json (generated: every label of the Encoding
// Standard, and every byte of each of its single-byte encodings) and
// specs/src/resources/reader-cases.json.

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/mediatypes"
)

// strictly decodes data into into, refusing a member into does not read: a
// member this runner does not read would be a rule this SDK is not held to.
func strictly(t *testing.T, data []byte, into any) {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(into); err != nil {
		t.Fatalf("%s: %v", data, err)
	}
}

func readSpec(t *testing.T, path ...string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(append([]string{"..", "..", "specs", "src"}, path...)...))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func bytesOf(t *testing.T, hexadecimal string) []byte {
	t.Helper()
	data, err := hex.DecodeString(strings.ReplaceAll(hexadecimal, " ", ""))
	if err != nil {
		t.Fatalf("%q is not bytes in hexadecimal: %v", hexadecimal, err)
	}
	return data
}

// refusedNaming holds that err is the reader's refusal, a *TransportError
// whose code is error, and that it names what it refuses.
func refusedNaming(t *testing.T, why string, err error, named string) {
	t.Helper()
	var refusal *semiont.TransportError
	if !errors.As(err, &refusal) {
		t.Errorf("%s: read, or failed as %v, and the table says it is refused, naming %q", why, err, named)
		return
	}
	if refusal.Code != semiont.TransportErrorCodeError || !strings.Contains(refusal.Message, named) {
		t.Errorf("%s: refused as %s %q, and the table says the refusal is an error naming %q", why, refusal.Code, refusal.Message, named)
	}
}

type decodeCase struct {
	Why         string  `json:"why"`
	ContentType string  `json:"contentType"`
	Bytes       string  `json:"bytes"`
	Text        *string `json:"text"`
	Refused     *string `json:"refused"`
}

func TestAResourcesBytesAreTheTextTheTableSays(t *testing.T) {
	var table struct {
		Comment string            `json:"$comment"`
		Cases   []json.RawMessage `json:"cases"`
	}
	strictly(t, readSpec(t, "text", "decode-cases.json"), &table)
	if len(table.Cases) < 90 {
		t.Fatalf("the table has %d cases: it was not read", len(table.Cases))
	}
	read, refusedOf := 0, map[mediatypes.TextSource]bool{}
	for _, raw := range table.Cases {
		var stated decodeCase
		strictly(t, raw, &stated)
		data := bytesOf(t, stated.Bytes)
		text, err := semiont.DecodeRepresentation(data, stated.ContentType)
		switch {
		case stated.Text != nil && stated.Refused == nil:
			read++
			if err != nil {
				t.Errorf("%s: refused as %v, and the table says the text is %q", stated.Why, err, *stated.Text)
			} else if text != *stated.Text {
				t.Errorf("%s: read %q, and the table says %q", stated.Why, text, *stated.Text)
			}
		case stated.Refused != nil && stated.Text == nil:
			refusedOf[mediatypes.TextSourceOf(stated.ContentType)] = true
			refusedNaming(t, stated.Why, err, *stated.Refused)
		default:
			t.Errorf("%s: a case states a text or a refusal, and only one", stated.Why)
		}
	}
	if read == 0 {
		t.Error("no case is a text")
	}
	// A refusal is of a charset, where the type is one that is decoded, or of
	// the type itself: the table has one whose text is derived from its
	// bytes, and one with no text.
	if !reflect.DeepEqual(refusedOf, map[mediatypes.TextSource]bool{mediatypes.TextSourceDecode: true, mediatypes.TextSourcePdfTextLayer: true, mediatypes.TextSourceNone: true}) {
		t.Errorf("the refusals are of types whose text comes from %v, and must be of each", refusedOf)
	}
}

type encodingCase struct {
	Encoding  string   `json:"encoding"`
	Labels    []string `json:"labels"`
	EveryByte *string  `json:"everyByte"`
	Bytes     *string  `json:"bytes"`
	Text      *string  `json:"text"`
	Refused   *bool    `json:"refused"`
}

type encodingTable struct {
	Comment string            `json:"$comment"`
	Cases   []json.RawMessage `json:"cases"`
}

func readEncodings(t *testing.T) []encodingCase {
	t.Helper()
	var table encodingTable
	strictly(t, readSpec(t, "text", "encoding-cases.json"), &table)
	cases := make([]encodingCase, 0, len(table.Cases))
	for _, raw := range table.Cases {
		var stated encodingCase
		strictly(t, raw, &stated)
		cases = append(cases, stated)
	}
	return cases
}

func TestEveryLabelOfTheStandardNamesItsEncodingAndEveryByteIsItsCharacter(t *testing.T) {
	cases := readEncodings(t)
	everyByte := make([]byte, 256)
	for i := range everyByte {
		everyByte[i] = byte(i)
	}
	singleByte, probed, refused, labels := 0, 0, 0, 0
	for _, stated := range cases {
		for _, label := range stated.Labels {
			labels++
			contentType := "text/plain; charset=" + label
			why := stated.Encoding + ": " + label
			switch {
			case stated.EveryByte != nil:
				if text, err := semiont.DecodeRepresentation(everyByte, contentType); err != nil || text != *stated.EveryByte {
					t.Errorf("%s: read %q (%v), and the table says %q", why, text, err, *stated.EveryByte)
				}
			case stated.Bytes != nil && stated.Text != nil:
				if text, err := semiont.DecodeRepresentation(bytesOf(t, *stated.Bytes), contentType); err != nil || text != *stated.Text {
					t.Errorf("%s: read %q (%v), and the table says %q", why, text, err, *stated.Text)
				}
			case stated.Refused != nil && *stated.Refused:
				_, err := semiont.DecodeRepresentation(everyByte, contentType)
				refusedNaming(t, why, err, label)
			default:
				t.Fatalf("%s: a case of no kind this runner knows", why)
			}
		}
		switch {
		case stated.EveryByte != nil:
			singleByte++
		case stated.Bytes != nil:
			probed++
		default:
			refused++
		}
	}
	if singleByte < 29 || probed == 0 || refused == 0 || labels < 180 {
		t.Errorf("the table was not read: %d single-byte encodings, %d probed, %d refused, %d labels", singleByte, probed, refused, labels)
	}
}

func TestEveryReaderOfAResourceGivesWhatTheTableSays(t *testing.T) {
	var table struct {
		Comment string            `json:"$comment"`
		Cases   []json.RawMessage `json:"cases"`
	}
	strictly(t, readSpec(t, "resources", "reader-cases.json"), &table)
	if len(table.Cases) == 0 {
		t.Fatal("the table has no case")
	}
	shapes := map[string]bool{}
	for _, raw := range table.Cases {
		var stated struct {
			Why                   string          `json:"why"`
			Resource              json.RawMessage `json:"resource"`
			EntityTypes           []string        `json:"entityTypes"`
			PrimaryRepresentation json.RawMessage `json:"primaryRepresentation"`
			PrimaryMediaType      *string         `json:"primaryMediaType"`
		}
		strictly(t, raw, &stated)
		var resource api.ResourceDescriptor
		if err := json.Unmarshal(stated.Resource, &resource); err != nil {
			t.Fatalf("%s: the resource is not a ResourceDescriptor: %v", stated.Why, err)
		}
		representation, ok := semiont.PrimaryRepresentation(resource)
		switch {
		case stated.PrimaryRepresentation == nil && ok:
			t.Errorf("%s: a primary representation, and the table says there is none", stated.Why)
		case stated.PrimaryRepresentation != nil && !ok:
			t.Errorf("%s: no primary representation, and the table says there is one", stated.Why)
		case ok:
			written, err := json.Marshal(representation)
			if err != nil {
				t.Fatal(err)
			}
			if !sameJSON(t, written, stated.PrimaryRepresentation) {
				t.Errorf("%s: the primary representation is %s, and the table says %s", stated.Why, written, stated.PrimaryRepresentation)
			}
		}
		mediaType, ok := semiont.PrimaryMediaType(resource)
		if (stated.PrimaryMediaType == nil) == ok || (ok && mediaType != *stated.PrimaryMediaType) {
			t.Errorf("%s: the primary media type is (%q, %v), and the table says %v", stated.Why, mediaType, ok, stated.PrimaryMediaType)
		}
		if got := semiont.ResourceEntityTypes(resource); !reflect.DeepEqual(got, stated.EntityTypes) {
			t.Errorf("%s: the entity types are %q, and the table says %q", stated.Why, got, stated.EntityTypes)
		}
		// What the cases must tell apart: one representation from a list of
		// them, the first of a list from the others, a resource with none, and
		// a resource that states entity types from one that states none.
		var representations any
		if err := json.Unmarshal(mustField(t, stated.Resource, "representations"), &representations); err != nil {
			t.Fatal(err)
		}
		switch listed := representations.(type) {
		case map[string]any:
			shapes["one"] = true
		case []any:
			shapes["none"] = shapes["none"] || len(listed) == 0
			shapes["list"] = shapes["list"] || len(listed) > 1
		}
		shapes["entity types"] = shapes["entity types"] || len(stated.EntityTypes) > 0
		shapes["no entity types"] = shapes["no entity types"] || len(stated.EntityTypes) == 0
	}
	for _, shape := range []string{"one", "list", "none", "entity types", "no entity types"} {
		if !shapes[shape] {
			t.Errorf("no case's resource has %s", shape)
		}
	}
}

func mustField(t *testing.T, object json.RawMessage, name string) json.RawMessage {
	t.Helper()
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(object, &fields); err != nil {
		t.Fatal(err)
	}
	field, ok := fields[name]
	if !ok {
		t.Fatalf("%s states no %s", object, name)
	}
	return field
}

func sameJSON(t *testing.T, a, b []byte) bool {
	t.Helper()
	var left, right any
	if err := json.Unmarshal(a, &left); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &right); err != nil {
		t.Fatal(err)
	}
	return reflect.DeepEqual(left, right)
}
