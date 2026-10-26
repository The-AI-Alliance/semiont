package semiont

// Trying again: which failures are worth another attempt, and how long to keep
// at it.
//
// The two are separate questions. A RetryRule answers the first for one
// context, as specs/src/retry/cases.json states it. A RetryPolicy answers the
// second: a budget of attempts, and the backoff between them. The budgets a
// client keeps are specs/src/client/timing.json's (Timing).

import (
	"context"
	"math/rand/v2"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// RetryPolicy is a retry budget: how many attempts, and the backoff between
// them.
type RetryPolicy struct {
	// Attempts is how many times it is tried in all, the first included.
	Attempts int
	// InitialDelay is the wait before the second attempt; each later wait
	// doubles it.
	InitialDelay time.Duration
	// MaxDelay is the longest any wait grows to.
	MaxDelay time.Duration
}

// RetryFacts is what is known of a failure when someone asks whether to try
// again. What is not known is nil.
type RetryFacts struct {
	// Status is the response's status; nil when no response came.
	Status *int
	// Method is the request's method; nil when the context states none.
	Method *string
}

// RetryRule is which failures one context tries again.
type RetryRule struct {
	// Name is the rule's name in the table.
	Name      string
	retryable func(RetryFacts) bool
}

// Retryable reports whether a failure of these facts is worth another attempt
// under this rule.
func (r RetryRule) Retryable(facts RetryFacts) bool { return r.retryable(facts) }

func statusIn(facts RetryFacts, statuses ...int) bool {
	if facts.Status == nil {
		return false
	}
	for _, status := range statuses {
		if *facts.Status == status {
			return true
		}
	}
	return false
}

// RetryRuleBoot is a boot pass or a bus request, where the peer is usually
// seconds from ready: the statuses that say "up, but not now". A 500 is not
// among them: replaying it re-runs whatever broke it.
var RetryRuleBoot = RetryRule{Name: "boot", retryable: func(facts RetryFacts) bool {
	return statusIn(facts, 429, 503, 504)
}}

// Repeating these cannot cause a second effect upstream (RFC 9110 §9.2.2).
var idempotentMethods = map[string]bool{"GET": true, "HEAD": true, "PUT": true, "DELETE": true, "OPTIONS": true, "TRACE": true}

// RetryRuleTransport is an HTTP client's request. A retryable status applies
// only to a method that cannot cause a second effect, because a POST answered
// 502 may already have been processed. A 401 is not retried: a refused
// credential is renewed before any rule is asked, and the same token gets the
// same answer.
var RetryRuleTransport = RetryRule{Name: "transport", retryable: func(facts RetryFacts) bool {
	repeatable := facts.Method != nil && idempotentMethods[strings.ToUpper(*facts.Method)]
	return repeatable && statusIn(facts, 408, 413, 429, 500, 502, 503, 504)
}}

// RetryRuleRefresh is exchanging a refresh token at its issuer. The issuer's
// answer is the verdict and its absence never is: no response at all, or one
// saying "not now", is transient; a refused grant, and any fault this rule
// does not name, is terminal, because trying again only delays a sign-in the
// person must perform anyway.
var RetryRuleRefresh = RetryRule{Name: "refresh", retryable: func(facts RetryFacts) bool {
	return facts.Status == nil || statusIn(facts, 408, 429) || *facts.Status >= 500
}}

// RetryRules is every rule this SDK keeps, as the table names them.
func RetryRules() []RetryRule {
	return []RetryRule{RetryRuleBoot, RetryRuleRefresh, RetryRuleTransport}
}

var wholeSeconds = regexp.MustCompile(`^[0-9]+$`)

// RetryAfter is the wait a Retry-After header states, when it gives whole
// seconds, the form the gateway sends. An empty header, as a missing one reads,
// states none, and so does any other form; ok is then false.
func RetryAfter(header string) (wait time.Duration, ok bool) {
	stated := strings.TrimSpace(header)
	if !wholeSeconds.MatchString(stated) {
		return 0, false
	}
	seconds, err := strconv.ParseInt(stated, 10, 64)
	if err != nil {
		return 0, false
	}
	return time.Duration(seconds) * time.Second, true
}

// EqualJitter is half of the cap, and a random share of the other half.
//
// Callers that back off by one schedule against one gateway come back at the
// same instant and deliver again the burst that failed. The random half keeps
// them apart, and the wait never exceeds the cap.
func EqualJitter(cap time.Duration) time.Duration {
	half := cap / 2
	return half + time.Duration(rand.Int64N(int64(cap-half)+1))
}

// retryWithBackoff runs attempt until it succeeds, the policy's attempts are
// spent, or it fails in a way retryable does not accept. The wait before each
// further attempt is the policy's jittered backoff, and never less than the
// wait the failure itself stated (a refusal's Retry-After). A context that is
// done ends the wait in progress, and its error is returned; otherwise the
// last failure is returned as it was.
func retryWithBackoff[T any](
	ctx context.Context,
	policy RetryPolicy,
	attempt func(context.Context) (T, error),
	retryable func(error) bool,
	stated func(error) (time.Duration, bool),
) (T, error) {
	limit := policy.InitialDelay
	for made := 1; ; made++ {
		value, err := attempt(ctx)
		if err == nil || made >= policy.Attempts || ctx.Err() != nil || !retryable(err) {
			return value, err
		}
		wait := EqualJitter(limit)
		if floor, ok := stated(err); ok && floor > wait {
			wait = floor
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			var none T
			return none, ctx.Err()
		case <-timer.C:
		}
		limit = min(limit*2, policy.MaxDelay)
	}
}
