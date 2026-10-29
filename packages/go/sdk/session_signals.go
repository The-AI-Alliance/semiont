package semiont

// What a host shows about a session, apart from the session: that it ended,
// that a request was refused for lack of permission, that a different
// knowledge base is answering at a registered address.
//
// A session is headless and raises none of these itself. A host that shows
// them builds one of these beside each live session and wires the session's
// failures into it. Each signal is one value: none (nil) while nothing is
// raised, the notice while something is. Raising it again is a new
// occurrence, told to every reader even when the notice equals the last.
//
// A signal says and decides nothing. By the time a session is said to have
// ended it has already cleared its token and what it kept.
//
// A notice says what happened, never a sentence: what a person reads is the
// host's to write, in their language.

// SessionEnded is a session that ended, and why.
type SessionEnded struct {
	Reason SessionEndReason `json:"reason"`
}

// PermissionDenied is a request refused for lack of permission. Detail is
// the refusal's own message, untranslated; nil when there is none.
type PermissionDenied struct {
	Detail *string `json:"detail"`
}

// KbIdentityConflict is what a registered entry said it was, and what
// answered. Both, because neither alone can be acted on: a person has to
// recognise which knowledge base they registered and which one is there now.
type KbIdentityConflict struct {
	ExpectedDid string `json:"expectedDid"`
	ObservedDid string `json:"observedDid"`
}

// SessionSignals is what a host shows about a session, as state: see the
// file's documentation.
type SessionSignals struct {
	sessionEnded       *Variable[*SessionEnded]
	permissionDenied   *Variable[*PermissionDenied]
	kbIdentityConflict *Variable[*KbIdentityConflict]
}

var _ StateUnit = (*SessionSignals)(nil)

// NewSessionSignals is signals with nothing raised.
func NewSessionSignals() *SessionSignals {
	return &SessionSignals{
		sessionEnded:       NewVariable[*SessionEnded](nil),
		permissionDenied:   NewVariable[*PermissionDenied](nil),
		kbIdentityConflict: NewVariable[*KbIdentityConflict](nil),
	}
}

// SessionEnded is the session's end: it expired, or its credential was
// refused.
func (s *SessionSignals) SessionEnded() Watched[*SessionEnded] { return s.sessionEnded.Reading() }

// PermissionDenied is a request refused for lack of permission.
func (s *SessionSignals) PermissionDenied() Watched[*PermissionDenied] {
	return s.permissionDenied.Reading()
}

// KbIdentityConflict is a different knowledge base answering at the entry's
// address.
func (s *SessionSignals) KbIdentityConflict() Watched[*KbIdentityConflict] {
	return s.kbIdentityConflict.Reading()
}

// NotifySessionEnded raises that the session ended, and why.
func (s *SessionSignals) NotifySessionEnded(reason SessionEndReason) {
	s.sessionEnded.Set(&SessionEnded{Reason: reason})
}

// NotifyPermissionDenied raises that a request was refused for lack of
// permission, with the refusal's own message; nil when it had none.
func (s *SessionSignals) NotifyPermissionDenied(detail *string) {
	s.permissionDenied.Set(&PermissionDenied{Detail: detail})
}

// NotifyKbIdentityConflict raises that a different knowledge base answers at
// the entry's address.
func (s *SessionSignals) NotifyKbIdentityConflict(conflict KbIdentityConflict) {
	s.kbIdentityConflict.Set(&conflict)
}

// AcknowledgeSessionEnded clears the session's end.
func (s *SessionSignals) AcknowledgeSessionEnded() { s.sessionEnded.Set(nil) }

// AcknowledgePermissionDenied clears the refusal.
func (s *SessionSignals) AcknowledgePermissionDenied() { s.permissionDenied.Set(nil) }

// AcknowledgeKbIdentityConflict clears the conflict.
func (s *SessionSignals) AcknowledgeKbIdentityConflict() { s.kbIdentityConflict.Set(nil) }

// Close ends every notice: each reader's changes end, and nothing is raised
// after. Closing twice is closing once.
func (s *SessionSignals) Close() {
	s.sessionEnded.End()
	s.permissionDenied.End()
	s.kbIdentityConflict.End()
}
