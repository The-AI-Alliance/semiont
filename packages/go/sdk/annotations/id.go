package annotations

// The id of an annotation a builder makes.
//
// The id is not minted: it is worked out from what the annotation is, so the
// same annotation built again, by any worker in any language, has the same
// id, and writing it a second time changes nothing.
// specs/src/annotations/id-cases.json holds the rule, for this and for every
// other SDK.

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// idLength is how many characters of the digest's base64url an id is.
const idLength = 21

// annotationID is the id of the annotation of resource that has this
// motivation, this anchor and this body. anchor says where on the resource
// the annotation is, and is empty for an annotation of the resource as a
// whole. body is the body as the wire carries it, and nil for an annotation
// that has none: an annotation's body is never null.
func annotationID(resource api.ResourceId, motivation api.Motivation, anchor string, body json.RawMessage) (api.AnnotationId, error) {
	identity := map[string]any{"resourceId": resource.String(), "motivation": string(motivation), "anchor": anchor}
	if body != nil {
		decoder := json.NewDecoder(bytes.NewReader(body))
		decoder.UseNumber()
		var stated any
		if err := decoder.Decode(&stated); err != nil {
			return api.AnnotationId{}, fmt.Errorf("an annotation's body is not JSON: %w", err)
		}
		identity["body"] = stated
	}
	var text strings.Builder
	if err := canonical(&text, identity); err != nil {
		return api.AnnotationId{}, err
	}
	digest := sha256.Sum256([]byte(text.String()))
	return api.ParseAnnotationId(base64.URLEncoding.EncodeToString(digest[:])[:idLength])
}

// canonical writes value as the rule's canonical JSON: no white space, an
// object's members in the order of their names by code point at every depth,
// a whole number as its decimal digits, and a string with the escapes the
// rule states and no other. A Go string compares byte by byte in UTF-8, which
// is the order of its code points.
func canonical(out *strings.Builder, value any) error {
	switch value := value.(type) {
	case nil:
		out.WriteString("null")
	case bool:
		out.WriteString(strconv.FormatBool(value))
	case json.Number:
		whole, err := wholeNumber(value)
		if err != nil {
			return err
		}
		out.WriteString(strconv.FormatInt(whole, 10))
	case string:
		quoted(out, value)
	case []any:
		out.WriteByte('[')
		for i, item := range value {
			if i > 0 {
				out.WriteByte(',')
			}
			if err := canonical(out, item); err != nil {
				return err
			}
		}
		out.WriteByte(']')
	case map[string]any:
		names := make([]string, 0, len(value))
		for name := range value {
			names = append(names, name)
		}
		slices.Sort(names)
		out.WriteByte('{')
		for i, name := range names {
			if i > 0 {
				out.WriteByte(',')
			}
			quoted(out, name)
			out.WriteByte(':')
			if err := canonical(out, value[name]); err != nil {
				return err
			}
		}
		out.WriteByte('}')
	default:
		return fmt.Errorf("%T is no JSON value", value)
	}
	return nil
}

// wholeNumber is a number written as a whole one, as 2.0 is 2: the rule
// states how no other is written.
func wholeNumber(number json.Number) (int64, error) {
	if whole, err := strconv.ParseInt(number.String(), 10, 64); err == nil {
		return whole, nil
	}
	float, err := number.Float64()
	if err != nil || float != math.Trunc(float) || math.Abs(float) > 1<<53 {
		return 0, fmt.Errorf("%s is not a whole number, and the rule of an annotation's id states how no other is written", number)
	}
	return int64(float), nil
}

// quoted writes text between double quotes, escaping a double quote, a
// backslash and each character below U+0020, and nothing else.
func quoted(out *strings.Builder, text string) {
	out.WriteByte('"')
	for _, character := range text {
		switch character {
		case '"':
			out.WriteString(`\"`)
		case '\\':
			out.WriteString(`\\`)
		case '\b':
			out.WriteString(`\b`)
		case '\t':
			out.WriteString(`\t`)
		case '\n':
			out.WriteString(`\n`)
		case '\f':
			out.WriteString(`\f`)
		case '\r':
			out.WriteString(`\r`)
		default:
			if character < 0x20 {
				fmt.Fprintf(out, `\u%04x`, character)
			} else {
				out.WriteRune(character)
			}
		}
	}
	out.WriteByte('"')
}
