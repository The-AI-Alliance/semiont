// Code generated from specs/src/identifiers/kinds.json and each kind's schema — DO NOT EDIT.
//
// Regenerate: node scripts/spec/generate-identifiers-go.mjs
// The TypeScript and Python kinds are generated from the same table, and Rust's
// by its SDK's build script.

package api

import (
	"fmt"
	"regexp"
)

// InvalidIdentifierError is text that is not an id of the kind it was to be.
type InvalidIdentifierError struct {
	// Kind is the kind of id the text was to be, as its schema is named.
	Kind string
	// Pattern is the kind's rule, as its schema states it.
	Pattern string
	// Value is the text the rule refused.
	Value string
}

func (e *InvalidIdentifierError) Error() string {
	return fmt.Sprintf("%q is not a %s: it does not match %s", e.Value, e.Kind, e.Pattern)
}

// A resource's id: a name, never the resource's URI or a path. 1 to 128 of
// the letters `A`–`Z` and `a`–`z`, the digits, `_` and `-`. It is one segment
// of a URL and one name in a file system, and it is held to that wherever it
// enters: a gateway refuses a payload that carries anything else. How one is
// made is no part of the rule. `__system__` is the one that names no
// resource: the scope events about the knowledge base itself are logged
// under.
//
// It is made only by ParseResourceId, which holds text to the kind's rule, and
// by decoding, which goes through the same rule. Its zero value is no id: it
// is refused wherever an id is written, and IsZero names it.
type ResourceId struct{ text string }

const resourceIdPattern = "^[A-Za-z0-9_-]{1,128}$"

var resourceIdRule = regexp.MustCompile(resourceIdPattern)

// ParseResourceId is text as a ResourceId, or an *InvalidIdentifierError when the
// kind's rule refuses it.
func ParseResourceId(text string) (ResourceId, error) {
	if !resourceIdRule.MatchString(text) {
		return ResourceId{}, &InvalidIdentifierError{Kind: "ResourceId", Pattern: resourceIdPattern, Value: text}
	}
	return ResourceId{text: text}, nil
}

// String is the id's text.
func (id ResourceId) String() string { return id.text }

// IsZero reports whether id is the zero value, which is no id.
func (id ResourceId) IsZero() bool { return id.text == "" }

// MarshalText is the id's text. The zero value is refused, as the rule refuses
// empty text.
func (id ResourceId) MarshalText() ([]byte, error) {
	if id.text == "" {
		return nil, &InvalidIdentifierError{Kind: "ResourceId", Pattern: resourceIdPattern, Value: ""}
	}
	return []byte(id.text), nil
}

// UnmarshalText holds decoded text to the kind's rule.
func (id *ResourceId) UnmarshalText(text []byte) error {
	parsed, err := ParseResourceId(string(text))
	if err != nil {
		return err
	}
	*id = parsed
	return nil
}

// An annotation's id: a name, never the annotation's URI. 1 to 128 of the
// letters `A`–`Z` and `a`–`z`, the digits, `_` and `-`. It is one segment of
// a URL and one name in a file system, and it is held to that wherever it
// enters: a gateway refuses a payload that carries anything else. How one is
// made is no part of the rule.
//
// It is made only by ParseAnnotationId, which holds text to the kind's rule, and
// by decoding, which goes through the same rule. Its zero value is no id: it
// is refused wherever an id is written, and IsZero names it.
type AnnotationId struct{ text string }

const annotationIdPattern = "^[A-Za-z0-9_-]{1,128}$"

var annotationIdRule = regexp.MustCompile(annotationIdPattern)

// ParseAnnotationId is text as a AnnotationId, or an *InvalidIdentifierError when the
// kind's rule refuses it.
func ParseAnnotationId(text string) (AnnotationId, error) {
	if !annotationIdRule.MatchString(text) {
		return AnnotationId{}, &InvalidIdentifierError{Kind: "AnnotationId", Pattern: annotationIdPattern, Value: text}
	}
	return AnnotationId{text: text}, nil
}

// String is the id's text.
func (id AnnotationId) String() string { return id.text }

// IsZero reports whether id is the zero value, which is no id.
func (id AnnotationId) IsZero() bool { return id.text == "" }

// MarshalText is the id's text. The zero value is refused, as the rule refuses
// empty text.
func (id AnnotationId) MarshalText() ([]byte, error) {
	if id.text == "" {
		return nil, &InvalidIdentifierError{Kind: "AnnotationId", Pattern: annotationIdPattern, Value: ""}
	}
	return []byte(id.text), nil
}

// UnmarshalText holds decoded text to the kind's rule.
func (id *AnnotationId) UnmarshalText(text []byte) error {
	parsed, err := ParseAnnotationId(string(text))
	if err != nil {
		return err
	}
	*id = parsed
	return nil
}

// A job's id. 1 to 128 of the letters `A`–`Z` and `a`–`z`, the digits, `_`
// and `-`. It is one segment of a URL and one name in a file system, and it
// is held to that wherever it enters: a gateway refuses a payload that
// carries anything else. How one is made is no part of the rule.
//
// It is made only by ParseJobId, which holds text to the kind's rule, and
// by decoding, which goes through the same rule. Its zero value is no id: it
// is refused wherever an id is written, and IsZero names it.
type JobId struct{ text string }

const jobIdPattern = "^[A-Za-z0-9_-]{1,128}$"

var jobIdRule = regexp.MustCompile(jobIdPattern)

// ParseJobId is text as a JobId, or an *InvalidIdentifierError when the
// kind's rule refuses it.
func ParseJobId(text string) (JobId, error) {
	if !jobIdRule.MatchString(text) {
		return JobId{}, &InvalidIdentifierError{Kind: "JobId", Pattern: jobIdPattern, Value: text}
	}
	return JobId{text: text}, nil
}

// String is the id's text.
func (id JobId) String() string { return id.text }

// IsZero reports whether id is the zero value, which is no id.
func (id JobId) IsZero() bool { return id.text == "" }

// MarshalText is the id's text. The zero value is refused, as the rule refuses
// empty text.
func (id JobId) MarshalText() ([]byte, error) {
	if id.text == "" {
		return nil, &InvalidIdentifierError{Kind: "JobId", Pattern: jobIdPattern, Value: ""}
	}
	return []byte(id.text), nil
}

// UnmarshalText holds decoded text to the kind's rule.
func (id *JobId) UnmarshalText(text []byte) error {
	parsed, err := ParseJobId(string(text))
	if err != nil {
		return err
	}
	*id = parsed
	return nil
}

// The identity of whoever did something, a person or a software agent alike:
// a DID (`did:web:<domain>:users:<subject>`,
// `did:web:<domain>:agents:<subject>`), with no whitespace in it. Never a
// name, an address, or a row in a table. What follows `did:` is not
// constrained further: a subject is the issuer's, percent-encoded, and that
// encoding leaves some punctuation as it is.
//
// It is made only by ParseUserId, which holds text to the kind's rule, and
// by decoding, which goes through the same rule. Its zero value is no id: it
// is refused wherever an id is written, and IsZero names it.
type UserId struct{ text string }

const userIdPattern = "^did:\\S+$"

var userIdRule = regexp.MustCompile(userIdPattern)

// ParseUserId is text as a UserId, or an *InvalidIdentifierError when the
// kind's rule refuses it.
func ParseUserId(text string) (UserId, error) {
	if !userIdRule.MatchString(text) {
		return UserId{}, &InvalidIdentifierError{Kind: "UserId", Pattern: userIdPattern, Value: text}
	}
	return UserId{text: text}, nil
}

// String is the id's text.
func (id UserId) String() string { return id.text }

// IsZero reports whether id is the zero value, which is no id.
func (id UserId) IsZero() bool { return id.text == "" }

// MarshalText is the id's text. The zero value is refused, as the rule refuses
// empty text.
func (id UserId) MarshalText() ([]byte, error) {
	if id.text == "" {
		return nil, &InvalidIdentifierError{Kind: "UserId", Pattern: userIdPattern, Value: ""}
	}
	return []byte(id.text), nil
}

// UnmarshalText holds decoded text to the kind's rule.
func (id *UserId) UnmarshalText(text []byte) error {
	parsed, err := ParseUserId(string(text))
	if err != nil {
		return err
	}
	*id = parsed
	return nil
}
