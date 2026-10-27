package annotations

// White space, as the case tables under specs/src count it: the characters
// Unicode gives the White_Space property, the twenty-five of
// unicode.White_Space.

import (
	"strings"
	"unicode"
)

func isWhiteSpace(character rune) bool { return unicode.Is(unicode.White_Space, character) }

// trimmed is text without the white space at its two ends.
func trimmed(text string) string { return strings.TrimFunc(text, isWhiteSpace) }

// collapsed is text with every run of white space made one space, and none
// at its two ends.
func collapsed(text string) string { return strings.Join(strings.FieldsFunc(text, isWhiteSpace), " ") }
