package semiont

// Reading a resource: its description, and the text its bytes are.
//
// A resource's representations is one representation or a list of them, and
// its entityTypes may be left out. The readers read each, so that nothing that
// reads a resource narrows those shapes by hand. DecodeRepresentation makes a
// text of the bytes of a resource whose bytes are its text.
//
// Every SDK has these. The case tables hold each to one answer:
// specs/src/resources/reader-cases.json the readers, and
// specs/src/text/decode-cases.json with specs/src/text/encoding-cases.json the
// text. This package's tests run them.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding"
	"golang.org/x/text/encoding/japanese"
	"golang.org/x/text/encoding/korean"
	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/encoding/traditionalchinese"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/mediatypes"
)

// PrimaryRepresentation is a resource's primary representation: its one, or
// the first of its list; false for a resource with none. A resource that
// states no representations, or states one that is neither one representation
// nor a list of them, is no ResourceDescriptor and is refused, as the Rust and
// Python SDKs refuse it when they decode it. The refusal is a *TransportError
// whose code is TransportErrorCodeError.
func PrimaryRepresentation(resource api.ResourceDescriptor) (api.Representation, bool, error) {
	stated, err := resource.Representations.MarshalJSON()
	if err != nil {
		return api.Representation{}, false, noDescriptor(resource, "its representations do not read")
	}
	switch stated = bytes.TrimLeft(stated, " \t\r\n"); {
	case bytes.HasPrefix(stated, []byte("[")):
		var listed []json.RawMessage
		if err := json.Unmarshal(stated, &listed); err != nil || slices.ContainsFunc(listed, func(one json.RawMessage) bool { return !isRepresentation(one) }) {
			return api.Representation{}, false, noDescriptor(resource, "its representations are a list holding what is not a representation")
		}
		if len(listed) == 0 {
			return api.Representation{}, false, nil
		}
		list, err := resource.Representations.AsResourceDescriptorRepresentations1()
		if err != nil {
			return api.Representation{}, false, noDescriptor(resource, "its representations do not read")
		}
		return list[0], true, nil
	case isRepresentation(stated):
		one, err := resource.Representations.AsRepresentation()
		if err != nil {
			return api.Representation{}, false, noDescriptor(resource, "its representation does not read")
		}
		return one, true, nil
	case bytes.Equal(stated, []byte("null")):
		return api.Representation{}, false, noDescriptor(resource, "it states no representations")
	default:
		return api.Representation{}, false, noDescriptor(resource, "its representations are neither one representation nor a list of them")
	}
}

// isRepresentation is whether raw is a representation as its schema has one:
// an object that states its media type as text.
func isRepresentation(raw json.RawMessage) bool {
	var stated struct {
		MediaType *string `json:"mediaType"`
	}
	return bytes.HasPrefix(bytes.TrimLeft(raw, " \t\r\n"), []byte("{")) && json.Unmarshal(raw, &stated) == nil && stated.MediaType != nil
}

// noDescriptor refuses resource as no ResourceDescriptor, for why.
func noDescriptor(resource api.ResourceDescriptor, why string) error {
	return transportErrorWithoutResponse(fmt.Sprintf("The resource %s is no ResourceDescriptor: %s", resource.Id, why), TransportErrorCodeError)
}

// PrimaryMediaType is the media type of a resource's primary representation,
// as it is stated; false for a resource with none. A resource that is no
// ResourceDescriptor is refused, as PrimaryRepresentation refuses it.
func PrimaryMediaType(resource api.ResourceDescriptor) (string, bool, error) {
	representation, ok, err := PrimaryRepresentation(resource)
	return representation.MediaType, ok, err
}

// ResourceEntityTypes is the entity types a resource states, in the order it
// states them: none for a resource that states none.
func ResourceEntityTypes(resource api.ResourceDescriptor) []string {
	if resource.EntityTypes == nil {
		return []string{}
	}
	return slices.Clone(*resource.EntityTypes)
}

// What a content type is made of, as the MIME Sniffing Standard reads one:
// its white space, and the characters of a type, a subtype and a parameter's
// name.
const (
	httpWhiteSpace  = "\n\r\t "
	httpTokenMarks  = "!#$%&'*+-.^_`|~"
	asciiWhiteSpace = "\t\n\f\r "
)

// The Encoding Standard's encodings this reader decodes without a table of
// its own.
const (
	encodingUTF8    = "utf-8"
	encodingUTF16BE = "utf-16be"
	encodingUTF16LE = "utf-16le"
)

// encodingOfLabel, singleByte and refused are the standard's tables
// (encodings_gen.go), by label and by encoding.
var (
	encodingOfLabel = func() map[string]string {
		m := make(map[string]string, len(labelsOfEncodings))
		for _, named := range labelsOfEncodings {
			m[named.label] = named.encoding
		}
		return m
	}()
	singleByte = func() map[string][]rune {
		m := make(map[string][]rune, len(singleByteEncodings))
		for _, stated := range singleByteEncodings {
			m[stated.encoding] = []rune(stated.everyByte)
		}
		return m
	}()
)

// The byte-order marks, each with the encoding it is the mark of, in the
// order the Encoding Standard looks for them.
var marks = []struct {
	mark     []byte
	encoding string
}{
	{[]byte{0xef, 0xbb, 0xbf}, encodingUTF8},
	{[]byte{0xfe, 0xff}, encodingUTF16BE},
	{[]byte{0xff, 0xfe}, encodingUTF16LE},
}

// DecodeRepresentation is data as the text it is, by the rule every reader of
// a resource's text keeps. contentType is the content type the bytes came
// with: the type, and the charset it states.
//
// Only a type whose bytes are its text is read. One whose text is derived
// from its bytes (a PDF) is refused, and so is one that has no text (an
// image), before its charset is read and whatever the bytes are: nothing
// that was never text is read as text. The refusal names the media type,
// without its parameters and in lower case. Where a type's text comes from,
// mediatypes.TextSourceOf says, so a text/ type the registry lacks is read.
//
// The rule is docs/protocol/W3C-SELECTORS.md's ("The text of a resource"):
// the MIME Sniffing Standard's reading of the content type and the Encoding
// Standard's reading of the bytes, as a browser follows the two. The charset
// is the one the content type states, UTF-8 when it states none, and is a
// label of the Encoding Standard: any other is refused, whatever the bytes
// are. Bytes that begin with the byte-order mark of UTF-8, UTF-16BE or
// UTF-16LE are in that encoding, whatever was stated, and the mark is not
// part of the text. What the encoding does not have is U+FFFD. A refusal
// names the charset: nothing is read as something it is not, and the bytes
// are there to read (Browse.ResourceRepresentation).
//
// This reader decodes every encoding of the standard: UTF-8, UTF-16BE and
// UTF-16LE itself, each single-byte one by its table, and the seven legacy
// multi-byte ones (Big5, EUC-JP, EUC-KR, gb18030, GBK, ISO-2022-JP,
// Shift_JIS) as golang.org/x/text does.
//
// Each refusal is a *TransportError whose code is TransportErrorCodeError.
func DecodeRepresentation(data []byte, contentType string) (string, error) {
	base := mediatypes.BaseMediaType(contentType)
	if mediatypes.DerivesTextOf(contentType) {
		return "", transportErrorWithoutResponse(fmt.Sprintf("The resource is %s, whose text is derived from its bytes, not decoded: read its anchored text instead", base), TransportErrorCodeError)
	}
	if mediatypes.TextSourceOf(contentType) == mediatypes.TextSourceNone {
		return "", transportErrorWithoutResponse(fmt.Sprintf("The resource is %s, which has no text: read its bytes instead", base), TransportErrorCodeError)
	}
	encoding, label, stated, err := statedEncoding(contentType)
	if err != nil {
		return "", err
	}
	for _, marked := range marks {
		if bytes.HasPrefix(data, marked.mark) {
			return decoded(data[len(marked.mark):], marked.encoding), nil
		}
	}
	if !stated {
		return decodeUTF8(data), nil
	}
	if text, ok := decodedBy(data, encoding); ok {
		return text, nil
	}
	panic(fmt.Sprintf("the label %s names %s, which no decoder here reads", label, encoding))
}

// decoded is data in one of the encodings a byte-order mark names.
func decoded(data []byte, encoding string) string {
	text, _ := decodedBy(data, encoding)
	return text
}

// legacyMultiByte is each of the standard's legacy multi-byte encodings, as
// the decoder the standard names for it: GBK's is gb18030's, and each other is
// the superset of what its name says that the standard reads (Big5-HKSCS,
// windows-949, windows-31j). encoding-cases.json holds every label of each.
var legacyMultiByte = map[string]encoding.Encoding{
	"big5":        traditionalchinese.Big5,
	"euc-jp":      japanese.EUCJP,
	"euc-kr":      korean.EUCKR,
	"gb18030":     simplifiedchinese.GB18030,
	"gbk":         simplifiedchinese.GB18030,
	"iso-2022-jp": japanese.ISO2022JP,
	"shift_jis":   japanese.ShiftJIS,
}

// decodedBy is data in encoding; false for an encoding this reader has no
// decoder for. What an encoding does not have is U+FFFD.
func decodedBy(data []byte, name string) (string, bool) {
	switch name {
	case encodingUTF8:
		return decodeUTF8(data), true
	case encodingUTF16BE:
		return decodeUTF16(data, false), true
	case encodingUTF16LE:
		return decodeUTF16(data, true), true
	}
	if legacy, ok := legacyMultiByte[name]; ok {
		text, err := legacy.NewDecoder().Bytes(data)
		if err != nil {
			panic(fmt.Sprintf("decoding %s failed, which its decoder does not do: %v", name, err))
		}
		return string(text), true
	}
	characters, ok := singleByte[name]
	if !ok {
		return "", false
	}
	var text strings.Builder
	for _, b := range data {
		text.WriteRune(characters[b])
	}
	return text.String(), true
}

// statedEncoding is the encoding a content type states, and the label it
// states it by; stated is false where it states none, or an empty one. The
// label is the Encoding Standard's: in lower case, without the white space
// around it. One the standard lacks is refused, and so is one of an encoding
// it reads no text under.
func statedEncoding(contentType string) (encoding, label string, stated bool, err error) {
	charset, ok := charsetOf(contentType)
	if !ok || charset == "" {
		return "", "", false, nil
	}
	label = asciiLower(strings.Trim(charset, asciiWhiteSpace))
	encoding, known := encodingOfLabel[label]
	if !known || slices.Contains(refusedEncodings, encoding) {
		return "", "", false, transportErrorWithoutResponse(fmt.Sprintf("The resource's text is %s, which is no charset the Encoding Standard decodes: read its bytes instead", charset), TransportErrorCodeError)
	}
	return encoding, label, true, nil
}

// asciiLower is text with A to Z in lower case and nothing else changed.
func asciiLower(text string) string {
	return strings.Map(func(character rune) rune {
		if character >= 'A' && character <= 'Z' {
			return character + ('a' - 'A')
		}
		return character
	}, text)
}

func isHTTPToken(text []rune) bool {
	if len(text) == 0 {
		return false
	}
	for _, character := range text {
		alphanumeric := character >= '0' && character <= '9' || character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z'
		if !alphanumeric && !strings.ContainsRune(httpTokenMarks, character) {
			return false
		}
	}
	return true
}

// isOfAParameterValue is whether a parameter's value may hold character: a
// tab, U+0020 to U+007E, and U+0080 to U+00FF.
func isOfAParameterValue(character rune) bool {
	return character == '\t' || character >= ' ' && character <= '~' || character >= 0x80 && character <= 0xff
}

func trimRight(text []rune, cut string) []rune {
	end := len(text)
	for end > 0 && strings.ContainsRune(cut, text[end-1]) {
		end--
	}
	return text[:end]
}

// quotedString is the quoted string that opens at start, without its
// quotation marks, and where it ends.
func quotedString(text []rune, start int) ([]rune, int) {
	position := start + 1
	var value []rune
	for {
		opened := position
		for position < len(text) && text[position] != '"' && text[position] != '\\' {
			position++
		}
		value = append(value, text[opened:position]...)
		if position >= len(text) {
			break
		}
		mark := text[position]
		position++
		if mark == '"' {
			break
		}
		// A backslash gives the character after it, and at the very end is itself.
		if position >= len(text) {
			value = append(value, '\\')
			break
		}
		value = append(value, text[position])
		position++
	}
	return value, position
}

// charsetOf is the value of a content type's charset parameter, as the MIME
// Sniffing Standard parses a MIME type: the first parameter of that name that
// is one. False where there is none, and where the content type is no MIME
// type.
func charsetOf(contentType string) (string, bool) {
	text := []rune(strings.Trim(contentType, httpWhiteSpace))
	slash := slices.Index(text, '/')
	if slash < 0 || !isHTTPToken(text[:slash]) {
		return "", false
	}
	rest := text[slash+1:]
	subtype := rest
	if semicolon := slices.Index(rest, ';'); semicolon >= 0 {
		subtype = rest[:semicolon]
	}
	if !isHTTPToken(trimRight(subtype, httpWhiteSpace)) {
		return "", false
	}
	position := slash + 1 + len(subtype)
	for position < len(text) {
		position++ // past the semicolon
		for position < len(text) && strings.ContainsRune(httpWhiteSpace, text[position]) {
			position++
		}
		opened := position
		for position < len(text) && text[position] != ';' && text[position] != '=' {
			position++
		}
		name := asciiLower(string(text[opened:position]))
		if position < len(text) {
			if text[position] == ';' {
				continue
			}
			position++ // past the equals sign
		}
		if position >= len(text) {
			break
		}
		var value []rune
		if text[position] == '"' {
			value, position = quotedString(text, position)
			for position < len(text) && text[position] != ';' {
				position++
			}
		} else {
			opened := position
			for position < len(text) && text[position] != ';' {
				position++
			}
			value = trimRight(text[opened:position], httpWhiteSpace)
			if len(value) == 0 {
				continue
			}
		}
		if name == "charset" && !slices.ContainsFunc(value, func(character rune) bool { return !isOfAParameterValue(character) }) {
			return string(value), true
		}
	}
	return "", false
}

// decodeUTF8 is data by the Encoding Standard's UTF-8 decoder: what is not
// UTF-8 is U+FFFD, one for each maximal part of a sequence that cannot be
// completed.
func decodeUTF8(data []byte) string {
	var text strings.Builder
	var codePoint rune
	seen, needed := 0, 0
	lower, upper := byte(0x80), byte(0xbf)
	for i := 0; i < len(data); i++ {
		b := data[i]
		if needed == 0 {
			switch {
			case b <= 0x7f:
				text.WriteByte(b)
			case b >= 0xc2 && b <= 0xdf:
				needed, codePoint = 1, rune(b&0x1f)
			case b >= 0xe0 && b <= 0xef:
				if b == 0xe0 {
					lower = 0xa0
				}
				if b == 0xed {
					upper = 0x9f
				}
				needed, codePoint = 2, rune(b&0x0f)
			case b >= 0xf0 && b <= 0xf4:
				if b == 0xf0 {
					lower = 0x90
				}
				if b == 0xf4 {
					upper = 0x8f
				}
				needed, codePoint = 3, rune(b&0x07)
			default:
				text.WriteRune(utf8.RuneError)
			}
			continue
		}
		if b < lower || b > upper {
			// The sequence is cut short: one U+FFFD, and this byte is read again.
			codePoint, seen, needed = 0, 0, 0
			lower, upper = 0x80, 0xbf
			text.WriteRune(utf8.RuneError)
			i--
			continue
		}
		lower, upper = 0x80, 0xbf
		codePoint = codePoint<<6 | rune(b&0x3f)
		seen++
		if seen == needed {
			text.WriteRune(codePoint)
			codePoint, seen, needed = 0, 0, 0
		}
	}
	if needed != 0 {
		text.WriteRune(utf8.RuneError)
	}
	return text.String()
}

// decodeUTF16 is data by the Encoding Standard's UTF-16 decoder, little end
// first when littleEnd: a surrogate with no partner is U+FFFD, and so is an
// odd last byte.
func decodeUTF16(data []byte, littleEnd bool) string {
	var text strings.Builder
	var leadByte, leadSurrogate int = -1, -1
	for _, b := range data {
		if leadByte < 0 {
			leadByte = int(b)
			continue
		}
		unit := leadByte<<8 | int(b)
		if littleEnd {
			unit = int(b)<<8 | leadByte
		}
		leadByte = -1
		if leadSurrogate >= 0 {
			lead := leadSurrogate
			leadSurrogate = -1
			if unit >= 0xdc00 && unit <= 0xdfff {
				text.WriteRune(rune(0x10000 + (lead-0xd800)<<10 + (unit - 0xdc00)))
				continue
			}
			// The unit after a lone leading surrogate is read as itself.
			text.WriteRune(utf8.RuneError)
		}
		switch {
		case unit >= 0xd800 && unit <= 0xdbff:
			leadSurrogate = unit
		case unit >= 0xdc00 && unit <= 0xdfff:
			text.WriteRune(utf8.RuneError)
		default:
			text.WriteRune(rune(unit))
		}
	}
	if leadByte >= 0 || leadSurrogate >= 0 {
		text.WriteRune(utf8.RuneError)
	}
	return text.String()
}
