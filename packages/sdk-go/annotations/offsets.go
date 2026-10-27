package annotations

// Where an offset into a text meets a Go string.
//
// A text offset, on the wire, in the record and in every store, counts
// Unicode code points from the start of the text: the W3C Web Annotation
// rule, and the same count in every language. A Go string is indexed in bytes
// of UTF-8, where a character is one to four. The two counts agree until the
// first character outside ASCII.
//
// So arithmetic is done on offsets, and a length is a difference of two of
// them: every count a rule states is of code points. A string's own index is
// only ever what a search of the string gave or what a slice of it takes,
// and is converted here. specs/src/text/offset-cases.json holds the count,
// for this and for every other implementation.

import "unicode/utf8"

// offsets is a text's offsets and its string's indices, each given the
// other: the conversions for one text, made once and asked as often as the
// text has offsets.
type offsets struct {
	text string
	// starts is the index each code point of the text starts at, in the
	// text's order, and after them the text's length in bytes: the index of
	// an offset.
	starts []int
}

func offsetsOf(text string) offsets {
	starts := make([]int, 0, len(text)+1)
	for index := range text {
		starts = append(starts, index)
	}
	return offsets{text: text, starts: append(starts, len(text))}
}

// length is how many code points the text is. An offset may equal it and
// may not exceed it.
func (o offsets) length() int { return len(o.starts) - 1 }

// index is the string's index of offset; false for an offset past the text.
func (o offsets) index(offset int) (int, bool) {
	if offset < 0 || offset > o.length() {
		return 0, false
	}
	return o.starts[offset], true
}

// offset is the offset of the string's index; false for an index that is
// not where a code point starts, or past the text.
func (o offsets) offset(index int) (int, bool) {
	low, high := 0, len(o.starts)
	for low < high {
		middle := (low + high) / 2
		switch {
		case o.starts[middle] < index:
			low = middle + 1
		case o.starts[middle] > index:
			high = middle
		default:
			return middle, true
		}
	}
	return 0, false
}

// between is the text from offset start up to offset end, two offsets of the
// text, the first no greater than the second.
func (o offsets) between(start, end int) string { return o.text[o.starts[start]:o.starts[end]] }

// at is the character at offset, an offset before the end of the text.
func (o offsets) at(offset int) rune {
	character, _ := utf8.DecodeRuneInString(o.text[o.starts[offset]:])
	return character
}
