package semiont

// The failures the SDK reports, one type per vocabulary of
// specs/src/errors/codes.json, as the other SDKs have them: each a Go error,
// read with errors.As, and every one an Error.

import (
	"encoding/json"
	"time"
)

// Error is what every failure the SDK reports is: a code of one of the
// tables' vocabularies, and the status a server answered when one did.
type Error interface {
	error
	// ErrorCode is the failure's code, as its vocabulary spells it.
	ErrorCode() string
	// Status is the HTTP status a server answered; ok is false when none did.
	Status() (status int, ok bool)
}

// TransportError is a request the gateway refused, or one it never answered.
type TransportError struct {
	Code    TransportErrorCode
	Message string

	status        int
	hasStatus     bool
	retryAfter    time.Duration
	hasRetryAfter bool
}

var _ Error = (*TransportError)(nil)

func (e *TransportError) Error() string     { return e.Message }
func (e *TransportError) ErrorCode() string { return string(e.Code) }

// Status is the status the gateway answered; ok is false when it answered
// nothing.
func (e *TransportError) Status() (int, bool) { return e.status, e.hasStatus }

// RetryAfter is the wait the refusal stated; ok is false when it stated none.
func (e *TransportError) RetryAfter() (time.Duration, bool) { return e.retryAfter, e.hasRetryAfter }

// transportErrorOfStatus is a refusal, its code the one its status becomes.
func transportErrorOfStatus(message string, status int, retryAfter time.Duration, hasRetryAfter bool) *TransportError {
	return &TransportError{
		Code: TransportErrorCodeOfStatus(status), Message: message,
		status: status, hasStatus: true,
		retryAfter: retryAfter, hasRetryAfter: hasRetryAfter,
	}
}

// transportErrorWithoutResponse is a request no server answered.
func transportErrorWithoutResponse(message string, code TransportErrorCode) *TransportError {
	return &TransportError{Code: code, Message: message}
}

// BusRequestError is why a bus request did not resolve.
type BusRequestError struct {
	Code    BusRequestErrorCode
	Message string
	// Failure is the payload of the failure a peer answered with, when it
	// answered one; nil for a failure only this side knows.
	Failure json.RawMessage
}

var _ Error = (*BusRequestError)(nil)

func (e *BusRequestError) Error() string     { return e.Message }
func (e *BusRequestError) ErrorCode() string { return string(e.Code) }

// Status is never stated: a bus request's failure is a peer's, or this side's.
func (e *BusRequestError) Status() (int, bool) { return 0, false }

// SessionError is a failure that makes a session itself unusable. A request's
// own failure stays with its caller.
type SessionError struct {
	Code    SessionErrorCode
	Message string
	// KbID is the knowledge base the session was with.
	KbID string
}

var _ Error = (*SessionError)(nil)

func (e *SessionError) Error() string     { return e.Message }
func (e *SessionError) ErrorCode() string { return string(e.Code) }

// Status is never stated: a session's failure is the session's.
func (e *SessionError) Status() (int, bool) { return 0, false }

// SignInError is a sign-in at the issuer a knowledge base trusts, or a
// renewal there, that did not succeed. One that carries a status is the
// issuer's answer; one that carries none got no answer: a refusal and an
// outage are different events.
type SignInError struct {
	Code    SignInErrorCode
	Message string

	status    int
	hasStatus bool
}

var _ Error = (*SignInError)(nil)

func (e *SignInError) Error() string     { return e.Message }
func (e *SignInError) ErrorCode() string { return string(e.Code) }

// Status is the status the issuer answered; ok is false when it answered
// nothing.
func (e *SignInError) Status() (int, bool) { return e.status, e.hasStatus }

// signInRefused is the issuer's answer, a refusal with its status.
func signInRefused(code SignInErrorCode, message string, status int) *SignInError {
	return &SignInError{Code: code, Message: message, status: status, hasStatus: true}
}

// signInUnanswered is a sign-in step no issuer answered.
func signInUnanswered(code SignInErrorCode, message string) *SignInError {
	return &SignInError{Code: code, Message: message}
}
