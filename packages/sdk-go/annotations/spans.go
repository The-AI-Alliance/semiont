package annotations

// A span of a text, and finding the one a model quoted.
//
// A model asked to mark a text quotes it, and nothing it says is trusted.
// Reconcile finds the quoted words in the text and answers a span that is the
// text's own, or nothing. The text is searched for the words character for
// character, and where it does not have them so, three looser ways in turn:
// without regard to white space and to the forms of quotation marks and
// dashes, without regard to letter case, and by edit distance within an
// allowance. specs/src/annotations/reconcile-cases.json holds the rule, for
// this and for every other SDK.

import (
	"strings"
	"unicode/utf8"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

// AnchorMethod is how a span was found: the text has the words once; it has
// them more than once and the model's hints chose; it has them more than once
// and nothing chose, so the first was taken; or it does not have them as
// quoted, and a looser search found them.
type AnchorMethod string

const (
	AnchorMethodUniqueMatch      AnchorMethod = "unique-match"
	AnchorMethodContextRecovered AnchorMethod = "context-recovered"
	AnchorMethodFirstOfMany      AnchorMethod = "first-of-many"
	AnchorMethodFuzzyMatch       AnchorMethod = "fuzzy-match"
)

// MatchQuality is which looser search found a span: without regard to white
// space and the forms of quotation marks and dashes, without regard to letter
// case, or by edits within the allowance.
type MatchQuality string

const (
	MatchQualityNormalized      MatchQuality = "normalized"
	MatchQualityCaseInsensitive MatchQuality = "case-insensitive"
	MatchQualityFuzzy           MatchQuality = "fuzzy"
)

// QuotedText is the words a model quoted from a text, and what it says stands
// beside them. Prefix and Suffix are hints of which place is meant, where the
// text has the words in more than one; one that is empty or only white space
// is none. Neither is kept: a span's context is the text's.
type QuotedText struct {
	Exact  string
	Prefix string
	Suffix string
}

// TextSpan is a span of a text: the code points from Start up to but not
// including End. Exact is the words there, and Prefix and Suffix what the text
// has just before and just after them; empty for none.
type TextSpan struct {
	Start  int
	End    int
	Exact  string
	Prefix string
	Suffix string
}

// ReconciledSpan is a span Reconcile found, which is the text's own, and how
// it was found. MatchQuality names the looser search when AnchorMethod is
// AnchorMethodFuzzyMatch, and is empty otherwise.
type ReconciledSpan struct {
	TextSpan
	AnchorMethod AnchorMethod
	MatchQuality MatchQuality
}

// place is a span of a text as its two offsets.
type place struct{ start, end int }

const (
	// contextLength is how many code points of the text a prefix or a suffix is.
	contextLength = 64
	// lengthenedByAtMost is how many more it may take to begin or end at a boundary.
	lengthenedByAtMost = 32
	// hintReach is the least number of code points beside a place that a hint is looked for in.
	hintReach = 32
	// allowedEditsOneIn is how many code points of the quote the loose search allows each edit for.
	allowedEditsOneIn = 20
)

// isBoundary is whether a context is not lengthened past character: white
// space, or one of eighteen marks.
func isBoundary(character rune) bool {
	return isWhiteSpace(character) || strings.ContainsRune(`.,;:!?'"()[]{}<>/\`, character)
}

// plainForms is the plain form of each quotation mark and dash that has one.
var plainForms = map[rune]string{'\u2018': "'", '\u2019': "'", '\u201c': `"`, '\u201d': `"`, '\u2014': "--", '\u2013': "-"}

// occurrences is the offset of every place the text has words, in the text's
// order. Places may overlap. A search of the string answers where a place
// starts in bytes, and each next search starts one character on.
func occurrences(text offsets, words string) []int {
	if words == "" {
		return nil
	}
	_, step := utf8.DecodeRuneInString(words)
	var found []int
	for from := 0; ; {
		at := strings.Index(text.text[from:], words)
		if at < 0 {
			return found
		}
		if offset, ok := text.offset(from + at); ok {
			found = append(found, offset)
		}
		from += at + step
	}
}

// placesOf is every place the text has words, character for character.
func placesOf(text offsets, words string) []place {
	length := utf8.RuneCountInString(words)
	var found []place
	for _, start := range occurrences(text, words) {
		found = append(found, place{start: start, end: start + length})
	}
	return found
}

// contextOf is the text just before a place and just after it: empty on a side
// where the text has nothing.
func contextOf(text offsets, at place) (prefix, suffix string) {
	if at.start > 0 {
		begins := max(0, at.start-contextLength)
		furthest := max(0, begins-lengthenedByAtMost)
		for begins > furthest && !isBoundary(text.at(begins-1)) {
			begins--
		}
		prefix = text.between(begins, at.start)
	}
	if at.end < text.length() {
		ends := min(text.length(), at.end+contextLength)
		furthest := min(text.length(), ends+lengthenedByAtMost)
		for ends < furthest && !isBoundary(text.at(ends)) {
			ends++
		}
		suffix = text.between(at.end, ends)
	}
	return prefix, suffix
}

// changed is a text changed for a comparison, and for each code point of the
// change the offset, in the text it was made from, of the character it came
// from.
type changed struct {
	text    string
	origins []int
}

// placesOf is every place the changed text has words, as the span of the text
// it was made from: from the character the place's first code point came from
// to just after the one its last came from. So a character that became
// several code points is in the span whole, and white space after a match is
// not.
func (c changed) placesOf(words string) []place {
	length := utf8.RuneCountInString(words)
	var found []place
	for _, at := range occurrences(offsetsOf(c.text), words) {
		found = append(found, place{start: c.origins[at], end: c.origins[at+length-1] + 1})
	}
	return found
}

// normalized is text with every run of white space made one space, counted
// from where the run began, and none at the two ends, and each quotation mark
// and dash in its plain form: an em dash is two hyphens, and both came from
// the dash.
func normalized(text string) changed {
	var written strings.Builder
	var origins []int
	runBegan := -1
	offset := 0
	for _, character := range text {
		if isWhiteSpace(character) {
			if runBegan < 0 {
				runBegan = offset
			}
			offset++
			continue
		}
		if runBegan >= 0 {
			if written.Len() > 0 {
				written.WriteByte(' ')
				origins = append(origins, runBegan)
			}
			runBegan = -1
		}
		plain, hasPlain := plainForms[character]
		if !hasPlain {
			plain = string(character)
		}
		written.WriteString(plain)
		for range utf8.RuneCountInString(plain) {
			origins = append(origins, offset)
		}
		offset++
	}
	return changed{text: written.String(), origins: origins}
}

// lowerCased is text lower-cased whole, by Unicode's rule of no language: a
// capital sigma that ends a word becomes the final one, which a character at
// a time would miss. A character becomes as many code points whole as alone
// (a capital I with a dot becomes two), and that is what the origins are
// counted from.
func lowerCased(text string) changed {
	lower := cases.Lower(language.Und)
	lowered := lower.String(text)
	var origins []int
	offset := 0
	for _, character := range text {
		for range utf8.RuneCountInString(lower.String(string(character))) {
			origins = append(origins, offset)
		}
		offset++
	}
	if utf8.RuneCountInString(lowered) != len(origins) {
		panic("a text lower-cased whole is not as long as its characters lower-cased one at a time")
	}
	return changed{text: lowered, origins: origins}
}

// distancesFrom is the edit distance from wanted to each stretch of text at
// start that is within allowance of it in length. The distance to the stretch
// of len(wanted) - allowance + n code points is at [n]; one past longest is
// beyond the allowance. False when no stretch from start is within the
// allowance.
//
// A distance is at least the difference of the two lengths. So of each row of
// the table of distances, only the stretches that near in length to what of
// wanted has been taken can be within the allowance, and only those are worked
// out. A distance beyond the allowance is held as one more than it, whatever
// it is.
func distancesFrom(wanted, text []rune, start, longest, allowance int) ([]int, bool) {
	beyond := allowance + 1
	// After `taken` code points of wanted, the stretch of `length` is at
	// [length - taken + allowance + 1]; the two ends stay beyond.
	width := 2*allowance + 3
	beyondAll := func() []int {
		row := make([]int, width)
		for at := range row {
			row[at] = beyond
		}
		return row
	}
	row := beyondAll()
	for length := 0; length <= min(allowance, longest); length++ {
		row[length+allowance+1] = length
	}
	for taken := 1; taken <= len(wanted); taken++ {
		above := row
		row = beyondAll()
		letter := wanted[taken-1]
		least := beyond
		for length := max(0, taken-allowance); length <= min(longest, taken+allowance); length++ {
			at := length - taken + allowance + 1
			distance := taken // against no text at all, every code point taken is one deleted
			if length > 0 {
				replaced := 1
				if letter == text[start+length-1] {
					replaced = 0
				}
				distance = min(above[at+1]+1, row[at-1]+1, above[at]+replaced, beyond)
			}
			row[at] = distance
			least = min(least, distance)
		}
		// The least distance of a row never falls as more of wanted is taken.
		if least > allowance {
			return nil, false
		}
	}
	return row[1 : width-1], true
}

// nearestStretch is the stretch of text at the least edit distance from exact,
// when that is within the allowance: a twentieth of exact's code points,
// rounded down, with no minimum. Of several stretches at the least distance it
// is the first in the text; of those that begin at one place, the nearest
// exact in length; and of two as near, the shorter.
func nearestStretch(text, exact []rune) (place, bool) {
	size := len(exact)
	allowance := size / allowedEditsOneIn
	// A stretch at no distance is exact itself, which the text was searched for before this.
	if allowance == 0 {
		return place{}, false
	}
	// From each start: the stretch as long as exact, then a code point shorter, a code point longer, and so on out.
	nearestInLengthFirst := []int{size}
	for away := 1; away <= allowance; away++ {
		nearestInLengthFirst = append(nearestInLengthFirst, size-away, size+away)
	}
	var nearest place
	least, found := 0, false
	for start := 0; start <= len(text)-(size-allowance); start++ {
		distances, within := distancesFrom(exact, text, start, min(size+allowance, len(text)-start), allowance)
		if !within {
			continue
		}
		for _, length := range nearestInLengthFirst {
			distance := distances[length-size+allowance]
			if distance <= allowance && (!found || distance < least) {
				nearest, least, found = place{start: start, end: start + length}, distance, true
			}
		}
	}
	return nearest, found
}

// looser is the places the first looser search that finds any finds, in the
// text's order, and which search it was. False when none finds the words.
func looser(text, exact string) ([]place, MatchQuality, bool) {
	if found := normalized(text).placesOf(normalized(exact).text); len(found) > 0 {
		return found, MatchQualityNormalized, true
	}
	if found := lowerCased(text).placesOf(cases.Lower(language.Und).String(exact)); len(found) > 0 {
		return found, MatchQualityCaseInsensitive, true
	}
	if nearest, found := nearestStretch([]rune(text), []rune(exact)); found {
		return []place{nearest}, MatchQualityFuzzy, true
	}
	return nil, "", false
}

// hint is what a model says stands beside the words when it is more than
// white space, a hint of where; empty for none.
func hint(given string) string {
	if trimmed(given) == "" {
		return ""
	}
	return given
}

// fits is whether the text around a place carries every hint given.
//
// A hint is looked for in as many code points beside the place as the hint
// has, and at least hintReach. It fits when the text there has it anywhere,
// the white space at the hint's own two ends removed. A hint the text meets
// the place with is one it has there, so the rule's other way to fit is this
// one too.
func fits(text offsets, at place, prefix, suffix string) bool {
	if prefix != "" {
		reach := max(hintReach, utf8.RuneCountInString(prefix))
		if !strings.Contains(text.between(max(0, at.start-reach), at.start), trimmed(prefix)) {
			return false
		}
	}
	if suffix != "" {
		reach := max(hintReach, utf8.RuneCountInString(suffix))
		if !strings.Contains(text.between(at.end, min(text.length(), at.end+reach)), trimmed(suffix)) {
			return false
		}
	}
	return true
}

// hinted is the first of several places that fits every hint given. False
// when no hint was given, and when no place fits.
func hinted(text offsets, found []place, prefix, suffix string) (place, bool) {
	if prefix == "" && suffix == "" {
		return place{}, false
	}
	for _, at := range found {
		if fits(text, at, prefix, suffix) {
			return at, true
		}
	}
	return place{}, false
}

// reconciled is a place as the span it is: its words and its context are the
// text's, never the model's spelling of them.
func reconciled(text offsets, at place, method AnchorMethod, quality MatchQuality) ReconciledSpan {
	prefix, suffix := contextOf(text, at)
	return ReconciledSpan{
		TextSpan:     TextSpan{Start: at.start, End: at.end, Exact: text.between(at.start, at.end), Prefix: prefix, Suffix: suffix},
		AnchorMethod: method,
		MatchQuality: quality,
	}
}

// Reconcile finds the words a model quoted in text.
//
// The span answered is the text's own: its Exact is the text between its
// offsets, and its Prefix and Suffix are what the text has on either side. Its
// TextSpan goes to AnnotationOfSpan as it is.
//
// False for a quote that is empty or only white space, and for words the text
// has nowhere, by any of the searches.
func Reconcile(text string, quoted QuotedText) (ReconciledSpan, bool) {
	if trimmed(quoted.Exact) == "" {
		return ReconciledSpan{}, false
	}
	prefix, suffix := hint(quoted.Prefix), hint(quoted.Suffix)
	counted := offsetsOf(text)

	found := placesOf(counted, quoted.Exact)
	switch {
	case len(found) == 1:
		return reconciled(counted, found[0], AnchorMethodUniqueMatch, ""), true
	case len(found) > 1:
		if chosen, ok := hinted(counted, found, prefix, suffix); ok {
			return reconciled(counted, chosen, AnchorMethodContextRecovered, ""), true
		}
		return reconciled(counted, found[0], AnchorMethodFirstOfMany, ""), true
	}

	found, quality, ok := looser(text, quoted.Exact)
	if !ok {
		return ReconciledSpan{}, false
	}
	chosen, ok := hinted(counted, found, prefix, suffix)
	if !ok {
		chosen = found[0]
	}
	return reconciled(counted, chosen, AnchorMethodFuzzyMatch, quality), true
}
