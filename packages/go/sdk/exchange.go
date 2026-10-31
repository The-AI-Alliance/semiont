package semiont

// A plain request to the gateway and its answer, as the content transport and
// the gateway's own operations make them: the transport's token, its retry
// rule and its error stream, so a request here is refused, renewed and
// reported as any other.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"sync/atomic"
	"time"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/internal/required"
)

// request is what one request is made of.
type request struct {
	method string
	path   string
	// authenticated is whether the request carries the client's token.
	authenticated bool
	// body makes the request's body afresh for each attempt; nil for none.
	body        func() (io.Reader, int64)
	contentType string
	// deadline bounds the wait for the answer to begin; zero waits for as
	// long as it takes, as an upload does.
	deadline time.Duration
}

// answered is a response whose answer has begun, and what lets its body be
// read with no deadline on it any longer. done releases what the request
// holds once the body has been read.
type answered struct {
	response *http.Response
	done     func()
}

// unanswered is a request the gateway did not answer by its deadline.
func unanswered(method, path string, deadline time.Duration) *TransportError {
	return transportErrorWithoutResponse(fmt.Sprintf("%s %s got no answer within %s", method, path, deadline), TransportErrorCodeUnavailable)
}

// exchange is one request and its answer. A request whose credential is
// refused is sent again once, at once, with a renewed token that is not the
// one refused, on any method; it is never retried. Any other request is made
// a second time when that is worth it and safe (RetryRuleTransport): a status
// that promises recovery, or no answer at all, on a method that cannot cause a
// second effect. A failure is reported on the error stream as it is returned;
// a request its caller abandoned reports nothing.
//
// An attempt whose answer has not begun by the deadline fails as one that got
// no answer, and is not made again: the gateway has the request, and may yet
// act on it.
func (s *transportShared) exchange(ctx context.Context, spec request) (answered, error) {
	unavailable := http.StatusServiceUnavailable
	repeatable := RetryRuleTransport.Retryable(RetryFacts{Status: &unavailable, Method: &spec.method})
	token := s.token.Value()
	retried, renewed := false, false
	for {
		attempt, cancel := context.WithCancel(ctx)
		var timedOut atomic.Bool
		var timer *time.Timer
		if spec.deadline > 0 {
			timer = time.AfterFunc(spec.deadline, func() {
				timedOut.Store(true)
				cancel()
			})
		}
		var body io.Reader
		var length int64
		if spec.body != nil {
			body, length = spec.body()
		}
		made, err := http.NewRequestWithContext(attempt, spec.method, s.baseURL+spec.path, body)
		if err != nil {
			cancel()
			return answered{}, s.failures.report(transportErrorWithoutResponse(fmt.Sprintf("%s %s cannot be asked: %v", spec.method, spec.path, err), TransportErrorCodeError))
		}
		if spec.body != nil {
			made.ContentLength = length
		}
		if spec.contentType != "" {
			made.Header.Set("Content-Type", spec.contentType)
		}
		if spec.authenticated && token != "" {
			made.Header.Set("Authorization", "Bearer "+token)
		}
		carryTrace(ctx, made.Header)
		response, err := s.http.Do(made)
		// The answer has begun, or there is none: the deadline is spent either
		// way, and must not cut a body being read.
		if timer != nil && !timer.Stop() && err == nil {
			// The deadline fired as the answer began; the context is
			// cancelled, so the answer cannot be read.
			response.Body.Close()
			err = context.DeadlineExceeded
		}
		if err != nil {
			cancel()
			switch {
			case ctx.Err() != nil:
				return answered{}, ctx.Err()
			case timedOut.Load():
				return answered{}, s.failures.report(unanswered(spec.method, spec.path, spec.deadline))
			case !retried && repeatable:
				retried = true
				if !pause(ctx, s.timing.RequestRetryPause) {
					return answered{}, ctx.Err()
				}
				continue
			}
			return answered{}, s.failures.report(transportErrorWithoutResponse(fmt.Sprintf("%s %s got no answer: %v", spec.method, spec.path, err), TransportErrorCodeUnavailable))
		}
		if response.StatusCode >= 200 && response.StatusCode <= 299 {
			return answered{response: response, done: func() { response.Body.Close(); cancel() }}, nil
		}
		said, _ := io.ReadAll(io.LimitReader(response.Body, 1<<16))
		response.Body.Close()
		cancel()
		wait, hasWait := RetryAfter(response.Header.Get("Retry-After"))
		refused := refusal(refusalMessage(response, said), response.StatusCode, wait, hasWait, said)
		if refused.Code == TransportErrorCodeUnauthorized {
			if !renewed {
				if fresh, ok := s.renewal(ctx, token); ok {
					token, renewed = fresh, true
					continue
				}
			}
		} else if status := response.StatusCode; !retried && RetryRuleTransport.Retryable(RetryFacts{Status: &status, Method: &spec.method}) {
			retried = true
			if !pause(ctx, max(s.timing.RequestRetryPause, wait)) {
				return answered{}, ctx.Err()
			}
			continue
		}
		if ctx.Err() != nil {
			return answered{}, ctx.Err()
		}
		return answered{}, s.failures.report(refused)
	}
}

// refusalMessage is what a refusal says: its body's error (an
// ErrorResponse), or its status and its reason, worded as the TypeScript
// transport words it.
func refusalMessage(response *http.Response, said []byte) string {
	var body struct {
		Error *string `json:"error"`
	}
	if json.Unmarshal(said, &body) == nil && body.Error != nil {
		return *body.Error
	}
	return fmt.Sprintf("HTTP %d: %s", response.StatusCode, http.StatusText(response.StatusCode))
}

// pause waits for wait; false when ctx is done first.
func pause(ctx context.Context, wait time.Duration) bool {
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// answer is exchange, its answer read as the JSON the operation answers, the
// reading bounded by the same deadline. An answer that is not that JSON, or
// lacks a member its schema requires, is refused.
func answer[T any](ctx context.Context, s *transportShared, spec request) (T, error) {
	var out T
	got, err := s.exchange(ctx, spec)
	if err != nil {
		return out, err
	}
	defer got.done()
	var read io.Reader = got.response.Body
	if spec.deadline > 0 {
		reading, cancel := context.WithTimeout(ctx, spec.deadline)
		defer cancel()
		read = readerWithContext(reading, got.response.Body)
	}
	raw, err := io.ReadAll(read)
	if err != nil {
		if ctx.Err() != nil {
			return out, ctx.Err()
		}
		return out, s.failures.report(unanswered(spec.method, spec.path, spec.deadline))
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		failure := &TransportError{Code: TransportErrorCodeError, Message: fmt.Sprintf("%s %s answered what is not its declared body: %v", spec.method, spec.path, err), status: got.response.StatusCode, hasStatus: true}
		return out, s.failures.report(failure)
	}
	if lacks, ok := required.Lacking(raw, reflect.TypeFor[T]()); ok {
		failure := &TransportError{Code: TransportErrorCodeError, Message: fmt.Sprintf("%s %s answered what is not its declared body: it has no `%s`", spec.method, spec.path, lacks), status: got.response.StatusCode, hasStatus: true}
		return out, s.failures.report(failure)
	}
	return out, nil
}

// readerWithContext reads r until ctx is done, then fails.
func readerWithContext(ctx context.Context, r io.ReadCloser) io.Reader {
	return &contextReader{ctx: ctx, r: r}
}

type contextReader struct {
	ctx context.Context
	r   io.ReadCloser
}

func (c *contextReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	stop := context.AfterFunc(c.ctx, func() { c.r.Close() })
	defer stop()
	n, err := c.r.Read(p)
	if err != nil && c.ctx.Err() != nil {
		return n, errors.Join(err, c.ctx.Err())
	}
	return n, err
}

// jsonBody is a body that is v, written as JSON.
func jsonBody(v any) (func() (io.Reader, int64), error) {
	encoded, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return func() (io.Reader, int64) { return bytes.NewReader(encoded), int64(len(encoded)) }, nil
}
