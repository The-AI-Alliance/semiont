// Package mediatypes reads the media-type registry
// (specs/src/media-types/registry.json): the types a knowledge base admits.
// The table is generated (registry_gen.go); the rules read from it are here,
// the ones specs/src/media-types/cases.json holds in every SDK among them: the
// format a clone takes, the name content is stored under, and where a type's
// text comes from, with what follows from that.
package mediatypes

import (
	"fmt"
	"strings"
	"unicode"
)

// byExtension: each extension a row states, with the first row that states it.
var byExtension = func() map[string]string {
	m := make(map[string]string, len(Rows))
	for _, row := range Rows {
		if _, stated := m[row.Extension]; !stated {
			m[row.Extension] = row.MediaType
		}
	}
	return m
}()

// ForExtension is the media type a file's extension names, and false for an
// extension no row states: a caller chooses its own fallback. It takes "md" or
// ".md" in any case, and the registry's aliases (".markdown", ".yml").
func ForExtension(ext string) (string, bool) {
	ext = strings.ToLower(strings.TrimSpace(ext))
	if !strings.HasPrefix(ext, ".") {
		ext = "." + ext
	}
	if stated, ok := ExtensionAliases[ext]; ok {
		ext = stated
	}
	mediaType, ok := byExtension[ext]
	return mediaType, ok
}

// byMediaType: each row, by its media type.
var byMediaType = func() map[string]Row {
	m := make(map[string]Row, len(Rows))
	for _, row := range Rows {
		m[row.MediaType] = row
	}
	return m
}()

// plainText is the row a clone of a source nobody authors takes.
var plainText = byMediaType["text/plain"]

// BaseMediaType is format without its parameters ("; charset=…"), in lower
// case.
func BaseMediaType(format string) string {
	base, _, _ := strings.Cut(format, ";")
	return strings.ToLower(strings.TrimSpace(base))
}

// CapabilitiesOf is the registry's row for format, whose parameters are not
// read, and false for a type the registry does not have: a stored type may be
// one it lacks, since what was imported keeps the type it came with.
func CapabilitiesOf(format string) (Row, bool) {
	row, ok := byMediaType[BaseMediaType(format)]
	return row, ok
}

// CloneFormat is the format a clone of a resource takes: its source's, when
// that is one a person can author, and plain text otherwise. A clone opens
// where a person writes. A source of "" is a resource that states none.
func CloneFormat(source string) Row {
	if row, ok := CapabilitiesOf(source); ok && row.Authorable {
		return row
	}
	return plainText
}

// StorageFileName is the name a resource's content is stored under: its
// title in lower case, every run of characters that are not a to z or 0 to 9
// made one hyphen, none at either end, and then the format's extension.
func StorageFileName(name string, format Row) string {
	var kept []rune
	for _, character := range lowered(name) {
		if character >= 'a' && character <= 'z' || character >= '0' && character <= '9' {
			kept = append(kept, character)
		} else if len(kept) == 0 || kept[len(kept)-1] != '-' {
			kept = append(kept, '-')
		}
	}
	return strings.Trim(string(kept), "-") + format.Extension
}

// lowered is text in lower case by Unicode's full mapping, as the other SDKs
// lower a title. Go's own is the simple mapping, which differs in one
// character of SpecialCasing.txt that lowers whatever its context: U+0130,
// whose lower case is i and a combining dot above.
func lowered(text string) string {
	var out strings.Builder
	for _, character := range text {
		if character == '\u0130' {
			out.WriteString("i\u0307")
			continue
		}
		out.WriteRune(unicode.ToLower(character))
	}
	return out.String()
}

// StorageURI is the file:// URI of StorageFileName: where the content is
// stored, at the root of the working tree.
func StorageURI(name string, format Row) string {
	return "file://" + StorageFileName(name, format)
}

// TextSourceOf is where the text of a resource of format comes from; the
// format's parameters and its case are not read. TextSourceDecode: its bytes
// are its text, in some charset. TextSourcePdfTextLayer: its text is read out
// of it by the Smelter, which also says where each run of the text is on a
// page. TextSourceNone: it has no text.
//
// A type the registry has answers as its row says. One it lacks is decoded
// when it is a text/ type, which is text by what the type says of itself,
// and has no text otherwise.
func TextSourceOf(format string) TextSource {
	if row, ok := CapabilitiesOf(format); ok {
		return row.TextSource
	}
	if strings.HasPrefix(BaseMediaType(format), "text/") {
		return TextSourceDecode
	}
	return TextSourceNone
}

// YieldsGeometryOf is whether the text of a resource of format comes with
// where each run of it is on a page. It follows from where the text comes
// from: a text read out of a PDF does, and one decoded from its bytes does
// not.
func YieldsGeometryOf(format string) bool {
	switch source := TextSourceOf(format); source {
	case TextSourcePdfTextLayer:
		return true
	case TextSourceDecode, TextSourceNone:
		return false
	default:
		panic(unanswered(source))
	}
}

// DerivesTextOf is whether the text of a resource of format is derived from
// its bytes, by the Smelter, and not decoded from them. A reader of a
// resource's text asks this to know where to read it: a derived text is the
// anchored text's, and a decoded one is semiont.DecodeRepresentation's, which
// refuses every other type. It is another question than YieldsGeometryOf,
// though no text source yet answers the two differently: a text transcribed
// from a recording would be derived, and on no page.
func DerivesTextOf(format string) bool {
	switch source := TextSourceOf(format); source {
	case TextSourcePdfTextLayer:
		return true
	case TextSourceDecode, TextSourceNone:
		return false
	default:
		panic(unanswered(source))
	}
}

// unanswered is what a rule says of a text source the registry came to name
// before the rule answered it. The registry's every word is held to each rule
// by this package's tests, so it fails there first.
func unanswered(source TextSource) string {
	return fmt.Sprintf("the registry names a text source no rule answers: %q", source)
}
